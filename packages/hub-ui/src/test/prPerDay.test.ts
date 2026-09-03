/**
 * TDD for the PR Overview "Per developer, per day" redesign (CGLAB-8):
 *  - month band header row (month name spanning its day columns)
 *  - per-column weekday abbreviation + day number, weekend + today flags
 *  - per-developer contribution percentages (PR count share + size-point share)
 *  - cell tooltip text contract (every cell, including 0-count, gets a tooltip)
 *
 * Helpers live in ../prPerDay so they stay unit-testable without a DOM,
 * mirroring ../prOverview.
 */
import { describe, it, expect } from 'vitest';
import { buildMonthBands, dayHeaderInfo, contributionPcts, cellTooltip, placeTooltip, estimateTooltipSize } from '../prPerDay';

describe('buildMonthBands', () => {
  it('spans each month name across exactly its day columns', () => {
    // Jun 28 → Jul 14 2026: 3 June days, 14 July days.
    const axis = [
      '2026-06-28', '2026-06-29', '2026-06-30',
      '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05',
      '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10',
      '2026-07-11', '2026-07-12', '2026-07-13', '2026-07-14',
    ];
    expect(buildMonthBands(axis)).toEqual([
      { label: 'June', span: 3 },
      { label: 'July', span: 14 },
    ]);
  });

  it('returns a single band when the window sits inside one month', () => {
    expect(buildMonthBands(['2026-05-03', '2026-05-04', '2026-05-05'])).toEqual([
      { label: 'May', span: 3 },
    ]);
  });

  it('disambiguates the same month across years (90d windows crossing new year)', () => {
    const bands = buildMonthBands(['2025-12-31', '2026-01-01']);
    expect(bands).toHaveLength(2);
    expect(bands[0].span).toBe(1);
    expect(bands[1].span).toBe(1);
    expect(bands[0].label).not.toBe(bands[1].label); // e.g. December vs January
  });

  it('returns [] for an empty axis', () => {
    expect(buildMonthBands([])).toEqual([]);
  });
});

describe('dayHeaderInfo', () => {
  it('gives the weekday abbreviation and day number (UTC)', () => {
    // 2026-06-29 is a Monday.
    expect(dayHeaderInfo('2026-06-29')).toMatchObject({ weekday: 'Mon', dayNum: 29 });
    // 2026-07-01 is a Wednesday.
    expect(dayHeaderInfo('2026-07-01')).toMatchObject({ weekday: 'Wed', dayNum: 1 });
  });

  it('flags weekends', () => {
    expect(dayHeaderInfo('2026-06-28').isWeekend).toBe(true);  // Sunday
    expect(dayHeaderInfo('2026-07-04').isWeekend).toBe(true);  // Saturday
    expect(dayHeaderInfo('2026-07-01').isWeekend).toBe(false); // Wednesday
  });

  it('flags today only when the day matches the reference date', () => {
    expect(dayHeaderInfo('2026-07-14', '2026-07-14').isToday).toBe(true);
    expect(dayHeaderInfo('2026-07-13', '2026-07-14').isToday).toBe(false);
  });
});

describe('contributionPcts', () => {
  it('computes rounded shares of PR count and size points', () => {
    expect(contributionPcts({ prs: 34, sizePoints: 190 }, { prs: 81, sizePoints: 500 }))
      .toEqual({ prPct: 42, ptsPct: 38 });
  });

  it('returns 0 shares when the totals are empty (no division by zero)', () => {
    expect(contributionPcts({ prs: 0, sizePoints: 0 }, { prs: 0, sizePoints: 0 }))
      .toEqual({ prPct: 0, ptsPct: 0 });
  });

  it('a single developer owns 100% of both', () => {
    expect(contributionPcts({ prs: 7, sizePoints: 30 }, { prs: 7, sizePoints: 30 }))
      .toEqual({ prPct: 100, ptsPct: 100 });
  });
});

