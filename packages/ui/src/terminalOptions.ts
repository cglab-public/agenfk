/**
 * What one terminal costs, decided rather than inherited (CGLAB 5963ea34).
 *
 * The pane built its terminal with three options — `convertEol`, `fontSize`,
 * `cursorBlink` — and no `scrollback`, so it ran on xterm's default of 1000
 * lines. The number was never wrong. What was wrong is that nothing here
 * acknowledged the cost while the app simultaneously permitted thirty
 * terminals in a window and kept every pane mounted.
 *
 * THE ARITHMETIC, because an estimate nobody writes down is a guess. An xterm
 * buffer line is a `Uint32Array` of `cols * CELL_SIZE`, and `CELL_SIZE` is 3 —
 * twelve bytes a cell. So the normal buffer is `12 * cols * (scrollback +
 * rows)`:
 *
 *     120 cols  ~1.5 MB per terminal   ~45 MB across thirty
 *     200 cols  ~2.5 MB per terminal   ~75 MB across thirty
 *     250 cols  ~3.2 MB per terminal   ~95 MB across thirty
 *
 * Plus per-line object overhead, the alternate buffer, and the extended
 * attribute maps for any line carrying wide characters — which agent TUIs draw
 * constantly, in box-drawing and Braille.
 *
 * The value stays at 1000. Changing how far a person can scroll back is a
 * product decision, and this file's job is to make the cost a decision in the
 * code, not to quietly take that one. The floor matters too: an agent's test
 * run is hundreds of lines, and a terminal you cannot scroll back through is a
 * terminal that lost the answer.
 *
 * Not addressed here, and worth its own card: only `@xterm/addon-fit` is
 * installed, so xterm 5.5 falls back to the DOM renderer — a `<span>` per
 * styled run per visible row, across panes that are hidden but never
 * unmounted. Switching renderers adds a dependency and changes the drawing
 * path, with its own risk.
 */
import type { ITerminalOptions } from '@xterm/xterm';

/**
 * How many lines of history one terminal keeps.
 *
 * Explicit, and that is the whole point of this module: xterm's default is
 * also 1000, so removing this line would look harmless, behave identically
 * today, and return the thirty-terminal cost to being nobody's decision.
 */
export const SCROLLBACK_LINES = 1000;

/** Twelve bytes a cell: a buffer line is a Uint32Array of `cols * 3`. */
const BYTES_PER_CELL = 12;

/**
 * Roughly what one terminal's normal buffer holds, in bytes.
 *
 * Here rather than in a comment so the estimate can be asserted. Width is the
 * term people forget — a maximised terminal on a wide display costs twice what
 * a narrow one does, for the same scrollback.
 */
export function bufferBytes(cols: number, rows: number): number {
  return BYTES_PER_CELL * cols * (SCROLLBACK_LINES + rows);
}

/** The options every terminal in this app is built with. */
export const TERMINAL_OPTIONS: ITerminalOptions = {
  // A pty writes bare LF. Without this every line stair-steps.
  convertEol: true,
  fontSize: 12,
  cursorBlink: true,
  scrollback: SCROLLBACK_LINES,
};
