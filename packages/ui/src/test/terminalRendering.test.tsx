/**
 * @vitest-environment jsdom
 *
 * INFRA-425: how a terminal draws.
 *
 * The same herdr that is sharp in Windows Terminal looked pixelated inside an
 * AgEnFK terminal, and two of the reasons were in this package:
 *
 *   - no `fontFamily`, so xterm fell back to its default stack: DejaVu Sans
 *     Mono on Linux, Courier New on Windows, although JetBrains Mono is
 *     already bundled (@fontsource-variable/jetbrains-mono);
 *   - the DOM renderer, because only addon-fit was installed, which draws box
 *     drawing — herdr's whole frame — as font glyphs with seams.
 *
 * So the terminal asks for the bundled font, measures again once it has
 * loaded, and draws through WebGL where WebGL starts at full speed and while
 * the pane is on screen. A renderer that cannot run must never cost the person
 * their terminal, nor leak it (see webglRenderer.ts).
 */
import { render, cleanup, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import type { ITerminalAddon, ITerminalOptions, Terminal } from '@xterm/xterm';
import { TERMINAL_OPTIONS, terminalOptionsFor } from '../terminalOptions';
import { TerminalPane } from '../components/TerminalPane';
import {
  __resetWebgl, LIVE_LIMIT, webglUsable, acquireWebglSlot, releaseWebglSlot, loseContexts, type WebglHolder,
} from '../webglRenderer';
import { __resetTerminalFaces } from '../terminalFont';

const constructed = vi.hoisted(() => ({ count: 0 }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() { constructed.count += 1; }
    activate() {}
    dispose() {}
    onContextLoss() { return { dispose: () => {} }; }
  },
}));

type Doc = { fonts?: unknown };
const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
const originalRects = HTMLElement.prototype.getClientRects;
const OriginalResizeObserver = globalThis.ResizeObserver;
let observed: Array<() => void>;

/** jsdom lays nothing out; say whether panes have boxes, as a browser would. */
const setShown = (shown: boolean) => {
  HTMLElement.prototype.getClientRects = function rects() {
    return (shown ? [{}] : []) as unknown as DOMRectList;
  };
};

