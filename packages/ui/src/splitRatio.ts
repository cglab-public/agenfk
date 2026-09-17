/**
 * Where the split divider may sit (b014cc86).
 *
 * The rule is a floor, not a preference: a pane below `PANE_FLOOR_PX` is not a
 * smaller terminal, it is one that wraps every line. So the divider STOPS at
 * the floor instead of pushing the other pane under it.
 *
 * Kept as pure arithmetic because the test environment has no layout - jsdom's
 * getBoundingClientRect is always zero, so a drag cannot be exercised through
 * the DOM. The floor lives in the arithmetic, so the arithmetic is what the
 * tests pin.
 */
import { PANE_FLOOR_PX } from './splitAvailability';

/** Default split, and the answer whenever the width cannot be trusted. */
export const DEFAULT_SPLIT_RATIO = 0.5;

/**
 * The ratios the divider may take in this row: both panes keep their floor.
 *
 * When two floors do not fit, the range would invert (min above max) and the
 * divider would jump; centred is the only stable answer, and the split control
 * is already disabled in that state.
 */
export function splitRatioBounds(
  rowWidthPx: number,
  floorPx: number = PANE_FLOOR_PX,
): { readonly min: number; readonly max: number } {
  if (!Number.isFinite(rowWidthPx) || rowWidthPx <= 0) {
    return { min: DEFAULT_SPLIT_RATIO, max: DEFAULT_SPLIT_RATIO };
  }
  const min = floorPx / rowWidthPx;
  if (min >= 0.5) return { min: DEFAULT_SPLIT_RATIO, max: DEFAULT_SPLIT_RATIO };
  return { min, max: 1 - min };
}

/** A ratio the divider is allowed to take, given the row it sits in. */
export function clampSplitRatio(
  ratio: number,
  rowWidthPx: number,
  floorPx: number = PANE_FLOOR_PX,
): number {
  const { min, max } = splitRatioBounds(rowWidthPx, floorPx);
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO;
  return Math.min(max, Math.max(min, ratio));
}

/** The ratio a pointer at `pointerX` asks for, floored the same way. */
export function splitRatioAt(
  pointerX: number,
  rowLeft: number,
  rowWidthPx: number,
  floorPx: number = PANE_FLOOR_PX,
): number {
  if (!Number.isFinite(rowWidthPx) || rowWidthPx <= 0) return DEFAULT_SPLIT_RATIO;
  return clampSplitRatio((pointerX - rowLeft) / rowWidthPx, rowWidthPx, floorPx);
}
