/**
 * Where the split divider may sit (b014cc86, corrected in 7a717cb8).
 *
 * IT USED TO STOP AT `PANE_FLOOR_PX` - 592px, the width a terminal wants - and
 * that turned out to be the same mistake as the width gate, one layer down. On
 * a 1440 window the row is 1216px, so the allowed range was 592/1216 = 0.487 to
 * 0.513: the divider could move about 32px in total. Dragging left did nothing
 * visible, which read as "the left side never changes", and the person pulling
 * the boundary was being refused by arithmetic rather than told about it.
 *
 * A limit you are actively expressing with the pointer is not a gate on whether
 * you may start - but it is still a limit, and this one had no basis: what a
 * narrow pane costs (wrapped lines) is now SAID, by `layoutPanes().narrow`, in
 * the header. So the floor here is only what keeps the pane real and the
 * divider grabbable.
 *
 * Kept as pure arithmetic because the test environment has no layout - jsdom's
 * getBoundingClientRect is always zero, so a drag cannot be exercised through
 * the DOM. The bounds live in the arithmetic, so the arithmetic is what the
 * tests pin.
 */

/** Default split, and the answer whenever the extent cannot be trusted. */
export const DEFAULT_SPLIT_RATIO = 0.5;

/**
 * The least a pane may be dragged to: enough to see, and to grab the divider.
 *
 * Deliberately NOT the 80-column width. A pane at 120px is unusable as a
 * terminal and perfectly fine as a thing somebody is deliberately collapsing;
 * the header says it is narrow, which is the honest answer.
 */
export const MIN_PANE_PX = 120;

/**
 * The ratios the divider may take in this extent.
 *
 * When two minimums do not fit, the range would invert (min above max) and the
 * divider would jump; centred is the only stable answer.
 */
export function splitRatioBounds(
  extentPx: number,
  floorPx: number = MIN_PANE_PX,
): { readonly min: number; readonly max: number } {
  if (!Number.isFinite(extentPx) || extentPx <= 0) {
    return { min: DEFAULT_SPLIT_RATIO, max: DEFAULT_SPLIT_RATIO };
  }
  const min = floorPx / extentPx;
  if (min >= 0.5) return { min: DEFAULT_SPLIT_RATIO, max: DEFAULT_SPLIT_RATIO };
  return { min, max: 1 - min };
}

/** A ratio the divider is allowed to take, given the extent it sits in. */
export function clampSplitRatio(
  ratio: number,
  extentPx: number,
  floorPx: number = MIN_PANE_PX,
): number {
  const { min, max } = splitRatioBounds(extentPx, floorPx);
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO;
  return Math.min(max, Math.max(min, ratio));
}

/** The ratio a pointer asks for, on whichever axis it was read. */
export function splitRatioAt(
  pointer: number,
  start: number,
  extentPx: number,
  floorPx: number = MIN_PANE_PX,
): number {
  if (!Number.isFinite(extentPx) || extentPx <= 0) return DEFAULT_SPLIT_RATIO;
  return clampSplitRatio((pointer - start) / extentPx, extentPx, floorPx);
}
