/**
 * How wide the sidebar may be (107eb297).
 *
 * THE TEST THAT MATTERS IS THE CEILING ON A SMALL WINDOW. A fixed maximum is
 * what anybody writes first, and it lets somebody drag the sidebar until the
 * terminal is below its usable floor - with no message, and a symptom that
 * shows up as the agent's output wrapping at the wrong column rather than as
 * anything about the sidebar.
 */
import { describe, it, expect } from 'vitest';
import {
  clampSidebarWidth,
  maxSidebarWidth,
  sidebarIsResizable,
  SIDEBAR_MIN_PX,
  SIDEBAR_MAX_PX,
} from '../sidebarWidth';
import { PANE_FLOOR_PX } from '../splitAvailability';

/** The narrowest the Electron window is allowed to be (main/index.ts minWidth). */
const WINDOW_MIN = 960;
const ROOMY = 1920;

describe('the ceiling', () => {
  it('leaves the terminal its floor on a narrow window', () => {
    /*
     * THE test. At the window's own minimum the answer is NOT the taste
     * ceiling: 960 - 592 = 368. A fixed 420 would eat 52 px the terminal needs,
     * and the person doing the dragging has no way to know that.
     */
    expect(maxSidebarWidth(WINDOW_MIN)).toBe(WINDOW_MIN - PANE_FLOOR_PX);
    expect(maxSidebarWidth(WINDOW_MIN)).toBeLessThan(SIDEBAR_MAX_PX);
  });

  it('stops at the taste ceiling once the window is wide enough', () => {
    // Past a point the constraint stops being the terminal and starts being
    // that a rail this wide is a second panel.
    expect(maxSidebarWidth(ROOMY)).toBe(SIDEBAR_MAX_PX);
  });

  it('never reports a maximum below the minimum', () => {
    /*
     * A window narrow enough to make the subtraction negative would otherwise
     * produce max < min, and every clamp built on it becomes nonsense. The
     * range collapses to a point instead, which is a state the caller can read.
     */
    for (const w of [700, 592, 400, 1, 0, -100, NaN]) {
      expect(maxSidebarWidth(w), `window ${w}`).toBeGreaterThanOrEqual(SIDEBAR_MIN_PX);
    }
  });

  it('is derived from the measured pane floor, not from a copy of it', () => {
    // If the floor is ever retuned, this ceiling has to move with it. Asserted
    // as a relationship so the two cannot drift.
    const w = 1000;
    expect(maxSidebarWidth(w)).toBe(Math.min(SIDEBAR_MAX_PX, w - PANE_FLOOR_PX));
  });
});

describe('clamping a requested width', () => {
  it('keeps a width that is in range', () => {
    expect(clampSidebarWidth(300, ROOMY)).toBe(300);
  });

  it('refuses to go below today\'s width', () => {
    // The floor was asked for, and it is also the width every string in the
    // tree was truncated against.
    expect(clampSidebarWidth(120, ROOMY)).toBe(SIDEBAR_MIN_PX);
    expect(clampSidebarWidth(0, ROOMY)).toBe(SIDEBAR_MIN_PX);
    expect(clampSidebarWidth(-50, ROOMY)).toBe(SIDEBAR_MIN_PX);
  });

  it('pulls a stored width back in when the window has since shrunk', () => {
    /*
     * The case that only happens to real people: 400 px dragged on a big
     * monitor, reopened on a 960 px window. It is the same question as a drag
     * and must not get a different answer, which is why both go through here.
     */
    expect(clampSidebarWidth(400, WINDOW_MIN)).toBe(WINDOW_MIN - PANE_FLOOR_PX);
  });

  it('treats an unreadable stored value as absence, not as zero', () => {
    // localStorage hands back strings. `Number('')` is 0 and `Number('abc')` is
    // NaN, and answering the narrowest possible sidebar to either would make a
    // corrupt preference look like a deliberate one.
    expect(clampSidebarWidth(NaN, ROOMY)).toBe(SIDEBAR_MIN_PX);
    expect(clampSidebarWidth(Infinity, ROOMY)).toBe(SIDEBAR_MIN_PX);
  });

  it('returns whole pixels, because a fractional width blurs a 1px border', () => {
    const out = clampSidebarWidth(300.6, ROOMY);
    expect(Number.isInteger(out)).toBe(true);
  });
});

describe('whether there is anything to drag', () => {
  it('says no when the window leaves no room to grow', () => {
    /*
     * The handle is hidden rather than present-and-inert. A control that moves
     * nothing when you pull it reads as a broken app; an absent one reads as a
     * narrow window, which is what it is.
     */
    expect(sidebarIsResizable(700)).toBe(false);
    expect(sidebarIsResizable(PANE_FLOOR_PX + SIDEBAR_MIN_PX)).toBe(false);
  });

  it('says yes with one pixel of room', () => {
    // The boundary, stated: off by one here hides the handle on a window where
    // dragging genuinely works.
    expect(sidebarIsResizable(PANE_FLOOR_PX + SIDEBAR_MIN_PX + 1)).toBe(true);
  });

  it('says yes on an ordinary window', () => {
    expect(sidebarIsResizable(WINDOW_MIN)).toBe(true);
    expect(sidebarIsResizable(ROOMY)).toBe(true);
  });
});
