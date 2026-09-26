/**
 * @vitest-environment node
 *
 * Sending to one window, and not to a dead one (CGLAB a1cd226e).
 *
 * This is called from inside node-pty's `onData` emitter. That makes the
 * destroyed-webContents case worse than it looks: `send` on a destroyed
 * webContents throws, and the throw escapes into the data callback of a LIVE
 * session — taking the forward, the title reader and the flow-control
 * accounting down with it, for the sake of a window that is closing anyway.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeEmit, type WindowLike } from '../main/windowEmit';

const win = (id: number, destroyed = false): WindowLike & { sent: unknown[][] } => {
  const sent: unknown[][] = [];
  return {
    sent,
    webContents: {
      id,
      isDestroyed: () => destroyed,
      send: (channel: string, payload: unknown) => {
        // Faithful to Electron: sending to a destroyed webContents throws.
        if (destroyed) throw new Error('Object has been destroyed');
        sent.push([channel, payload]);
      },
    },
  };
};

describe('who gets the message', () => {
  it('goes to the window that asked for it', () => {
    const a = win(1);
    const b = win(2);
    makeEmit(() => [a, b])(2, 'pty:data', { x: 1 });
    expect(b.sent).toEqual([['pty:data', { x: 1 }]]);
  });

  it('goes to NOBODY else', () => {
    /*
     * The rule the whole function exists for. A session's output belongs to
     * the window that opened it; broadcasting would put one card's shell —
     * including whatever the agent prints — into every other open window.
     */
    const a = win(1);
    const b = win(2);
    makeEmit(() => [a, b])(2, 'pty:data', { x: 1 });
    expect(a.sent).toEqual([]);
  });

  it('says nothing at all when that window is gone', () => {
    const a = win(1);
    expect(() => makeEmit(() => [a])(99, 'pty:data', {})).not.toThrow();
    expect(a.sent).toEqual([]);
  });
});

describe('a window that is enumerable but already destroyed', () => {
  it('does not throw', () => {
    /*
     * THE case. A `BrowserWindow` can still be in `getAllWindows()` while its
     * webContents is destroyed, so finding it is not proof it can be spoken
     * to. Unguarded, this throw lands in a live pty's data callback.
     */
    const dead = win(1, true);
    expect(() => makeEmit(() => [dead])(1, 'pty:data', { x: 1 })).not.toThrow();
  });

  it('does not even attempt the send', () => {
    // Not merely swallowing the error: asking at all is the mistake, and a
    // try/catch would hide a real failure somewhere else on this path.
    const dead = win(1, true);
    const spy = vi.spyOn(dead.webContents, 'send');
    makeEmit(() => [dead])(1, 'pty:data', {});
    expect(spy).not.toHaveBeenCalled();
  });

  it('still reaches a live window beside a destroyed one', () => {
    const dead = win(1, true);
    const live = win(2);
    makeEmit(() => [dead, live])(2, 'pty:exit', { code: 0 });
    expect(live.sent).toEqual([['pty:exit', { code: 0 }]]);
  });
});

describe('how it finds the window', () => {
  it('looks again on every call, holding no reference', () => {
    /*
     * A captured list would be a stale window reference, which is the worse
     * bug of the two: it keeps a closed window's webContents alive for the
     * lifetime of the registry. Looking it up each time is why the destroyed
     * case can happen at all, and it is still the right trade.
     */
    let windows: (WindowLike & { sent: unknown[][] })[] = [];
    const emit = makeEmit(() => windows);
    emit(1, 'pty:data', { first: true });     // no windows yet
    const late = win(1);
    windows = [late];
    emit(1, 'pty:data', { second: true });
    expect(late.sent).toEqual([['pty:data', { second: true }]]);
  });
});
