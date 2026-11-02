/**
 * @vitest-environment node
 *
 * The main process, loaded for real against a stand-in Electron.
 *
 * windowFullScreen.test.ts and the bundle tests used to read main/index.ts as
 * TEXT to check three things: that the full-screen query is answered at the
 * top level rather than inside boot, that every window is wired for the
 * full-screen push, and that the renderer is sandboxed. Each of those is a
 * call the module makes, so they are asserted here as calls - which a
 * reformatted line or a renamed local cannot fool.
 *
 * `whenReady` never settles, so boot (the server, node-pty, the login shell)
 * never runs: whatever is observed was done by the module's top level.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { FULL_SCREEN_CHANNEL, FULL_SCREEN_QUERY } from '../main/windowFullScreen';

interface FakeWindow {
  opts: { webPreferences?: Record<string, unknown> };
  listeners: Record<string, Array<(...a: unknown[]) => void>>;
  sent: Array<[string, unknown]>;
  full: boolean;
}

const h = vi.hoisted(() => ({
  ipcOn: new Map<string, (event: { sender: unknown; returnValue: unknown }) => void>(),
  windows: [] as FakeWindow[],
  fromWebContents: { current: null as null | ((sender: unknown) => unknown) },
}));

vi.mock('electron', () => {
  class BrowserWindow {
    opts: FakeWindow['opts'];
    listeners: FakeWindow['listeners'] = {};
    sent: FakeWindow['sent'] = [];
    full = false;
    webContents = {
      id: 1,
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => { this.sent.push([channel, payload]); },
      on: () => {},
      once: () => {},
      setWindowOpenHandler: () => {},
    };
    constructor(opts: FakeWindow['opts']) {
      this.opts = opts;
      h.windows.push(this as unknown as FakeWindow);
    }
    on(event: string, cb: (...a: unknown[]) => void) { (this.listeners[event] ??= []).push(cb); return this; }
    once(event: string, cb: (...a: unknown[]) => void) { return this.on(event, cb); }
    isFullScreen() { return this.full; }
    loadURL() { return Promise.resolve(); }
    show() {}
    static getAllWindows() { return []; }
    static fromWebContents(sender: unknown) { return h.fromWebContents.current?.(sender) ?? null; }
  }
  const app = {
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}),
    on: () => app,
    setName: () => {},
    quit: () => {},
    isPackaged: false,
    getPath: () => '/tmp/agenfk-desktop-test',
    getVersion: () => '0.0.0',
  };
  const ipcMain = {
    on: (channel: string, cb: (event: { sender: unknown; returnValue: unknown }) => void) => { h.ipcOn.set(channel, cb); },
    handle: () => {},
    removeHandler: () => {},
  };
  const electron = { app, BrowserWindow, ipcMain, dialog: {}, Notification: class {}, shell: {}, utilityProcess: {} };
  return { ...electron, default: electron };
});

let main: Record<string, unknown>;
beforeAll(async () => {
  main = await import('../main/index');
});

describe('the full-screen query', () => {
  it('is answered from the top level, before boot has run', () => {
    // whenReady never settled, so boot did not register this.
    expect(h.ipcOn.has(FULL_SCREEN_QUERY), 'nothing answers the preload, and sendSync gets undefined').toBe(true);
  });

  it('answers for the window that asked', () => {
    const asking = { isFullScreen: () => true };
    h.fromWebContents.current = sender => (sender === 'renderer-1' ? asking : null);
    const event = { sender: 'renderer-1', returnValue: undefined as unknown };
    h.ipcOn.get(FULL_SCREEN_QUERY)!(event);
    expect(event.returnValue).toBe(true);
  });
});

describe('a window the app creates', () => {
  const create = (): FakeWindow => {
    expect(typeof main.createWindow, 'main/index.ts does not export createWindow').toBe('function');
    const before = h.windows.length;
    (main.createWindow as (url: string) => unknown)('http://127.0.0.1:3000');
    expect(h.windows.length).toBe(before + 1);
    return h.windows[h.windows.length - 1];
  };

  it('runs the renderer sandboxed, isolated and without Node', () => {
    const prefs = create().opts.webPreferences!;
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
  });

  it('tells its renderer when it enters and leaves full screen', () => {
    const win = create();
    win.full = true;
    for (const cb of win.listeners['enter-full-screen'] ?? []) cb();
    win.full = false;
    for (const cb of win.listeners['leave-full-screen'] ?? []) cb();
    expect(win.sent).toEqual([[FULL_SCREEN_CHANNEL, true], [FULL_SCREEN_CHANNEL, false]]);
  });
});
