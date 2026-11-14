/**
 * Where the split divider may sit (b014cc86).
 *
 * The rule is a floor, not a preference: a pane below MIN_PANE_PX is not a
 * smaller terminal, it is one that wraps every line. So the divider STOPS at
 * the floor instead of pushing the other pane under it.
 *
 * Kept as a pure function because the test environment has no layout - jsdom's
 * getBoundingClientRect is always zero, so a drag cannot be exercised through
 * the DOM. The arithmetic is where the floor lives, so the arithmetic is what
 * the tests pin.
 */
import { describe, it, expect } from 'vitest';
import { clampSplitRatio, splitRatioBounds, splitRatioAt, MIN_PANE_PX } from '../splitRatio';

describe('where the divider may sit', () => {
  it('leaves a comfortable ratio alone', () => {
    // On a wide enough row both floors fit, so the ratio passes through; 0.6
    // needs width >= floor / (1 - 0.6) = 1480.
    expect(clampSplitRatio(0.5, 2000)).toBeCloseTo(0.5, 5);
    expect(clampSplitRatio(0.6, 2000)).toBeCloseTo(0.6, 5);
  });

  it('stops only where the pane would stop existing', () => {
    /*
     * The floor used to be PANE_FLOOR_PX (592px, the 80-column width), which on
     * a 1216px row left the divider a ~32px range - dragging left did nothing
     * visible and read as 'the left side never changes'. What a narrow pane
     * COSTS is said in the header now; this only keeps it real and grabbable.
     */
    expect(clampSplitRatio(0.01, 1200)).toBeCloseTo(MIN_PANE_PX / 1200, 5);
    expect(clampSplitRatio(0.99, 1200)).toBeCloseTo(1 - MIN_PANE_PX / 1200, 5);
    // And the range is wide: this is the bug the old floor caused.
    const { min, max } = splitRatioBounds(1216);
    expect(max - min, 'the divider can barely move').toBeGreaterThan(0.7);
  });

  it('stays centred when the window cannot fit two floors at all', () => {
    // Otherwise the clamp would invert - min above max - and the divider would
    // jump. The split control is already disabled in this state.
    expect(clampSplitRatio(0.1, 2 * MIN_PANE_PX - 10)).toBe(0.5);
    expect(clampSplitRatio(0.9, 2 * MIN_PANE_PX - 10)).toBe(0.5);
  });

  it('falls back to centred on a width it cannot trust', () => {
    expect(clampSplitRatio(0.3, 0)).toBe(0.5);
    expect(clampSplitRatio(0.3, Number.NaN)).toBe(0.5);
    expect(clampSplitRatio(Number.NaN, 1200)).toBe(0.5);
  });
});

describe('the range the floor allows', () => {
  it('names both extremes', () => {
    const b = splitRatioBounds(1200);
    expect(b.min).toBeCloseTo(MIN_PANE_PX / 1200, 5);
    expect(b.max).toBeCloseTo(1 - MIN_PANE_PX / 1200, 5);
  });

  it('collapses to centred when two floors do not fit', () => {
    // The range would invert, so there is no range - and the split control is
    // disabled in this state anyway.
    expect(splitRatioBounds(2 * MIN_PANE_PX - 10)).toEqual({ min: 0.5, max: 0.5 });
  });
});

describe('where the pointer is, as a ratio', () => {
  it('reads the pointer position across the row', () => {
    expect(splitRatioAt(100 + 1280, 100, 2560)).toBeCloseTo(0.5, 5);
    expect(splitRatioAt(100 + 1920, 100, 2560)).toBeCloseTo(0.75, 5);
  });

  it('applies the same floor at the edges', () => {
    // Pointer at the very left: floored, not 0.
    expect(splitRatioAt(100, 100, 1200)).toBeCloseTo(MIN_PANE_PX / 1200, 5);
    expect(splitRatioAt(100 + 1200, 100, 1200)).toBeCloseTo(1 - MIN_PANE_PX / 1200, 5);
  });
});
