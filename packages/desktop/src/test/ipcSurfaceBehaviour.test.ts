/**
 * @vitest-environment node
 *
 * The IPC surface, observed rather than parsed.
 *
 * The defect this guards: a bridge the preload exposes whose channel nothing in
 * main handles - the button exists, the promise never settles - or a handler
 * nothing can reach, or a push the renderer subscribes to that main never
 * sends. ipcSurface.test.ts used to find the channels with regexes over the
 * source; here the preload is loaded against a recording ipcRenderer and every
 * bridge it exposes is called, main's handlers are registered against a
 * recording ipc, and the registry is driven until it emits.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { registerPtyIpc } from '../main/ptyIpc';
import { answerFullScreenQuery } from '../main/windowFullScreen';
import { PtyRegistry } from '../main/ptyRegistry';

const h = vi.hoisted(() => ({
  invoked: new Set<string>(),
  subscribed: new Set<string>(),
  exposed: null as unknown,
}));

vi.mock('electron', () => {
  const ipcRenderer = {
    invoke: (channel: string) => { h.invoked.add(channel); return new Promise(() => {}); },
    sendSync: (channel: string) => { h.invoked.add(channel); return false; },
    on: (channel: string) => { h.subscribed.add(channel); },
    off: () => {},
  };
  const contextBridge = { exposeInMainWorld: (_key: string, api: unknown) => { h.exposed = api; } };
  const electron = { ipcRenderer, contextBridge };
  return { ...electron, default: electron };
});

/** Call every function the preload exposes, at any depth. */
function callEveryBridge(node: unknown, seen = new Set<unknown>()): void {
  if (node === null || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (typeof value === 'function') {
      try {
        const out = (value as (...a: unknown[]) => unknown)({}, () => {}, 0);
        if (out && typeof (out as Promise<unknown>).catch === 'function') (out as Promise<unknown>).catch(() => {});
      } catch { /* a bridge that validates its argument still had to reach for its channel first, or not at all */ }
    } else {
      callEveryBridge(value, seen);
    }
  }
}

let handled: string[];
let emitted: string[];

beforeAll(async () => {
  await import('../preload/index');
  callEveryBridge(h.exposed);

  const channels = new Set<string>();
  const ipc = { handle: (channel: string) => { channels.add(channel); } };
  registerPtyIpc({} as never, ipc as never);
  answerFullScreenQuery({ on: (channel: string) => { channels.add(channel); } }, () => null);
  handled = [...channels].sort();

  // Drive a real registry with a fake PTY until it has said everything it says.
  const sent = new Set<string>();
  let push: (d: string) => void = () => {};
  let exit: (e: { exitCode: number }) => void = () => {};
  const registry = new PtyRegistry({
    spawn: (() => ({
      pid: 4242,
      onData: (cb: (d: string) => void) => { push = cb; },
      onExit: (cb: (e: { exitCode: number }) => void) => { exit = cb; },
      write: () => {}, resize: () => {}, kill: () => {}, pause: () => {}, resume: () => {},
    })) as never,
    resolveCwd: async () => ({ cwd: '/tmp/wt/i1', branchName: 'feat/x' }),
    emit: (_windowId, channel) => { sent.add(channel); },
  });
  await registry.spawn({ itemId: 'i1', agentId: 'claude-code', windowId: 1, cols: 80, rows: 24 });
  push('\u001b]0;⣾ Editing a file\u0007hello');
  exit({ exitCode: 0 });
  emitted = [...sent, 'window:fullScreen'].sort();
});

describe('the renderer can reach main', () => {
  it('exposes bridges at all, so an empty walk cannot pass', () => {
    expect(h.invoked.size).toBeGreaterThan(10);
    expect(handled.length).toBeGreaterThan(10);
  });

  it('every channel a bridge invokes has a handler in main', () => {
    expect([...h.invoked].filter(c => !handled.includes(c))).toEqual([]);
  });

  it('every handler in main is reachable from some bridge', () => {
    expect(handled.filter(c => !h.invoked.has(c))).toEqual([]);
  });
});

describe('main can reach the renderer', () => {
  it('main sends every channel the preload subscribes to', () => {
    expect(h.subscribed.size).toBeGreaterThan(0);
    /*
     * Named, not skipped: the proposal's live output is sent from inside boot
     * (main/index.ts, the propose handler), which this file cannot run. Any
     * OTHER subscription with no sender still fails here.
     */
    const SENT_FROM_BOOT = ['agents:proposeOutput'];
    expect([...h.subscribed].filter(c => !emitted.includes(c)).sort()).toEqual(SENT_FROM_BOOT);
  });

  it('the preload listens for every channel main sends', () => {
    expect(emitted.filter(c => !h.subscribed.has(c))).toEqual([]);
  });
});
