/**
 * @vitest-environment node
 *
 * INFRA-425: how big the app draws, decided by the person in front of it.
 *
 * Two preferences, both numbers, both stored next to the others in prefs.json:
 *
 *   uiScale           the window's zoom factor, 0.8 to 2.0
 *   terminalFontSize  the xterm font size, 8 to 32
 *
 * The case that prompted them: under WSLg a Linux window is drawn at a scale of
 * 1 on a monitor Windows scales to 150%, so every word in the app is two thirds
 * of the size of the same word in the terminal beside it. Ctrl+= fixed it for
 * the session and forgot it on the next launch.
 *
 * These are the first NUMBERS to cross `prefs:set`, which until now refused
 * anything that was not a boolean or an agent id. A number cannot name a file
 * or a program, so it does not reopen the hole that rule closes — but it is
 * still renderer input, so each one is bounded and a value outside the bounds
 * is refused rather than clamped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_PREFS, readPrefs, readablePrefs, writePref } from '../main/prefs';
import {
  UI_SCALE_MIN,
  UI_SCALE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_MAX,
  stepUiScale,
  zoomShortcut,
} from '../main/appearance';
import { registerPtyIpc } from '../main/ptyIpc';
import { wireUiScale, PREFS_CHANGED_CHANNEL } from '../main/windowUiScale';
import { PtyRegistry } from '../main/ptyRegistry';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-appearance-'));
});

const writeRaw = (value: unknown): void => {
  fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify(value));
};

describe('the stored values', () => {
  it('start at the size the app has always drawn', () => {
    expect(DEFAULT_PREFS.uiScale).toBe(1);
    expect(DEFAULT_PREFS.terminalFontSize).toBe(12);
    expect(readPrefs(dir).uiScale).toBe(1);
    expect(readPrefs(dir).terminalFontSize).toBe(12);
  });

  it('round-trip through the file', () => {
    writePref(dir, 'uiScale', 1.5);
    writePref(dir, 'terminalFontSize', 16);
    expect(readPrefs(dir).uiScale).toBe(1.5);
    expect(readPrefs(dir).terminalFontSize).toBe(16);
  });

  it('pull a hand-edited value back inside the range instead of discarding it', () => {
    // Someone who typed 3 into the file wanted it BIG. The largest scale the
    // app supports is closer to that than the default is.
    writeRaw({ uiScale: 3, terminalFontSize: 4 });
    expect(readPrefs(dir).uiScale).toBe(UI_SCALE_MAX);
    expect(readPrefs(dir).terminalFontSize).toBe(TERMINAL_FONT_SIZE_MIN);
  });

  it('fall back to the default for a value that is not a usable number', () => {
    writeRaw({ uiScale: 'big', terminalFontSize: null });
    expect(readPrefs(dir).uiScale).toBe(1);
    expect(readPrefs(dir).terminalFontSize).toBe(12);
    // JSON has no NaN or Infinity, but 1e999 parses to Infinity.
    fs.writeFileSync(path.join(dir, 'prefs.json'), '{"uiScale": 1e999, "terminalFontSize": 1e999}');
    expect(readPrefs(dir).uiScale).toBe(1);
    expect(readPrefs(dir).terminalFontSize).toBe(12);
  });

  it('keep the font size a whole number', () => {
    writeRaw({ terminalFontSize: 13.6 });
    expect(readPrefs(dir).terminalFontSize).toBe(14);
  });

  it('are readable by the renderer', () => {
    writePref(dir, 'uiScale', 1.4);
    writePref(dir, 'terminalFontSize', 15);
    expect(readablePrefs(readPrefs(dir))).toMatchObject({ uiScale: 1.4, terminalFontSize: 15 });
  });

  it('snap a hand-edited scale between tenths onto the grid', () => {
    writeRaw({ uiScale: 1.25 });
    expect(readPrefs(dir).uiScale).toBe(1.3);
  });
});

describe('zoom shortcuts', () => {
  const key = (k: string, mods: Partial<{ control: boolean; meta: boolean; alt: boolean; shift: boolean }> = {}) => ({
    type: 'keyDown',
    key: k,
    control: false,
    meta: false,
    alt: false,
    shift: false,
    ...mods,
  });

  it('reads Ctrl+= and Ctrl++ as zoom in, Ctrl+- as zoom out, Ctrl+0 as reset', () => {
    expect(zoomShortcut(key('=', { control: true }), 'linux')).toBe('in');
    expect(zoomShortcut(key('+', { control: true, shift: true }), 'linux')).toBe('in');
    expect(zoomShortcut(key('-', { control: true }), 'win32')).toBe('out');
    expect(zoomShortcut(key('0', { control: true }), 'win32')).toBe('reset');
  });

  it('uses Cmd on macOS, where Ctrl+= belongs to the terminal', () => {
    expect(zoomShortcut(key('=', { meta: true }), 'darwin')).toBe('in');
    expect(zoomShortcut(key('=', { control: true }), 'darwin')).toBeNull();
  });

  it('leaves every other key to the page', () => {
    expect(zoomShortcut(key('='), 'linux')).toBeNull();
    expect(zoomShortcut(key('1', { control: true }), 'linux')).toBeNull();
    // Alt+Ctrl+- is a real binding in some agent TUIs.
    expect(zoomShortcut(key('-', { control: true, alt: true }), 'linux')).toBeNull();
    expect(zoomShortcut({ ...key('=', { control: true }), type: 'keyUp' }, 'linux')).toBeNull();
  });

  it('leaves Ctrl+_ to the terminal, where it is undo', () => {
    // Shift+Minus is '_' on US layouts; xterm sends 0x1F for it.
    expect(zoomShortcut({ ...key('_', { control: true, shift: true }), code: 'Minus' }, 'linux')).toBeNull();
  });

  it('matches the physical key too, so other layouts reset the stored zoom and not only the window', () => {
    // AZERTY: the 0 key types 'à'. Electron's menu would reset by keycode.
    expect(zoomShortcut({ ...key('à', { control: true }), code: 'Digit0' }, 'linux')).toBe('reset');
    expect(zoomShortcut({ ...key('+', { control: true }), code: 'NumpadAdd' }, 'win32')).toBe('in');
  });

  it('steps by a tenth without drifting, and stops at the ends of the range', () => {
    expect(stepUiScale(1, 'in')).toBe(1.1);
    expect(stepUiScale(1.1, 'in')).toBe(1.2);
    expect(stepUiScale(1.2, 'out')).toBe(1.1);
    expect(stepUiScale(UI_SCALE_MAX, 'in')).toBe(UI_SCALE_MAX);
    expect(stepUiScale(UI_SCALE_MIN, 'out')).toBe(UI_SCALE_MIN);
    expect(stepUiScale(1.7, 'reset')).toBe(1);
  });
});

describe('prefs:set for the appearance values', () => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<Record<string, unknown>>;
  let handlers: Record<string, Handler>;
  let setZoomFactor: ReturnType<typeof vi.fn>;
  let event: { sender: { id: number; setZoomFactor: (f: number) => void } };

  beforeEach(() => {
    handlers = {};
    setZoomFactor = vi.fn();
    event = { sender: { id: 1, setZoomFactor } };
    const registry = { spawn: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(), ack: vi.fn() } as unknown as PtyRegistry;
    registerPtyIpc(registry, {
      handle: (channel, listener) => {
        handlers[channel] = (ev, ...args) => Promise.resolve().then(() => (listener as never as Handler)(ev, ...args));
      },
    }, () => ({ available: false }), () => dir);
  });

  it('stores the scale and applies it to the window that asked', async () => {
    const got = await handlers['prefs:set'](event, { key: 'uiScale', value: 1.5 });
    expect(got.uiScale).toBe(1.5);
    expect(readPrefs(dir).uiScale).toBe(1.5);
    expect(setZoomFactor).toHaveBeenCalledWith(1.5);
  });

  it('refuses a scale outside the range, or one that is not a number', async () => {
    for (const bad of [UI_SCALE_MAX + 0.1, UI_SCALE_MIN - 0.1, '1.5', NaN, null, undefined]) {
      await expect(handlers['prefs:set'](event, { key: 'uiScale', value: bad })).rejects.toThrow(/uiScale/);
    }
    expect(readPrefs(dir).uiScale).toBe(1);
    expect(setZoomFactor).not.toHaveBeenCalled();
  });

  it('snaps a scale between tenths onto the grid Settings can show', async () => {
    const got = await handlers['prefs:set'](event, { key: 'uiScale', value: 1.234 });
    expect(got.uiScale).toBe(1.2);
    expect(setZoomFactor).toHaveBeenCalledWith(1.2);
  });

  it('stores the terminal font size', async () => {
    const got = await handlers['prefs:set'](event, { key: 'terminalFontSize', value: 16 });
    expect(got.terminalFontSize).toBe(16);
    expect(readPrefs(dir).terminalFontSize).toBe(16);
  });

  it('refuses a font size that is out of range or not a whole number', async () => {
    for (const bad of [TERMINAL_FONT_SIZE_MAX + 1, TERMINAL_FONT_SIZE_MIN - 1, 14.5, '14', Infinity]) {
      await expect(handlers['prefs:set'](event, { key: 'terminalFontSize', value: bad })).rejects.toThrow(/terminalFontSize/);
    }
    expect(readPrefs(dir).terminalFontSize).toBe(12);
  });

  it('answers prefs:get with both values', async () => {
    writePref(dir, 'uiScale', 1.3);
    writePref(dir, 'terminalFontSize', 18);
    const got = await handlers['prefs:get'](event);
    expect(got).toMatchObject({ uiScale: 1.3, terminalFontSize: 18 });
  });
});

describe('the window keeps the stored zoom', () => {
  const fakeWindow = () => {
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    let zoom = 1;
    const contents = {
      isDestroyed: () => false,
      setZoomFactor: vi.fn((f: number) => { zoom = f; }),
      getZoomFactor: () => zoom,
      send: vi.fn(),
      on: (name: string, cb: (...args: unknown[]) => void) => { listeners[name] = cb; },
    };
    return { win: { webContents: contents } as never, contents, listeners };
  };
  const press = (k: string) => ({ type: 'keyDown', key: k, control: true, meta: false, alt: false, shift: false });

  it('applies the stored scale on every load', () => {
    writePref(dir, 'uiScale', 1.4);
    const { win, contents, listeners } = fakeWindow();
    wireUiScale(win, () => dir, 'linux');
    listeners['did-finish-load']();
    expect(contents.setZoomFactor).toHaveBeenCalledWith(1.4);
  });

  it('stores a Ctrl+= press, applies it and tells the renderer', () => {
    const { win, contents, listeners } = fakeWindow();
    wireUiScale(win, () => dir, 'linux');
    const preventDefault = vi.fn();
    listeners['before-input-event']({ preventDefault }, press('='));
    expect(preventDefault).toHaveBeenCalled();
    expect(readPrefs(dir).uiScale).toBe(1.1);
    expect(contents.setZoomFactor).toHaveBeenLastCalledWith(1.1);
    expect(contents.send).toHaveBeenCalledWith(PREFS_CHANGED_CHANNEL, expect.objectContaining({ uiScale: 1.1 }));
  });

  it('lets every other key through untouched', () => {
    const { win, contents, listeners } = fakeWindow();
    wireUiScale(win, () => dir, 'linux');
    const preventDefault = vi.fn();
    listeners['before-input-event']({ preventDefault }, press('c'));
    expect(preventDefault).not.toHaveBeenCalled();
    expect(contents.setZoomFactor).not.toHaveBeenCalled();
  });

  it('still zooms when the preference cannot be written, without throwing in main', () => {
    // A FILE where the directory should be: every write under it fails.
    const blocked = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocked, '');
    const { win, contents, listeners } = fakeWindow();
    wireUiScale(win, () => blocked, 'linux');
    expect(() => listeners['before-input-event']({ preventDefault: vi.fn() }, press('='))).not.toThrow();
    expect(contents.setZoomFactor).toHaveBeenCalledWith(1.1);
    // Presses still add up when nothing can be stored.
    listeners['before-input-event']({ preventDefault: vi.fn() }, press('='));
    expect(contents.setZoomFactor).toHaveBeenLastCalledWith(1.2);
    expect(contents.send).not.toHaveBeenCalled();
  });
});

describe('the push reaches the renderer', () => {
  it('is the channel the preload subscribes to', () => {
    // Two literals in two files is a coupling no type checks; this does.
    const preload = fs.readFileSync(path.join(__dirname, '../preload/index.ts'), 'utf8');
    expect(preload).toContain(`subscribe('${PREFS_CHANGED_CHANNEL}'`);
  });
});

