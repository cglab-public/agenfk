/**
 * How wide the sidebar may be (107eb297).
 *
 * Two fixed numbers before this: 224 open, 40 collapsed. The request was to
 * drag the edge, with today's width as the floor and some ceiling above it.
 *
 * THE CEILING IS NOT A NUMBER, IT IS A SUBTRACTION, and that is the whole
 * reason this is a module rather than two constants. The sidebar takes room
 * from the terminal, and a terminal pane below 592 px is unusable - 576 px of
 * glyph plus the scrollbar, measured in splitAvailability rather than guessed.
 * The Electron window can be as narrow as 960. So a generous fixed maximum
 * would let somebody drag the sidebar until the terminal is useless on a small
 * window, with nothing on screen explaining why their agent's output started
 * wrapping wrong.
 *
 * The ceiling therefore falls as the window narrows: on 960 it is 368, not the
 * 420 anybody would have typed.
 *
 * WHY THE FLOOR IS TODAY'S WIDTH. It was asked for that way, and it is also the
 * width every string in the tree was truncated against. Letting the sidebar go
 * narrower would re-open a layout that was tuned once and has tests about it.
 */

import { PANE_FLOOR_PX } from './splitAvailability';

/** Today's width, and the narrowest the open sidebar may be. */
export const SIDEBAR_MIN_PX = 224;

/**
 * The widest anybody should want, before the window is taken into account.
 *
 * A taste ceiling, not a measurement: past this the sidebar stops being a rail
 * and starts being a second panel, and the board it takes room from is the
 * thing people came for.
 */
export const SIDEBAR_MAX_PX = 420;

/** The rail. Not resizable: collapsing is a different action from resizing. */
export const SIDEBAR_COLLAPSED_PX = 40;

/**
 * The widest the sidebar may be right now, given the window.
 *
 * Returns at least the floor. A window so narrow that the subtraction goes
 * below 224 is one where the sidebar cannot be resized at all, and reporting a
 * maximum UNDER the minimum would make every clamp below nonsense - better to
 * collapse the range to a point and let the caller see there is nothing to
 * drag.
 */
export function maxSidebarWidth(windowWidthPx: number): number {
  if (!Number.isFinite(windowWidthPx) || windowWidthPx <= 0) return SIDEBAR_MIN_PX;
  const roomForTheTerminal = windowWidthPx - PANE_FLOOR_PX;
  return Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, roomForTheTerminal));
}

/**
 * The width to actually use for a requested one.
 *
 * Every path goes through here - the drag, the stored value read at startup,
 * and a window resize that has just made the old width illegal. One function,
 * because a stored 400 px on a laptop, reopened on a 960 px window, is the same
 * question as a drag and must not get a different answer.
 */
export function clampSidebarWidth(requestedPx: number, windowWidthPx: number): number {
  const max = maxSidebarWidth(windowWidthPx);
  // A missing or unparseable stored width is not a request for the narrowest
  // possible sidebar, it is an absence: answer with the default.
  if (!Number.isFinite(requestedPx)) return SIDEBAR_MIN_PX;
  return Math.round(Math.max(SIDEBAR_MIN_PX, Math.min(max, requestedPx)));
}

/**
 * Whether there is anything to drag.
 *
 * False on a window too narrow for the sidebar to grow at all. The handle is
 * then hidden rather than present-and-inert: a control that moves nothing when
 * you pull it reads as a broken app, while an absent one reads as a narrow
 * window, which is what it is.
 */
export function sidebarIsResizable(windowWidthPx: number): boolean {
  return maxSidebarWidth(windowWidthPx) > SIDEBAR_MIN_PX;
}
