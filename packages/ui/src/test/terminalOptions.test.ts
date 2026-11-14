/**
 * What a terminal costs, decided rather than inherited (CGLAB 5963ea34).
 *
 * The pane created its terminal with three options — none of them
 * `scrollback` — so it ran on xterm's default of 1000 lines. That is not
 * wrong, and this does not change it. What was wrong is that nothing in the
 * codebase acknowledged the per-terminal cost while simultaneously permitting
 * thirty of them.
 *
 * A buffer line is a `Uint32Array` of `cols * 3` — twelve bytes a cell — so
 * the normal buffer is `12 * cols * (scrollback + rows)`: roughly 1.5 MB per
 * terminal at 120 columns, 2.5 MB at 200, 3.2 MB at 250. Times the app's own
 * cap of thirty sessions, that is 45 to 95 MB of buffer nobody had counted.
 *
 * These tests exist so the number cannot drift back to being an accident.
 */
import { describe, it, expect } from 'vitest';
import { TERMINAL_OPTIONS, SCROLLBACK_LINES, bufferBytes } from '../terminalOptions';

describe('the scrollback', () => {
  it('is set explicitly, not left to the library default', () => {
    /*
     * THE test, and it is about provenance rather than the value. xterm's
     * default is also 1000, so nothing observable changes — which is exactly
     * why this needs pinning: deleting the option would look harmless, behave
     * identically today, and quietly return the thirty-terminal cost to being
     * something nobody chose.
     */
    expect(TERMINAL_OPTIONS.scrollback).toBeDefined();
    expect(TERMINAL_OPTIONS.scrollback).toBe(SCROLLBACK_LINES);
  });

  it('keeps enough history to read back a build', () => {
    // The floor is a product fact, not a memory one: an agent's `npm test`
    // output is hundreds of lines, and a terminal you cannot scroll back
    // through is a terminal that lost the answer.
    expect(SCROLLBACK_LINES).toBeGreaterThanOrEqual(1000);
  });

  it('keeps ONE terminal under a stated ceiling', () => {
    /*
     * Per terminal, deliberately, because that is what this module decides.
     * The session cap lives in the desktop package and importing it here would
     * recreate the two-halves-in-two-files problem this batch just removed
     * elsewhere.
     *
     * The multiplication is still the reason the ceiling exists: at 200
     * columns this is ~2.5 MB, and the app permits thirty sessions in a
     * window, so the real figure is ~75 MB. Raising the scrollback later
     * fails here first, rather than in a memory graph six months on.
     */
    expect(bufferBytes(200, 50)).toBeLessThan(4 * 1024 * 1024);
  });
});

describe('the cost function', () => {
  it('counts twelve bytes a cell, which is what a buffer line is', () => {
    // `CELL_SIZE = 3` in a Uint32Array. Stated as a test so the estimate
    // cannot quietly become a guess.
    expect(bufferBytes(100, 0)).toBe(12 * 100 * SCROLLBACK_LINES);
  });

  it('counts the visible rows as well as the history', () => {
    expect(bufferBytes(100, 50) - bufferBytes(100, 0)).toBe(12 * 100 * 50);
  });

  it('grows with width, which is the term people forget', () => {
    // Doubling the window width doubles the buffer. A maximised terminal on a
    // wide display costs twice what the estimate assumes.
    expect(bufferBytes(240, 50)).toBe(bufferBytes(120, 50) * 2);
  });
});

describe('the options the pane actually uses', () => {
  it('still converts line endings', () => {
    // A pty writes bare LF; without this every line stair-steps. Asserted
    // because this object is now edited by people thinking about memory, and
    // it would be an easy thing to lose in that frame of mind.
    expect(TERMINAL_OPTIONS.convertEol).toBe(true);
  });

  it('keeps the cursor and the size the pane was built around', () => {
    expect(TERMINAL_OPTIONS.cursorBlink).toBe(true);
    expect(TERMINAL_OPTIONS.fontSize).toBe(12);
  });
});
