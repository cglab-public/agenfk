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
import { TERMINAL_OPTIONS } from '../terminalOptions';

interface FakeTerm {
  opened: HTMLElement | null;
  written: string[];
  disposed: boolean;
  cols: number;
  rows: number;
  open: (el: HTMLElement) => void;
  /**
   * Takes the DONE callback, like the real one.
   *
   * The fake used to drop it, which made the ack path untestable — and the ack
   * path is what stops the pty when the terminal falls behind.
   */
  write: (d: string, done?: () => void) => void;
  dispose: () => void;
  /** xterm's own onData - the USER typing. Nothing to do with the bridge's
   *  session-scoped onData; a blanket rename once conflated the two. */
  onData: (cb: (d: string) => void) => { dispose: () => void };
  /** Write callbacks not yet fired, and a way to fire them. Real xterm parses
   *  asynchronously, so a test that wants the ack has to say when. */
  pendingWrites: Array<(() => void) | undefined>;
  drain: () => void;
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
  onActivity: ReturnType<typeof vi.fn>;
  ack: ReturnType<typeof vi.fn>;
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
    opened: null, written: [], disposed: false, cols: 80, rows: 24, pendingWrites: [],
    drain: () => { const q = term.pendingWrites.splice(0); q.forEach(done => done?.()); },
    open: el => { term.opened = el; },
    write: (d, done) => { term.written.push(d); term.pendingWrites.push(done); },
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
    // spawn returns BOTH ids now: the pty handle and the agent's conversation
    // id. They are different things, and a bare string was ambiguous enough
    // that a handle could be sent to `--resume`.
    spawn: vi.fn(async () => ({ sessionId: 'sess-1', agentSessionId: undefined })),
    write: vi.fn(async () => true),
    resize: vi.fn(async () => true),
    kill: vi.fn(async () => true),
    // Present in the fake because the pane's routing is now asserted on it;
    // it is optional on the real bridge and the pane still guards for that.
    onActivity: vi.fn(() => () => {}),
    ack: vi.fn(async () => true),
    onData: vi.fn((_sessionId: string, cb: (e: { sessionId: string; data: string }) => void) => {
      dataSubscribers.push(cb);
      return () => { unsubscribes += 1; };
    }),
    onExit: vi.fn((_sessionId: string, cb: (e: { sessionId: string; exitCode: number }) => void) => {
      exitSubscribers.push(cb);
      return () => { unsubscribes += 1; };
    }),
  };
});
afterEach(() => cleanup());

const renderPane = (props: Partial<React.ComponentProps<typeof TerminalPane>> = {}) =>
  render(<TerminalPane itemId="i1" agentId="claude-code" {...deps()} {...props} />);

