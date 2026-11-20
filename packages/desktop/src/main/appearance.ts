/**
 * How big the app draws (INFRA-425).
 *
 * Two numbers the person chooses, kept in prefs.json with the rest:
 *
 *   uiScale           the window's zoom factor
 *   terminalFontSize  the xterm font size
 *
 * WHY THEY EXIST: under WSLg a Linux window is drawn at a scale of 1 on a
 * monitor Windows scales to 150%, so every word in the app came out two thirds
 * the size of the same word in the terminal next to it. Electron's default
 * View menu could zoom, and forgot the zoom on the next launch.
 *
 * Bounds are a product decision, written here once so the IPC border, the file
 * reader and the shortcut all agree on them. Below 0.8 the sidebar's labels
 * truncate to nothing; above 2.0 the board stops fitting a 1080p screen.
 */

export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 2;
/** One press of Ctrl+= or Ctrl+-. A tenth is the step Chromium users know. */
export const UI_SCALE_STEP = 0.1;

export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;

/*
 * Snapped to the tenths grid, so 1.1 + 0.1 is stored as 1.2 and not
 * 1.2000000000000002, and so a hand-edited 1.25 lands on a value Settings can
 * show. The drift is invisible in the zoom and very visible in a <select>,
 * which shows its FIRST option for a value that matches none of them.
 */
const toTenths = (n: number): number => Math.round(n * 10) / 10;

/** Whether the renderer may store this scale. Strict: refused, never clamped. */
export const isUiScale = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= UI_SCALE_MIN && value <= UI_SCALE_MAX;

/** Whether the renderer may store this font size. Strict: refused, never clamped. */
export const isTerminalFontSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value)
  && value >= TERMINAL_FONT_SIZE_MIN && value <= TERMINAL_FONT_SIZE_MAX;

/*
 * THE FILE IS TREATED MORE GENEROUSLY THAN THE RENDERER, and on purpose.
 *
 * A value in prefs.json was put there by a person with an editor, and someone
 * who typed `"uiScale": 3` wanted it big: the largest supported scale is closer
 * to that than the default is. A value from the renderer came from our own
 * <select>, so one outside the range means something is wrong and is refused.
 *
 * Non-finite values (JSON's 1e999 parses to Infinity) say nothing about size,
 * so they answer null and the caller keeps the default.
 */
export function clampUiScale(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return toTenths(Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, value)));
}

export function clampTerminalFontSize(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, value)));
}

export type ZoomDirection = 'in' | 'out' | 'reset';

/** The slice of Electron's `Input` the shortcut reads, so tests need no Electron. */
export interface KeyInput {
  type: string;
  key: string;
  /** The physical key. Optional because a synthesised event may lack it. */
  code?: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * Which zoom, if any, a key press asks for.
 *
 * Cmd on macOS and Ctrl elsewhere, matching Electron's own View menu. On macOS
 * Ctrl+= is NOT a zoom: it is a key a terminal program may want, and taking it
 * would break that program for the sake of a second shortcut.
 *
 * Alt combinations are left alone for the same reason — Alt+Ctrl+- is bound in
 * some agent TUIs.
 */
export function zoomShortcut(input: KeyInput, platform: NodeJS.Platform): ZoomDirection | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  const modifier = platform === 'darwin' ? input.meta : input.control;
  if (!modifier) return null;
  /*
   * By character first, then by PHYSICAL key. Electron's own View menu matches
   * accelerators by keycode, so on AZERTY Ctrl+(à/0) still reached its "Actual
   * Size" and reset the zoom without storing it; matching `code` too keeps the
   * shortcut and the stored value in step on every layout.
   *
   * NOT '_'. xterm sends 0x1F only for Ctrl+_ — undo in readline, zsh, emacs
   * and the agent TUIs in these panes — and Electron's default menu never took
   * it, so claiming it here would break a key people use for a second way to
   * zoom out. '+' was already the menu's (CommandOrControl+Plus).
   */
  if (input.key === '=' || input.key === '+' || input.code === 'Equal' || input.code === 'NumpadAdd') return 'in';
  if (input.key === '-' || input.code === 'Minus' || input.code === 'NumpadSubtract') {
    // Shift+Ctrl+Minus IS Ctrl+_ on US layouts: leave it to the terminal.
    return input.shift ? null : 'out';
  }
  if (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0') return 'reset';
  return null;
}

/** The scale after one press, inside the range and free of float drift. */
export function stepUiScale(current: number, direction: ZoomDirection): number {
  if (direction === 'reset') return 1;
  const next = current + (direction === 'in' ? UI_SCALE_STEP : -UI_SCALE_STEP);
  return toTenths(Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, next)));
}