describe('cellTooltip', () => {
  it('formats "<dev> · <weekday> <date>: N PRs"', () => {
    expect(cellTooltip('danielp@cglab.com', '2026-06-29', 2))
      .toBe('danielp@cglab.com · Mon 2026-06-29: 2 PRs');
  });

  it('uses the singular for exactly one PR', () => {
    expect(cellTooltip('danielp@cglab.com', '2026-06-30', 1))
      .toBe('danielp@cglab.com · Tue 2026-06-30: 1 PR');
  });

  it('still produces a tooltip for empty cells (0 PRs) — the bug being fixed', () => {
    expect(cellTooltip('danielp@cglab.com', '2026-06-28', 0))
      .toBe('danielp@cglab.com · Sun 2026-06-28: 0 PRs');
  });
});

describe('estimateTooltipSize', () => {
  it('estimates a single-line box that grows with the text', () => {
    const a = estimateTooltipSize('alice · Mon 2026-06-29: 2 PRs');
    const b = estimateTooltipSize('a@long-org.example.com · Mon 2026-06-29: 2 PRs');
    expect(a.width).toBeGreaterThan(0);
    expect(b.width).toBeGreaterThan(a.width);
    // single-line tooltip: height does not depend on the text
    expect(b.height).toBe(a.height);
  });
});

// CGLAB-131 — the tooltip was rendered INSIDE the backdrop-blur card section,
// so its viewport coordinates were interpreted against the section's box
// (offset = "far away") and its z-50 lost to the later cards (z-order).
// placeTooltip() is the pure placement contract the component must honour:
// the returned {x, y} are VIEWPORT coordinates for a tooltip rendered outside
// any filtered/stacking ancestor, centred horizontally on x, and occupying
// [y - h, y] when `below` is false (anchored above) or [y, y + h] when true.
describe('placeTooltip', () => {
  const cell = { left: 500, top: 300, width: 20, height: 20 };
  const text = 'alice@acme.com · Mon 2026-06-29: 2 PRs';

  it('anchors above the cell, centred on it, when there is room', () => {
    const p = placeTooltip(cell, text, 1200);
    const { width: w, height: h } = estimateTooltipSize(text);
    expect(p.below).toBe(false);
    expect(p.x).toBe(510); // cell centre (500 + 20/2)
    expect(p.y).toBe(294); // 6px gap above the cell top
    // the tooltip box [y-h, y] × [x-w/2, x+w/2] must fit the viewport
    expect(p.y - h).toBeGreaterThanOrEqual(0);
    expect(p.x - w / 2).toBeGreaterThanOrEqual(0);
    expect(p.x + w / 2).toBeLessThanOrEqual(1200);
  });

  it('stays above when the box would land exactly on the margin', () => {
    // top of the box = cell.top - gap - h must equal the margin, not go past it
    const { height: h } = estimateTooltipSize(text);
    const c = { ...cell, top: h + 6 + 8 };
    const p = placeTooltip(c, text, 1200);
    expect(p.below).toBe(false);
    expect(p.y - h).toBe(8);
  });

  it('flips below the cell when there is no room above', () => {
    const p = placeTooltip({ ...cell, top: 10 }, text, 1200);
    expect(p.below).toBe(true);
    // anchored 6px below the cell bottom, centred unchanged
    expect(p.x).toBe(510);
    expect(p.y).toBe(36); // 10 + 20 + 6
  });

  it('clamps to the left edge when the cell sits near it', () => {
    const long = 'x'.repeat(100);
    const { width: w } = estimateTooltipSize(long);
    const p = placeTooltip({ left: 2, top: 300, width: 20, height: 20 }, long, 1200);
    expect(p.below).toBe(false);
    // tooltip left edge stays at least the margin inside the viewport
    expect(p.x - w / 2).toBeGreaterThanOrEqual(8);
    expect(p.x - w / 2).toBe(8); // pinned, not centred
  });

  it('clamps to the right edge when the cell sits near it', () => {
    const long = 'x'.repeat(100);
    const { width: w } = estimateTooltipSize(long);
    const p = placeTooltip({ left: 1195, top: 300, width: 20, height: 20 }, long, 1200);
    // tooltip right edge stays at least the margin inside the viewport
    expect(p.x + w / 2).toBeLessThanOrEqual(1192);
    expect(p.x + w / 2).toBe(1192); // pinned, not centred
  });

  it('does not blow up when the tooltip is wider than the viewport', () => {
    const huge = 'x'.repeat(5000);
    const p = placeTooltip({ left: 500, top: 300, width: 20, height: 20 }, huge, 800);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });
});
