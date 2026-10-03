/**
 * @vitest-environment node
 *
 * Telling the renderer the window went full screen.
 *
 * On macOS the shell draws its own title bar - an empty drag row with room
 * reserved for the traffic lights - because `hiddenInset` removes the native
 * one. In full screen there are no lights and no window to drag, so that row is
 * 36px of nothing over the terminal. The renderer cannot see full screen on its
 * own: only the BrowserWindow knows, and this is how it says so.
 *
 * ASKED once, then pushed. A reload in full screen has to come up without the
 * row on its FIRST paint, so the preload asks synchronously before the page
 * runs (review: a push on did-finish-load arrived after React had already
 * drawn the windowed bar); every change after that is pushed.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  wireFullScreen, answerFullScreenQuery, FULL_SCREEN_CHANNEL, FULL_SCREEN_QUERY, type FullScreenWindow,
} from '../main/windowFullScreen';

type Handler = () => void;

const fakeWindow = (opts: { fullScreen?: boolean; destroyed?: boolean } = {}) => {
  let full = opts.fullScreen ?? false;
  const handlers: Record<string, Handler[]> = {};
  const sent: unknown[][] = [];
  const win: FullScreenWindow = {
    isFullScreen: () => full,
    on: (event, cb) => { (handlers[event] ??= []).push(cb); },
    webContents: {
      isDestroyed: () => opts.destroyed ?? false,
      send: (channel: string, payload: unknown) => {
        // Faithful to Electron: sending to a destroyed webContents throws.
        if (opts.destroyed) throw new Error('Object has been destroyed');
        sent.push([channel, payload]);
      },
    },
  };
  return {
    win,
    sent,
    enter: () => { full = true; handlers['enter-full-screen']?.forEach(h => h()); },
    leave: () => { full = false; handlers['leave-full-screen']?.forEach(h => h()); },
  };
};

describe('wireFullScreen', () => {
  it('says so when the window enters full screen', () => {
    const w = fakeWindow();
    wireFullScreen(w.win);
    w.enter();
    expect(w.sent).toEqual([[FULL_SCREEN_CHANNEL, true]]);
  });

  it('says so when it leaves', () => {
    const w = fakeWindow({ fullScreen: true });
    wireFullScreen(w.win);
    w.leave();
    expect(w.sent).toEqual([[FULL_SCREEN_CHANNEL, false]]);
  });

  it('stays quiet for a window that is going away', () => {
    // A destroyed webContents throws on send, and the leave event fires while
    // a full-screen window closes.
    const w = fakeWindow({ fullScreen: true, destroyed: true });
    wireFullScreen(w.win);
    expect(() => w.leave()).not.toThrow();
    expect(w.sent).toEqual([]);
  });

  it('is a channel name, not a string the two sides retype', () => {
    expect(FULL_SCREEN_CHANNEL).toBe('window:fullScreen');
  });
});

describe('answerFullScreenQuery', () => {
  type Listener = (event: { sender: unknown; returnValue: unknown }) => void;
  const fakeIpc = () => {
    const listeners: Record<string, Listener> = {};
    return {
      ipc: { on: (channel: string, cb: Listener) => { listeners[channel] = cb; } },
      ask: (sender: unknown) => {
        const event = { sender, returnValue: undefined as unknown };
        listeners[FULL_SCREEN_QUERY]?.(event);
        return event.returnValue;
      },
    };
  };

  it('answers for the window that asked - Cmd+R in full screen paints no row', () => {
    // The renderer starts again with nothing cached, and no enter event is
    // coming to correct it.
    const full = fakeWindow({ fullScreen: true });
    const windowed = fakeWindow();
    const f = fakeIpc();
    answerFullScreenQuery(f.ipc, sender => (sender === 'a' ? full.win : sender === 'b' ? windowed.win : null));
    expect(f.ask('a')).toBe(true);
    expect(f.ask('b')).toBe(false);
  });

  it('answers false, never undefined, for a sender with no window', () => {
    // sendSync hands the renderer whatever returnValue is, and the preload
    // must get a boolean back even from a webContents that is not a window.
    const f = fakeIpc();
    answerFullScreenQuery(f.ipc, () => null);
    expect(f.ask('x')).toBe(false);
  });

  it('still answers when finding the window throws - sendSync would hang the renderer', () => {
    // From review: a listener that throws before setting returnValue leaves
    // the preload blocked until main happens to collect the event.
    const f = fakeIpc();
    answerFullScreenQuery(f.ipc, () => { throw new Error('destroyed'); });
    expect(f.ask('x')).toBe(false);
  });

  it('is its own channel, separate from the push', () => {
    expect(FULL_SCREEN_QUERY).toBe('window:isFullScreen');
    expect(FULL_SCREEN_QUERY).not.toBe(FULL_SCREEN_CHANNEL);
  });
});

describe('the window is actually wired', () => {
  it('is called on the window the app creates', () => {
    // A module nothing calls is a feature that looks finished. The same
    // defect ipcSurface.test.ts exists for, one level up.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, '../main/index.ts'), 'utf8');
    expect(src).toMatch(/wireFullScreen\(\s*win\s*\)/);
  });

  it('answers the query from the app itself, not from inside boot', () => {
    /*
     * From review: registered inside boot's terminal setup, a node-pty that
     * failed to load skipped it - and a sendSync nobody answers blocks every
     * window's preload, a blank window in the path meant to degrade softly.
     *
     * So: once, at the top level, before boot runs, and so before any window
     * (activate, second-instance or boot's own) can exist to ask.
     */
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, '../main/index.ts'), 'utf8');
    const answered = src.search(/answerFullScreenQuery\(\s*ipcMain/);
    expect(answered, 'nothing answers the preload, and sendSync gets undefined').toBeGreaterThan(-1);
    const bootStart = src.search(/async function boot\(/);
    const bootEnd = src.indexOf('\n}\n', bootStart);
    expect(answered > bootStart && answered < bootEnd, 'registered inside boot, where a failure can skip it').toBe(false);
    expect(answered, 'registered after boot is started').toBeLessThan(src.search(/app\.whenReady\(\)\.then\(boot\)/));
  });
});
