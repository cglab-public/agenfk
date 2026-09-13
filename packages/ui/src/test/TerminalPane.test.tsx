/**
 * @vitest-environment jsdom
 *
 * CGLAB-169: the terminal tab.
 *
 * xterm is a real canvas/DOM renderer and does not run meaningfully under
 * jsdom, so it is injected. What is worth testing here is not "does xterm
 * draw" — it is the lifecycle around it, which is where the defects live:
 *
 *  - a tab that unmounts must stop listening and kill its session, or every
 *    closed tab leaves a shell attached to a worktree and a listener leaking
 *    output into a component that no longer exists;
 *  - output must reach only the session it belongs to, because several
 *    terminals are open at once and they are all listening on one channel;
 *  - resizing must reach the PTY, or the program inside keeps the old
 *    dimensions and draws over itself.
 */
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { TerminalPane } from '../components/TerminalPane';

interface FakeTerm {
  opened: HTMLElement | null;
  written: string[];
  disposed: boolean;
  cols: number;
  rows: number;
  open: (el: HTMLElement) => void;
  write: (d: string) => void;
  dispose: () => void;
  onData: (cb: (d: string) => void) => { dispose: () => void };
  loadAddon: (a: unknown) => void;
  emitInput?: (d: string) => void;
}

let terms: FakeTerm[];
let fitCalls: number;
let bridge: {
  spawn: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
};
let dataSubscribers: Array<(e: { sessionId: string; data: string }) => void>;
let exitSubscribers: Array<(e: { sessionId: string; exitCode: number }) => void>;
let unsubscribes: number;
let observedTargets: Element[];
let disconnects: number;
let roCallbacks: Array<() => void>;

/** Drive every live ResizeObserver as though the pane had changed size. */
const fireResize = (): void => { roCallbacks.forEach(cb => cb()); };

const makeTerm = (): FakeTerm => {
  let inputCb: (d: string) => void = () => {};
  const term: FakeTerm = {
    opened: null, written: [], disposed: false, cols: 80, rows: 24,
    open: el => { term.opened = el; },
    write: d => { term.written.push(d); },
    dispose: () => { term.disposed = true; },
    onData: cb => { inputCb = cb; return { dispose: () => {} }; },
    loadAddon: () => {},
  };
  term.emitInput = d => inputCb(d);
  terms.push(term);
  return term;
};

const deps = () => ({
  createTerminal: () => makeTerm() as never,
  createFitAddon: () => ({ fit: () => { fitCalls += 1; }, dispose: () => {} }) as never,
  bridge: bridge as never,
});

beforeEach(() => {
  observedTargets = [];
  disconnects = 0;
  roCallbacks = [];
  // jsdom has no ResizeObserver at all, so without this the component cannot
  // even mount — which is itself worth knowing.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private readonly cb: () => void) { roCallbacks.push(() => this.cb()); }
    observe(el: Element) { observedTargets.push(el); }
    unobserve() {}
    disconnect() { disconnects += 1; }
  };
  terms = [];
  fitCalls = 0;
  dataSubscribers = [];
  exitSubscribers = [];
  unsubscribes = 0;
  bridge = {
    spawn: vi.fn(async () => 'sess-1'),
    write: vi.fn(async () => true),
    resize: vi.fn(async () => true),
    kill: vi.fn(async () => true),
    onData: vi.fn((cb: (e: { sessionId: string; data: string }) => void) => {
      dataSubscribers.push(cb);
      return () => { unsubscribes += 1; };
    }),
    onExit: vi.fn((cb: (e: { sessionId: string; exitCode: number }) => void) => {
      exitSubscribers.push(cb);
      return () => { unsubscribes += 1; };
    }),
  };
});
afterEach(() => cleanup());

const renderPane = (props: Partial<React.ComponentProps<typeof TerminalPane>> = {}) =>
  render(<TerminalPane itemId="i1" agentId="claude" {...deps()} {...props} />);

