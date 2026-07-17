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
import { buildMonthBands, dayHeaderInfo, contributionPcts, cellTooltip } from '../prPerDay';

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
