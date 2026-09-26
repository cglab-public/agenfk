/**
 * @vitest-environment node
 *
 * One listener per channel, routed by session (CGLAB f2fa8fc4).
 *
 * The preload registered an `ipcRenderer.on` PER SUBSCRIBER, and each terminal
 * pane subscribes to three channels. So with N terminals every chunk of output
 * was dispatched to N listeners and discarded by N−1, and with N of them busy
 * the aggregate cost is O(N²) — the audit's figure was thirty terminals at a
 * hundred chunks a second each, or ninety thousand listener invocations per
 * second.
 *
 * It also had a visible tell: `ipcRenderer` is a Node EventEmitter with a
 * default `maxListeners` of ten, so opening the eleventh terminal printed
 * `MaxListenersExceededWarning` — a leak detector firing on intended
 * behaviour, which is the kind of thing that teaches people to ignore the
 * warning.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSessionDemux } from '../preload/sessionDemux';

/** A stand-in for ipcRenderer that counts what is registered on it. */
const fakeIpc = () => {
  const handlers = new Map<string, Set<(e: unknown, p: unknown) => void>>();
  return {
    handlers,
    count: (channel: string) => handlers.get(channel)?.size ?? 0,
    on(channel: string, h: (e: unknown, p: unknown) => void) {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(h);
    },
    off(channel: string, h: (e: unknown, p: unknown) => void) {
      handlers.get(channel)?.delete(h);
    },
    /** Deliver as the main process would: an event object, then the payload. */
    emit(channel: string, payload: unknown) {
      for (const h of [...(handlers.get(channel) ?? [])]) h({ sender: 'DANGER' }, payload);
    },
  };
};

describe('how many listeners reach ipcRenderer', () => {
  it('registers exactly one, however many sessions subscribe', () => {
    /*
     * THE test. Thirty is the app's own cap on terminals, so this is the real
     * worst case rather than a round number — and it is three times over the
     * EventEmitter's default limit, which is what used to print a warning.
     */
    const ipc = fakeIpc();
    const demux = createSessionDemux(ipc);
    const offs = Array.from({ length: 30 }, (_, i) => demux.on('pty:data', `s${i}`, () => {}));
    expect(ipc.count('pty:data')).toBe(1);
    offs.forEach(off => off());
  });

  it('registers none before anyone subscribes', () => {
    const ipc = fakeIpc();
    createSessionDemux(ipc);
    expect(ipc.count('pty:data')).toBe(0);
  });

  it('removes it when the last subscriber goes', () => {
    // Otherwise the preload holds a listener for a channel nobody is reading,
    // for the life of the window.
    const ipc = fakeIpc();
    const demux = createSessionDemux(ipc);
    const a = demux.on('pty:data', 's1', () => {});
    const b = demux.on('pty:data', 's2', () => {});
    a();
    expect(ipc.count('pty:data')).toBe(1);
    b();
    expect(ipc.count('pty:data')).toBe(0);
  });

  it('keeps channels independent', () => {
    // Three channels per pane; unsubscribing from one must not silence another.
    const ipc = fakeIpc();
    const demux = createSessionDemux(ipc);
    const data = demux.on('pty:data', 's1', () => {});
    demux.on('pty:exit', 's1', () => {});
    data();
    expect(ipc.count('pty:data')).toBe(0);
    expect(ipc.count('pty:exit')).toBe(1);
  });
});

describe('who receives a payload', () => {
  it('goes only to the session it belongs to', () => {
    /*
     * The other half of the cost, and the more important half for correctness:
     * one card's shell output — including whatever the agent prints — must not
     * reach another card's callback at all, rather than reaching it and being
     * discarded there.
     */
    const ipc = fakeIpc();
    const demux = createSessionDemux(ipc);
    const mine: unknown[] = [];
    const theirs: unknown[] = [];
    demux.on('pty:data', 's1', p => mine.push(p));
    demux.on('pty:data', 's2', p => theirs.push(p));

    ipc.emit('pty:data', { sessionId: 's1', data: 'hello' });
    expect(mine).toEqual([{ sessionId: 's1', data: 'hello' }]);
    expect(theirs).toEqual([]);
  });

  it('reaches every subscriber of the same session', () => {
    // Two readers of one session is legitimate — a pane and something
    // watching. Routing must not mean "only the first".
    const ipc = fakeIpc();
    const demux = createSessionDemux(ipc);
    const seen: string[] = [];
    demux.on('pty:data', 's1', () => seen.push('a'));
    demux.on('pty:data', 's1', () => seen.push('b'));
    ipc.emit('pty:data', { sessionId: 's1', data: 'x' });
    expect(seen).toEqual(['a', 'b']);
  });

  it('drops a payload for a session nobody is watching', () => {
    const ipc = fakeIpc();
    const demux = createSessionDemux(ipc);
    const seen: unknown[] = [];
    demux.on('pty:data', 's1', p => seen.push(p));
    ipc.emit('pty:data', { sessionId: 'someone-else', data: 'x' });
    expect(seen).toEqual([]);
  });

  it('never hands the renderer Electron\'s event object', () => {
    /*
     * The rule the preload's own comment states: `IpcRendererEvent` carries
     * `sender`, a way back into the main process that nothing in the renderer
     * should have. The demux must not lose that when it takes over delivery.
     */
    const ipc = fakeIpc();
    const demux = createSessionDemux(ipc);
    const args: unknown[][] = [];
    demux.on('pty:data', 's1', (...a: unknown[]) => args.push(a));
    ipc.emit('pty:data', { sessionId: 's1', data: 'x' });
    expect(args).toEqual([[{ sessionId: 's1', data: 'x' }]]);
  });

  it('survives a payload that is not shaped like one', () => {
    // Main is trusted, but a channel that ever carries something else must not
    // take the whole terminal down from inside a dispatch loop.
    const ipc = fakeIpc();
    const demux = createSessionDemux(ipc);
    demux.on('pty:data', 's1', () => {});
    expect(() => ipc.emit('pty:data', null)).not.toThrow();
    expect(() => ipc.emit('pty:data', { nope: true })).not.toThrow();
  });

  it('keeps delivering to the others when one subscriber throws', () => {
    // One pane failing must not silence every other terminal in the window.
    const ipc = fakeIpc();
    const demux = createSessionDemux(ipc);
    const seen: string[] = [];
    demux.on('pty:data', 's1', () => { throw new Error('render failed'); });
    demux.on('pty:data', 's1', () => seen.push('survived'));
    expect(() => ipc.emit('pty:data', { sessionId: 's1', data: 'x' })).not.toThrow();
    expect(seen).toEqual(['survived']);
  });
});

describe('unsubscribing', () => {
  it('stops delivery to that subscriber only', () => {
    const ipc = fakeIpc();
    const demux = createSessionDemux(ipc);
    const seen: string[] = [];
    const off = demux.on('pty:data', 's1', () => seen.push('gone'));
    demux.on('pty:data', 's1', () => seen.push('stays'));
    off();
    ipc.emit('pty:data', { sessionId: 's1', data: 'x' });
    expect(seen).toEqual(['stays']);
  });

  it('is safe to call twice', () => {
    // React cleanups run once, StrictMode double-invokes, and callers are
    // careless. A second call must not remove somebody else's subscription.
    const ipc = fakeIpc();
    const demux = createSessionDemux(ipc);
    const off = demux.on('pty:data', 's1', () => {});
    demux.on('pty:data', 's1', () => {});
    off();
    off();
    expect(ipc.count('pty:data')).toBe(1);
  });
});