describe('opening a terminal for a card', () => {
  it('asks the main process for a session for THIS card and agent', async () => {
    renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    const req = bridge.spawn.mock.calls[0][0];
    expect(req.itemId).toBe('i1');
    expect(req.agentId).toBe('claude');
  });

  it('never sends a directory or a command', async () => {
    // The renderer has no business naming either. If it ever did, the closed
    // list and the worktree resolution in the main process would be decoration.
    renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    const req = bridge.spawn.mock.calls[0][0];
    expect(Object.keys(req).sort()).toEqual(['agentId', 'autoApprove', 'cols', 'itemId', 'rows']);
  });

  it('leaves exactly one live shell under StrictMode double-mount', async () => {
    // React 19 StrictMode mounts, unmounts and remounts effects in dev, so the
    // effect genuinely runs twice and a spawn per mount is not avoidable from
    // inside the component. What IS avoidable — and what actually costs the
    // user — is the discarded mount's shell staying attached to the worktree
    // as a process nobody can see. The guarantee is therefore about survivors,
    // not about call counts.
    let spawnCount = 0;
    bridge.spawn = vi.fn(async () => { spawnCount += 1; return `sess-${spawnCount}`; });
    render(
      <React.StrictMode>
        <TerminalPane itemId="i1" agentId="claude" {...deps()} />
      </React.StrictMode>,
    );
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    await waitFor(() => expect(spawnCount - bridge.kill.mock.calls.length).toBe(1));
  });

  it('shows the failure instead of an empty black rectangle', async () => {
    // resolveWorktree throws rather than falling back, and that message names
    // what to fix. Swallowing it leaves a terminal that looks hung.
    bridge.spawn = vi.fn(async () => { throw new Error('project has no project root'); });
    renderPane();
    expect(await screen.findByText(/project has no project root/i)).toBeDefined();
  });
});

describe('output goes to the right terminal', () => {
  it('writes data addressed to its own session', async () => {
    renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    act(() => { dataSubscribers.forEach(cb => cb({ sessionId: 'sess-1', data: 'hello' })); });
    expect(terms[0].written).toContain('hello');
  });

  it('ignores data addressed to another session', async () => {
    // Several terminals are open at once and every one of them is listening on
    // the same channel. Without the filter each tab prints every other tab's
    // output.
    renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    act(() => { dataSubscribers.forEach(cb => cb({ sessionId: 'someone-else', data: 'not mine' })); });
    expect(terms[0].written).not.toContain('not mine');
  });

  it('sends what the user types to its own session', async () => {
    renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    act(() => { terms[0].emitInput!('ls\n'); });
    expect(bridge.write).toHaveBeenCalledWith('sess-1', 'ls\n');
  });

  it('says so when the session ends, instead of going quiet', async () => {
    renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    act(() => { exitSubscribers.forEach(cb => cb({ sessionId: 'sess-1', exitCode: 0 })); });
    expect(await screen.findByText(/exited/i)).toBeDefined();
  });
});

describe('closing a tab leaves nothing behind', () => {
  it('kills the session', async () => {
    const view = renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    view.unmount();
    await waitFor(() => expect(bridge.kill).toHaveBeenCalledWith('sess-1'));
  });

  it('unsubscribes from both channels', async () => {
    // A listener on a dead component keeps the closure — and the terminal —
    // alive, and React warns about setState after unmount.
    const view = renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    view.unmount();
    expect(unsubscribes).toBeGreaterThanOrEqual(2);
  });

  it('disposes the xterm instance', async () => {
    // xterm attaches its own listeners and observers; dropping the DOM node is
    // not enough.
    const view = renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    view.unmount();
    expect(terms[0].disposed).toBe(true);
  });
});

describe('resizing', () => {
  it('watches the PANE, not the window', async () => {
    // The window is the wrong thing to observe. Dragging a split or collapsing
    // the sidebar changes the pane without changing the window, so no resize
    // event fires and the program inside keeps drawing against stale
    // dimensions. Worse, while the tab is hidden `fit()` is a no-op — it reads
    // a computed width of `auto`, gets NaN and bails — and nothing re-fits on
    // return, so the terminal stays wrong-sized until the user happens to
    // resize the window with it visible.
    renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    expect(observedTargets.length, 'nothing is observing the pane element').toBeGreaterThan(0);
    expect(observedTargets[0].getAttribute('data-testid')).toBe('terminal-host');
  });

  it('tells the PTY the new size, or the program draws over itself', async () => {
    renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    act(() => { fireResize(); });
    await waitFor(() => expect(bridge.resize).toHaveBeenCalled());
    expect(bridge.resize.mock.calls.at(-1)?.[0]).toBe('sess-1');
  });

  it('resizes immediately on the first event of a drag, not only at the end', async () => {
    // A trailing-only debounce leaves the child drawing against stale
    // dimensions for the whole drag, and that overlapping output is baked
    // permanently into the scrollback — it cannot be repaired by a later
    // correct resize.
    renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    bridge.resize.mockClear();
    act(() => { fireResize(); });
    expect(bridge.resize).toHaveBeenCalled();
  });

  it('does not fire once per pixel during a drag', async () => {
    renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    bridge.resize.mockClear();
    act(() => { for (let i = 0; i < 20; i += 1) fireResize(); });
    expect(bridge.resize.mock.calls.length).toBeLessThan(5);
  });

  it('stops observing after unmount', async () => {
    const view = renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    view.unmount();
    expect(disconnects).toBeGreaterThan(0);
  });
});