describe('opening a terminal for a card', () => {
  it('asks the main process for a session for THIS card and agent', async () => {
    renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    const req = bridge.spawn.mock.calls[0][0];
    expect(req.itemId).toBe('i1');
    expect(req.agentId).toBe('claude-code');
  });

  it('never sends a directory or a command', async () => {
    // The renderer has no business naming either. If it ever did, the closed
    // list and the worktree resolution in the main process would be decoration.
    renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    const req = bridge.spawn.mock.calls[0][0];
    expect(Object.keys(req).sort()).toEqual(['agentId', 'autoApprove', 'cols', 'itemId', 'persist', 'rows']);
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
        <TerminalPane itemId="i1" agentId="claude-code" {...deps()} />
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

/**
 * Telling the shell that this terminal is alive.
 *
 * Liveness used to be fed only by `run:event` from the socket, which comes
 * from the Claude Code hook — and a terminal opened here creates a PTY and no
 * run at all. So the sessions rail showed our own terminals as idle forever,
 * and because it renders STOP only for running or waiting, the single state
 * they could reach was the one with no controls.
 *
 * Output is the honest signal available without inventing a protocol: bytes
 * arriving means the agent is doing something.
 */
describe('reporting that output arrived', () => {
  it('tells the shell when data arrives for this session', async () => {
    const onOutput = vi.fn();
    renderPane({ onOutput });
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    await waitFor(() => expect(dataSubscribers.length).toBeGreaterThan(0));
    dataSubscribers[0]({ sessionId: 'sess-1', data: 'thinking' });
    expect(onOutput).toHaveBeenCalled();
  });

  it('ignores output belonging to another session', async () => {
    // Every pane listens on one channel, so without the filter one card's
    // output would light up every other card in the rail.
    const onOutput = vi.fn();
    renderPane({ onOutput });
    await waitFor(() => expect(dataSubscribers.length).toBeGreaterThan(0));
    dataSubscribers[0]({ sessionId: 'someone-else', data: 'thinking' });
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('reports at most once in a burst', async () => {
    // Output arrives in many small chunks and every report wakes the shell to
    // recompute the rail — the cost the rail's single-timer design exists to
    // avoid.
    const onOutput = vi.fn();
    renderPane({ onOutput });
    await waitFor(() => expect(dataSubscribers.length).toBeGreaterThan(0));
    for (let i = 0; i < 20; i += 1) dataSubscribers[0]({ sessionId: 'sess-1', data: `chunk ${i}` });
    expect(onOutput).toHaveBeenCalledTimes(1);
  });
});

/**
 * Telling main what has actually been drawn (flow control).
 *
 * The return half of the backpressure in flowControl.ts. Main stops reading
 * from the pty when too much output is in flight and undrawn; these acks are
 * the only thing that ever tells it the terminal caught up.
 *
 * It is worth testing precisely because it fails QUIETLY. If the ack stops
 * being sent, nothing breaks visibly — main's grace period force-resumes the
 * session after ten seconds and the terminal keeps working. Flow control would
 * simply be off, and the 50 MB ceiling would be back with no symptom until a
 * window froze.
 */
describe('acking drawn output', () => {
  it('reports only once xterm says it parsed the chunk', async () => {
    /*
     * The distinction the whole design rests on. `write()` RETURNING means the
     * bytes were queued, and that queue is exactly what was growing unbounded.
     * Only the callback means they were parsed, so acking on the call instead
     * of the callback would report a terminal as keeping up while it fell
     * further behind — flow control that measures the wrong thing.
     *
     * The first version of this test could not tell those apart. It asserted
     * "not yet" synchronously, and the flush is a microtask, so acking on the
     * call rather than the callback passed it just as happily. The assertion
     * has to wait long enough for a wrongly-placed ack to have arrived.
     */
    renderPane({});
    await waitFor(() => expect(dataSubscribers.length).toBeGreaterThan(0));
    dataSubscribers[0]({ sessionId: 'sess-1', data: 'hello' });

    // Past the microtask queue and one macrotask. An ack computed at call time
    // would be here by now; one waiting on xterm cannot be.
    await new Promise(r => setTimeout(r, 0));
    expect(bridge.ack).not.toHaveBeenCalled();
    expect(terms[0].pendingWrites).toHaveLength(1);

    terms[0].drain();
    await waitFor(() => expect(bridge.ack).toHaveBeenCalledWith('sess-1', 5));
  });

  it('sends one message for a burst, not one per chunk', async () => {
    // Output arrives in thousands of small reads. An IPC round trip each would
    // cost more than the problem being solved, so bytes accumulate and flush
    // together.
    renderPane({});
    await waitFor(() => expect(dataSubscribers.length).toBeGreaterThan(0));
    for (let i = 0; i < 50; i += 1) dataSubscribers[0]({ sessionId: 'sess-1', data: '0123456789' });
    terms[0].drain();
    await waitFor(() => expect(bridge.ack).toHaveBeenCalledTimes(1));
    expect(bridge.ack).toHaveBeenCalledWith('sess-1', 500);
  });

  it('counts in the same unit main counts in', async () => {
    // Main adds `data.length` of the string it forwarded; this subtracts the
    // length of the same string. The two only have to AGREE — a more accurate
    // byte count on one side alone would be worse than a crude one on both.
    renderPane({});
    await waitFor(() => expect(dataSubscribers.length).toBeGreaterThan(0));
    dataSubscribers[0]({ sessionId: 'sess-1', data: 'héllo ✳' });
    terms[0].drain();
    await waitFor(() => expect(bridge.ack).toHaveBeenCalledWith('sess-1', 'héllo ✳'.length));
  });

  it('does not ack another card\'s output', async () => {
    // The filter runs before the write, so a chunk for a different session is
    // never drawn here and must never be counted against this one either.
    renderPane({});
    await waitFor(() => expect(dataSubscribers.length).toBeGreaterThan(0));
    dataSubscribers[0]({ sessionId: 'someone-else', data: 'not mine' });
    terms[0].drain();
    await new Promise(r => setTimeout(r, 0));
    expect(bridge.ack).not.toHaveBeenCalled();
  });

  it('works against a preload that has no ack at all', async () => {
    /*
     * Version skew is real here: the renderer bundle and the preload ship
     * together but a stale install can pair an old preload with a new bundle.
     * Throwing would leave a BLANK TERMINAL, which is far worse than running
     * without backpressure.
     */
    (bridge as unknown as Record<string, unknown>).ack = undefined;
    renderPane({});
    await waitFor(() => expect(dataSubscribers.length).toBeGreaterThan(0));
    dataSubscribers[0]({ sessionId: 'sess-1', data: 'hello' });
    expect(() => terms[0].drain()).not.toThrow();
    expect(terms[0].written).toContain('hello');
  });
});

/**
 * That the pane actually USES the shared options (review follow-up).
 *
 * `terminalOptions.test.ts` asserts the constant against itself, which pins the
 * value and not its use. Reverting this pane to the old inline
 * `new XTerm({ convertEol, fontSize, cursorBlink })` left all 986 UI tests
 * green — the same regression the commit set out to prevent, one step further
 * along: the scrollback would be nobody's decision again, and no test would
 * say so.
 *
 * The real constructor is never exercised here because these tests always
 * inject `createTerminal`, so the assertion has to be on what the pane passes
 * to that factory.
 */
describe('the options the pane builds its terminal with', () => {
  it('passes the shared options object through', async () => {
    const seen: unknown[] = [];
    render(
      <TerminalPane
        itemId="i1"
        agentId="claude-code"
        createTerminal={((opts: unknown) => { seen.push(opts); return makeTerm() as never; }) as never}
        createFitAddon={() => ({ fit: () => {}, dispose: () => {} }) as never}
        bridge={bridge as never}
      />,
    );
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBe(TERMINAL_OPTIONS);
  });

  it('carries a scrollback, which is the whole point of the module', () => {
    // Stated here as well as in terminalOptions.test.ts, because this is the
    // side that proves it reaches a terminal rather than merely existing.
    expect((TERMINAL_OPTIONS as { scrollback?: number }).scrollback).toBeGreaterThan(0);
  });
});

/**
 * WHICH session the pane subscribes with (review follow-up).
 *
 * Routing became this design's load-bearing invariant and was the one thing
 * nothing checked. Every fake discarded the key — `_sessionId` in all of them
 * — and `bridge.onData` never appeared inside an expectation.
 *
 * The reviewer's scenario: change the subscribe call to `result.agentSessionId`
 * instead of `result.sessionId`. Both are strings, both come back from the same
 * spawn, and the registry has a comment explaining that people confuse them.
 * tsc green, the whole UI suite green — and in production every terminal is
 * permanently blank with no exit banner and no error.
 */
describe('the session id it routes on', () => {
  const spawnedIds = { sessionId: 'pty-handle-1', agentSessionId: 'conversation-9' };

  const renderWithIds = () => {
    bridge.spawn = vi.fn(async () => spawnedIds);
    renderPane({});
  };

  it('subscribes for output with the PTY handle, not the conversation id', async () => {
    /*
     * The two are different kinds of thing and the registry says so: one
     * addresses a live process and dies with it, the other addresses a
     * CONVERSATION and is the reason a restored terminal is worth anything.
     */
    renderWithIds();
    await waitFor(() => expect(bridge.onData).toHaveBeenCalled());
    expect(bridge.onData.mock.calls[0][0]).toBe('pty-handle-1');
  });

  it('subscribes for the exit with the same id', async () => {
    // A tab that never hears its exit shows no banner and waits forever.
    renderWithIds();
    await waitFor(() => expect(bridge.onExit).toHaveBeenCalled());
    expect(bridge.onExit.mock.calls[0][0]).toBe('pty-handle-1');
  });

  it('subscribes for activity with the same id', async () => {
    renderWithIds();
    await waitFor(() => expect(bridge.onActivity).toHaveBeenCalled());
    expect(bridge.onActivity.mock.calls[0][0]).toBe('pty-handle-1');
  });

  it('never routes on the conversation id', async () => {
    // Stated as its own assertion because it is the specific mistake that
    // would otherwise pass every test in this file.
    renderWithIds();
    await waitFor(() => expect(bridge.onData).toHaveBeenCalled());
    const keys = [bridge.onData, bridge.onExit, bridge.onActivity]
      .flatMap(fn => fn.mock.calls.map((c: unknown[]) => c[0]));
    expect(keys).not.toContain('conversation-9');
  });
});


/*
 * The size the pty is actually told.
 *
 * The pane spawns with whatever `fit()` could measure before the pane had been
 * laid out — often the 80×24 fallback. The RIGHT measurement arrives almost
 * immediately, because ResizeObserver fires as soon as it observes; but that
 * is before the spawn promise resolves, and the resize is dropped when there
 * is no session yet. So the correct number was computed and thrown away, and
 * nothing measured again until somebody dragged a split.
 *
 * What the person sees: the agent draws into a 24-row terminal while the view
 * shows fifty, so its input box sits in the middle of the pane with a black
 * rectangle underneath — "I can read the agent, I cannot see where to type".
 */
describe('the size the session is told', () => {
  it('sends the real geometry once the session exists', async () => {
    /*
     * FAKE TIMERS, deliberately. The debounce has a trailing edge, and in real
     * time that edge fires while a test is still awaiting — so this passed
     * with the defect present, which is the only thing worse than failing.
     * A real spawn (worktree lookup, HTTP, git) takes far longer than 60ms, so
     * both edges land before the session exists and both are dropped.
     */
    vi.useFakeTimers();
    try {
      let resolveSpawn: (v: { sessionId: string; agentSessionId?: string }) => void = () => {};
      bridge.spawn = vi.fn(() => new Promise(r => { resolveSpawn = r; }));

      renderPane();
      await act(async () => {});
      expect(bridge.spawn).toHaveBeenCalled();

      // Measured while the spawn is still in flight, which is what actually
      // happens: ResizeObserver fires as soon as it observes.
      terms[0].cols = 143;
      terms[0].rows = 46;
      act(() => { fireResize(); });
      // Both edges of the debounce, spent with no session to tell.
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(bridge.resize).not.toHaveBeenCalled();

      await act(async () => { resolveSpawn({ sessionId: 'sess-1', agentSessionId: undefined }); });
      expect(bridge.resize).toHaveBeenCalledWith('sess-1', 143, 46);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not tell a session that was torn down while spawning', async () => {
    // The pane is gone and the shell is being killed; a resize on the way out
    // is noise at best.
    let resolveSpawn: (v: { sessionId: string; agentSessionId?: string }) => void = () => {};
    bridge.spawn = vi.fn(() => new Promise(r => { resolveSpawn = r; }));
    const { unmount } = renderPane();
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalled());
    unmount();
    await act(async () => { resolveSpawn({ sessionId: 'sess-1', agentSessionId: undefined }); });
    expect(bridge.resize).not.toHaveBeenCalled();
  });
});