beforeEach(() => {
  __resetWebgl({ usable: null });
  __resetTerminalFaces();
  constructed.count = 0;
  observed = [];
  setShown(true);
  globalThis.ResizeObserver = class {
    constructor(cb: () => void) { observed.push(cb); }
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  HTMLElement.prototype.getClientRects = originalRects;
  globalThis.ResizeObserver = OriginalResizeObserver;
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
  else delete (document as unknown as Doc).fonts;
});

describe('the font', () => {
  const families = (stack: string | undefined) => (stack ?? '').split(',').map(f => f.trim().replace(/^['"]|['"]$/g, ''));

  it('is the bundled JetBrains Mono first', () => {
    expect(families(TERMINAL_OPTIONS.fontFamily)[0]).toBe('JetBrains Mono Variable');
  });

  it('falls back to a good system monospace on each platform, then the generic one', () => {
    const stack = families(TERMINAL_OPTIONS.fontFamily);
    expect(stack).toEqual(expect.arrayContaining(['Cascadia Mono', 'Consolas', 'Menlo', 'DejaVu Sans Mono']));
    expect(stack[stack.length - 1]).toBe('monospace');
  });

  it('is kept when the size changes', () => {
    expect(terminalOptionsFor(18).fontFamily).toBe(TERMINAL_OPTIONS.fontFamily);
  });
});

/*
 * A Proxy rather than the full fake in TerminalPane.test.tsx: these tests care
 * about addons, options and blur; every subscription the pane makes just needs
 * something with a dispose().
 */
const fakeTerm = () => {
  const loaded: unknown[] = [];
  const familyWrites: string[] = [];
  const blinkWrites: boolean[] = [];
  const options: Record<string, unknown> = { ...TERMINAL_OPTIONS };
  const target: Record<string, unknown> = {
    options: new Proxy(options, {
      set: (o, key: string, value) => {
        if (key === 'fontFamily') familyWrites.push(value);
        if (key === 'cursorBlink') blinkWrites.push(value);
        o[key] = value;
        return true;
      },
    }),
    blinkWrites,
    cols: 80,
    rows: 24,
    buffer: { active: { baseY: 0, cursorY: 0, getLine: () => undefined } },
    loaded,
    familyWrites,
    blur: vi.fn(),
    loadAddon: (addon: ITerminalAddon & { activate?: (t: unknown) => void }) => {
      loaded.push(addon);
      addon.activate?.(target);
    },
  };
  return new Proxy(target, {
    get: (t, prop: string) => (prop in t ? t[prop] : () => ({ dispose: () => {} })),
  }) as unknown as Terminal & {
    loaded: unknown[]; familyWrites: string[]; blinkWrites: boolean[]; blur: ReturnType<typeof vi.fn>; options: ITerminalOptions;
  };
};

const bridge = () => ({
  spawn: vi.fn(async () => ({ sessionId: 'sess-1' })),
  write: vi.fn(), resize: vi.fn(), kill: vi.fn(async () => {}),
  onData: vi.fn(() => () => {}), onExit: vi.fn(() => () => {}),
});

const fitAddon = (fit = vi.fn()) => () => ({ activate: () => {}, dispose: () => {}, fit });

/** A pane-shaped holder that is not a pane, to fill the budget. */
const holder = (shown: boolean, lastShown = 0): WebglHolder & { release: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> } => ({
  shown, lastShown, release: vi.fn(), retry: vi.fn(),
});

const renderer = () => ({
  activate: vi.fn(),
  dispose: vi.fn(),
  clearTextureAtlas: vi.fn(),
  lose: () => {},
  onContextLoss: vi.fn(function onLoss(this: { lose: () => void }, cb: () => void) { this.lose = cb; return { dispose: () => {} }; }),
});

describe('the renderer', () => {
  it('draws through the renderer addon while the pane is on screen', async () => {
    const term = fakeTerm();
    const r = renderer();
    render(<TerminalPane itemId="i1" agentId="shell" bridge={bridge() as never}
      createTerminal={() => term} createFitAddon={fitAddon()} createRendererAddon={async () => r} />);
    await waitFor(() => expect(term.loaded).toContain(r));
    expect(r.activate).toHaveBeenCalled();
  });

  it('keeps its renderer while hidden, so a tab switch does not cost a new context', async () => {
    const made: Array<ReturnType<typeof renderer>> = [];
    render(<TerminalPane itemId="i1" agentId="shell" bridge={bridge() as never}
      createTerminal={() => fakeTerm()} createFitAddon={fitAddon()} createRendererAddon={() => { const r = renderer(); made.push(r); return r; }} />);
    await waitFor(() => expect(made).toHaveLength(1));
    setShown(false);
    act(() => observed.forEach(cb => cb()));
    setShown(true);
    await act(async () => { observed.forEach(cb => cb()); await Promise.resolve(); });
    expect(made).toHaveLength(1);
    expect(made[0].dispose).not.toHaveBeenCalled();
  });

  it('does not take a context for a pane that is not on screen', async () => {
    setShown(false);
    const factory = vi.fn(() => renderer());
    render(<TerminalPane itemId="i1" agentId="shell" bridge={bridge() as never}
      createTerminal={() => fakeTerm()} createFitAddon={fitAddon()} createRendererAddon={factory} />);
    await act(async () => { await Promise.resolve(); });
    expect(factory).not.toHaveBeenCalled();
  });

  it('stays on the DOM renderer while every slot is held by a pane on screen', async () => {
    __resetWebgl({ usable: true });
    for (let i = 0; i < LIVE_LIMIT; i += 1) acquireWebglSlot(holder(true));
    const factory = vi.fn(() => renderer());
    render(<TerminalPane itemId="i1" agentId="shell" bridge={bridge() as never}
      createTerminal={() => fakeTerm()} createFitAddon={fitAddon()} createRendererAddon={factory} />);
    await act(async () => { await Promise.resolve(); });
    expect(factory).not.toHaveBeenCalled();
  });

  it('takes the slot of the pane hidden longest when a shown pane needs one', async () => {
    const hidden = Array.from({ length: LIVE_LIMIT }, (_, i) => holder(false, i + 1));
    hidden.forEach(h => acquireWebglSlot(h));
    const factory = vi.fn(() => renderer());
    render(<TerminalPane itemId="i1" agentId="shell" bridge={bridge() as never}
      createTerminal={() => fakeTerm()} createFitAddon={fitAddon()} createRendererAddon={factory} />);
    await waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    expect(hidden[0].release).toHaveBeenCalled();
    expect(hidden.slice(1).every(h => h.release.mock.calls.length === 0)).toBe(true);
  });

  it('keeps the terminal, and its slot, when the renderer cannot start', async () => {
    const api = bridge();
    const broken = { activate: () => { throw new Error('WebGL2 not supported'); }, dispose: vi.fn() };
    const { queryByRole } = render(<TerminalPane itemId="i1" agentId="shell" bridge={api as never}
      createTerminal={() => fakeTerm()} createFitAddon={fitAddon()} createRendererAddon={() => broken} />);
    await waitFor(() => expect(broken.dispose).toHaveBeenCalled());
    await waitFor(() => expect(api.spawn).toHaveBeenCalledTimes(1));
    expect(queryByRole('alert')).toBeNull();
    // The slot came back: the whole budget is free for others.
    expect(Array.from({ length: LIVE_LIMIT }, () => acquireWebglSlot(holder(true))).every(Boolean)).toBe(true);
  });

  it('lets go of the renderer when the GPU context is lost, and the terminal carries on', async () => {
    const r = renderer();
    const api = bridge();
    render(<TerminalPane itemId="i1" agentId="shell" bridge={api as never}
      createTerminal={() => fakeTerm()} createFitAddon={fitAddon()} createRendererAddon={() => r} />);
    await waitFor(() => expect(r.onContextLoss).toHaveBeenCalled());
    act(() => r.lose());
    expect(r.dispose).toHaveBeenCalled();
    expect(api.kill).not.toHaveBeenCalled();
  });

  it('stays on the DOM renderer after a lost context, however often it resizes', async () => {
    const made: Array<ReturnType<typeof renderer>> = [];
    render(<TerminalPane itemId="i1" agentId="shell" bridge={bridge() as never}
      createTerminal={() => fakeTerm()} createFitAddon={fitAddon()} createRendererAddon={() => { const r = renderer(); made.push(r); return r; }} />);
    await waitFor(() => expect(made[0]?.onContextLoss).toHaveBeenCalled());
    act(() => made[0].lose());
    await act(async () => { observed.forEach(cb => cb()); observed.forEach(cb => cb()); await Promise.resolve(); });
    expect(made).toHaveLength(1);
  });

  it('blurs, then releases the renderer, when the pane closes', async () => {
    const term = fakeTerm();
    const r = renderer();
    const { unmount } = render(<TerminalPane itemId="i1" agentId="shell" bridge={bridge() as never}
      createTerminal={() => term} createFitAddon={fitAddon()} createRendererAddon={() => r} />);
    await waitFor(() => expect(term.loaded).toContain(r));
    unmount();
    expect(term.blur).toHaveBeenCalled();
    expect(r.dispose).toHaveBeenCalled();
  });
});

describe('a real pane giving its context up', () => {
  /*
   * A renderer that does what the WebGL addon does to the page: it adds a
   * canvas to the pane's screen when activated. That is the canvas the pane
   * must lose the context of when it lets go.
   */
  const canvasRenderer = () => {
    const loseContext = vi.fn();
    const r = {
      ...renderer(),
      loseContext,
      activate: vi.fn(() => {
        const host = document.querySelectorAll('[data-testid="terminal-host"]');
        const canvas = document.createElement('canvas');
        (canvas as unknown as { getContext: unknown }).getContext = vi.fn(() => ({ getExtension: () => ({ loseContext }) }));
        host[host.length - 1].appendChild(canvas);
      }),
    };
    return r;
  };

  it('disposes its renderer, loses the canvas context and stops the blink timer when evicted', async () => {
    const term = fakeTerm();
    const r = canvasRenderer();
    render(<TerminalPane itemId="i1" agentId="shell" bridge={bridge() as never}
      createTerminal={() => term} createFitAddon={fitAddon()} createRendererAddon={() => r} />);
    await waitFor(() => expect(term.loaded).toContain(r));

    // Hidden, then a shown pane needs every slot: this one, hidden longest, goes.
    setShown(false);
    act(() => observed.forEach(cb => cb()));
    for (let i = 0; i < LIVE_LIMIT; i += 1) acquireWebglSlot(holder(true, Date.now() + i));

    expect(r.dispose).toHaveBeenCalled();
    expect(r.loseContext).toHaveBeenCalled();
    // Off across the dispose, then back: xterm 5.5 leaks the timer otherwise.
    expect(term.blinkWrites).toEqual([false, true]);
  });

  it('does not attach when it was evicted while its renderer was still loading', async () => {
    let finish: (r: ReturnType<typeof renderer>) => void = () => {};
    const late = renderer();
    const term = fakeTerm();
    render(<TerminalPane itemId="i1" agentId="shell" bridge={bridge() as never}
      createTerminal={() => term} createFitAddon={fitAddon()}
      createRendererAddon={() => new Promise(resolve => { finish = resolve; })} />);
    await act(async () => { await Promise.resolve(); });

    setShown(false);
    act(() => observed.forEach(cb => cb()));
    for (let i = 0; i < LIVE_LIMIT; i += 1) acquireWebglSlot(holder(true, Date.now() + i));

    await act(async () => { finish(late); await Promise.resolve(); await Promise.resolve(); });
    expect(term.loaded).not.toContain(late);
    expect(late.dispose).toHaveBeenCalled();
  });
});

describe('the default renderer', () => {
  it('is never constructed where WebGL2 does not start', async () => {
    __resetWebgl({ usable: false });
    render(<TerminalPane itemId="i1" agentId="shell" bridge={bridge() as never}
      createTerminal={() => fakeTerm()} createFitAddon={fitAddon()} />);
    // Every dynamic import the pane started has settled, so a construction
    // that was coming would have happened by now.
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(constructed.count).toBe(0);

    // The control: the same wait, with WebGL usable, does construct one.
    cleanup();
    __resetWebgl({ usable: true });
    render(<TerminalPane itemId="i2" agentId="shell" bridge={bridge() as never}
      createTerminal={() => fakeTerm()} createFitAddon={fitAddon()} />);
    await act(async () => { await vi.dynamicImportSettled(); });
    await waitFor(() => expect(constructed.count).toBe(1));
  });

  it('is WebGL, loaded into the terminal, where WebGL2 does start', async () => {
    __resetWebgl({ usable: true });
    const term = fakeTerm();
    render(<TerminalPane itemId="i1" agentId="shell" bridge={bridge() as never}
      createTerminal={() => term} createFitAddon={fitAddon()} />);
    await waitFor(() => expect(constructed.count).toBe(1));
    await waitFor(() => expect(term.loaded).toHaveLength(2)); // fit + WebGL
  });
});

describe('asking whether WebGL2 starts', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  afterEach(() => { HTMLCanvasElement.prototype.getContext = originalGetContext; });

  it('says yes for a full-speed context, gives the probe context back, and remembers', () => {
    const loseContext = vi.fn();
    const getContext = vi.fn(() => ({ getExtension: () => ({ loseContext }) }));
    HTMLCanvasElement.prototype.getContext = getContext as never;
    expect(webglUsable()).toBe(true);
    expect(getContext).toHaveBeenCalledWith('webgl2', { failIfMajorPerformanceCaveat: true });
    expect(loseContext).toHaveBeenCalled();
    webglUsable();
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  it('says no where the context is refused, including for a software GPU', () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
    expect(webglUsable()).toBe(false);
  });
});

describe('the slot budget', () => {
  it('hands a freed slot to a shown pane that was waiting for one', () => {
    const onScreen = Array.from({ length: LIVE_LIMIT }, () => holder(true));
    onScreen.forEach(h => acquireWebglSlot(h));
    const late = holder(true);
    expect(acquireWebglSlot(late)).toBe(false);
    releaseWebglSlot(onScreen[0]);
    expect(late.retry).toHaveBeenCalled();
  });

  it('really gives the GPU context back on release', () => {
    const loseContext = vi.fn();
    const canvas = { getContext: vi.fn(() => ({ getExtension: () => ({ loseContext }) })) };
    loseContexts([canvas as never]);
    expect(canvas.getContext).toHaveBeenCalledWith('webgl2');
    expect(loseContext).toHaveBeenCalled();
  });
});

describe('waiting for the font', () => {
  const quietBridge = () => ({
    spawn: vi.fn(() => new Promise(() => {})), write: vi.fn(), resize: vi.fn(), kill: vi.fn(async () => {}),
    onData: vi.fn(() => () => {}), onExit: vi.fn(() => () => {}),
  });

  it('measures again once the face has loaded, then refits', async () => {
    let done: () => void = () => {};
    const load = vi.fn(() => new Promise<unknown>(resolve => { done = () => resolve([]); }));
    // Every range already listed as loaded: only the MEASURING path is under test.
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load, check: () => false, [Symbol.iterator]: () => [{ family: 'JetBrains Mono Variable', status: 'loaded', load: vi.fn() }][Symbol.iterator]() } });
    const term = fakeTerm();
    const fit = vi.fn();
    render(<TerminalPane itemId="i1" agentId="shell" bridge={quietBridge() as never}
      createTerminal={() => term} createFitAddon={fitAddon(fit)} createRendererAddon={() => null} />);
    expect(load).toHaveBeenCalledWith(expect.stringContaining('JetBrains Mono Variable'));
    const fitsBefore = fit.mock.calls.length;
    await act(async () => { done(); await Promise.resolve(); await Promise.resolve(); });
    // Away and back: xterm only re-measures on a CHANGE of the option.
    expect(term.familyWrites).toEqual(['monospace', TERMINAL_OPTIONS.fontFamily]);
    expect(fit.mock.calls.length).toBeGreaterThan(fitsBefore);
  });

  it('does not measure again when the face was already loaded', async () => {
    const load = vi.fn(async () => []);
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load, check: () => true, [Symbol.iterator]: () => [{ family: 'JetBrains Mono Variable', status: 'loaded', load: vi.fn() }][Symbol.iterator]() } });
    const term = fakeTerm();
    render(<TerminalPane itemId="i1" agentId="shell" bridge={quietBridge() as never}
      createTerminal={() => term} createFitAddon={fitAddon()} createRendererAddon={() => null} />);
    await act(async () => { await Promise.resolve(); });
    expect(load).not.toHaveBeenCalled();
    expect(term.familyWrites).toEqual([]);
  });

  it('loads every range of the face once per page, even when latin was already in, then clears each atlas', async () => {
    const pending: Array<() => void> = [];
    const faceLoad = vi.fn(() => new Promise<unknown>(resolve => { pending.push(() => resolve(null)); }));
    const faces = [
      { family: '"JetBrains Mono Variable"', status: 'loaded', load: vi.fn() },
      { family: 'JetBrains Mono Variable', status: 'unloaded', load: faceLoad },
      { family: 'JetBrains Mono Variable', status: 'unloaded', load: faceLoad },
      { family: 'Manrope Variable', status: 'unloaded', load: vi.fn() },
    ];
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: vi.fn(async () => []), check: () => true, [Symbol.iterator]: () => faces[Symbol.iterator]() },
    });
    const r = renderer();
    const term = fakeTerm();
    render(<TerminalPane itemId="i1" agentId="shell" bridge={quietBridge() as never}
      createTerminal={() => term} createFitAddon={fitAddon()} createRendererAddon={() => r} />);
    render(<TerminalPane itemId="i2" agentId="shell" bridge={quietBridge() as never}
      createTerminal={() => fakeTerm()} createFitAddon={fitAddon()} createRendererAddon={() => null} />);
    await waitFor(() => expect(term.loaded).toContain(r));
    expect(faceLoad).toHaveBeenCalledTimes(2);
    expect(faces[0].load).not.toHaveBeenCalled();
    expect(faces[3].load).not.toHaveBeenCalled();
    await act(async () => { pending.forEach(release => release()); await Promise.resolve(); await Promise.resolve(); });
    expect(r.clearTextureAtlas).toHaveBeenCalled();
  });

  it('asks by text, one character per range, when the font set lists no faces', async () => {
    const load = vi.fn(async () => []);
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load, check: () => true } });
    render(<TerminalPane itemId="i1" agentId="shell" bridge={quietBridge() as never}
      createTerminal={() => fakeTerm()} createFitAddon={fitAddon()} createRendererAddon={() => null} />);
    await act(async () => { await Promise.resolve(); });
    expect(load).toHaveBeenCalledWith(expect.stringContaining('JetBrains Mono Variable'), 'AĀЖΩ');
  });

  it('does not touch a terminal that closed before the font arrived', async () => {
    let done: () => void = () => {};
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: vi.fn(() => new Promise<unknown>(resolve => { done = () => resolve([]); })), check: () => false },
    });
    const term = fakeTerm();
    const { unmount } = render(<TerminalPane itemId="i1" agentId="shell" bridge={quietBridge() as never}
      createTerminal={() => term} createFitAddon={fitAddon()} createRendererAddon={() => null} />);
    unmount();
    await act(async () => { done(); await Promise.resolve(); });
    expect(term.familyWrites).toEqual([]);
  });
});
