/**
 * TDD for the PR Overview "PR volume by size" granularity (CGLAB-133):
 *  - selectable daily / weekly / monthly bucketing of the per-day byDay data
 *    returned by /v1/prs/overview (pure client-side re-bucketing)
 *  - weekly = ISO weeks (Mon–Sun), monthly = calendar months
 *  - stats row under the chart: total, average (per bucket in range, incl.
 *    empty buckets), max (+ label of the max bucket)
 *
 * Helpers live in ../prVolumeGranularity so they stay unit-testable without a
 * DOM, mirroring ../prOverview and ../prPerDay.
 */
import { describe, it, expect } from 'vitest';
import {
  type Granularity,
  type DayPoint,
  type SizeDist,
  weekStartOf,
  monthKeyOf,
  buildVolumeSeries,
  edgeCoverage,
} from '../prVolumeGranularity';

type SizeKey = DayPoint['sizes'] extends Record<infer K, number> ? K : never;
type Dev = { user_key: string; count: number };

/** Build one day point from partial size counts (+ optional per-size devs). */
function day(dayStr: string, sizes: Partial<Record<SizeKey, number>>, devBySize?: Record<string, Dev[]>): DayPoint {
  const full: SizeDist = { xs: 0, s: 0, m: 0, l: 0, xl: 0, ...sizes };
  const dev: Record<string, Dev[]> = { xs: [], s: [], m: [], l: [], xl: [] };
  if (devBySize) for (const k of Object.keys(devBySize)) dev[k] = devBySize[k];
  return {
    day: dayStr,
    sizes: full,
    total: (Object.values(full) as number[]).reduce((a, b) => a + b, 0),
    devBySize: dev as DayPoint['devBySize'],
  };
}

/** Every UTC day in [from, to] inclusive. */
function axis(from: string, to: string): string[] {
  const out: string[] = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

describe('weekStartOf', () => {
  it('returns the date itself for a Monday', () => {
    // 2026-06-01 is a Monday.
    expect(weekStartOf('2026-06-01')).toBe('2026-06-01');
  });

  it('returns the Monday of the ISO week for mid-week days', () => {
    expect(weekStartOf('2026-06-03')).toBe('2026-06-01'); // Wednesday
    expect(weekStartOf('2026-06-05')).toBe('2026-06-01'); // Friday
  });

  it('keeps a Sunday in the week that started on Monday', () => {
    // 2026-06-07 is a Sunday of the week of 2026-06-01.
    expect(weekStartOf('2026-06-07')).toBe('2026-06-01');
    // 2026-06-08 is the next Monday.
    expect(weekStartOf('2026-06-08')).toBe('2026-06-08');
  });
});

describe('monthKeyOf', () => {
  it('returns YYYY-MM', () => {
    expect(monthKeyOf('2026-06-15')).toBe('2026-06');
    expect(monthKeyOf('2026-12-31')).toBe('2026-12');
  });
});

describe('buildVolumeSeries — daily', () => {
  it('is 1:1 with the axis, including empty days', () => {
    const days = axis('2026-06-01', '2026-06-04');
    const byDay = [day('2026-06-01', { xs: 2, m: 1 })];
    const { buckets } = buildVolumeSeries(byDay, days, 'daily', null);
    expect(buckets).toHaveLength(4);
    expect(buckets[0]).toMatchObject({ key: '2026-06-01', label: '06-01', total: 3, rangeLabel: '2026-06-01' });
    expect(buckets[0].sizes).toEqual({ xs: 2, s: 0, m: 1, l: 0, xl: 0 });
    // Empty day: zero sizes, empty day list.
    expect(buckets[1]).toMatchObject({ key: '2026-06-02', total: 0 });
    expect(buckets[1].sizes).toEqual({ xs: 0, s: 0, m: 0, l: 0, xl: 0 });
    expect(buckets[1].days).toEqual([]);
  });

  it('passes the day through in days[] for non-empty buckets', () => {
    const byDay = [day('2026-06-02', { s: 1 })];
    const { buckets } = buildVolumeSeries(byDay, axis('2026-06-01', '2026-06-03'), 'daily', null);
    expect(buckets[1].days).toEqual([{ day: '2026-06-02', sizes: byDay[0].sizes, total: 1 }]);
  });
});

describe('buildVolumeSeries — weekly', () => {
  it('buckets by ISO week when the range is week-aligned', () => {
    // Mon 2026-06-01 → Sun 2026-06-14 = exactly two ISO weeks.
    const days = axis('2026-06-01', '2026-06-14');
    const byDay = [
      day('2026-06-01', { xs: 1 }),
      day('2026-06-07', { m: 2 }),
      day('2026-06-08', { l: 3 }),
    ];
    const { buckets } = buildVolumeSeries(byDay, days, 'weekly', null);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({
      key: '2026-06-01',
      label: '06-01',
      rangeLabel: 'Week of 06-01',
      total: 3,
    });
    expect(buckets[0].sizes).toEqual({ xs: 1, s: 0, m: 2, l: 0, xl: 0 });
    expect(buckets[0].days.map(d => d.day)).toEqual(['2026-06-01', '2026-06-07']);
    expect(buckets[1]).toMatchObject({ key: '2026-06-08', label: '06-08', rangeLabel: 'Week of 06-08', total: 3 });
  });

  it('clamps the first/last bucket to the range while keeping the week identity', () => {
    // Wed 2026-06-03 → Fri 2026-06-12: week of 06-01 contributes 06-03..06-07,
    // week of 06-08 contributes 06-08..06-12.
    const days = axis('2026-06-03', '2026-06-12');
    const byDay = [
      day('2026-06-03', { xs: 1 }),
      day('2026-06-07', { xs: 1 }),
      day('2026-06-08', { m: 1 }),
    ];
    const { buckets } = buildVolumeSeries(byDay, days, 'weekly', null);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ key: '2026-06-01', label: '06-01', total: 2 });
    expect(buckets[0].days.map(d => d.day)).toEqual(['2026-06-03', '2026-06-07']);
    expect(buckets[1]).toMatchObject({ key: '2026-06-08', label: '06-08', total: 1 });
    expect(buckets[1].days.map(d => d.day)).toEqual(['2026-06-08']);
  });

  it('merges devBySize across the bucket\'s days (sums counts, sorted desc)', () => {
    const byDay = [
      day('2026-06-01', { xs: 1, m: 1 }, { xs: [{ user_key: 'a@x.com', count: 1 }], m: [{ user_key: 'b@y.com', count: 1 }] }),
      day('2026-06-03', { xs: 1 }, { xs: [{ user_key: 'a@x.com', count: 1 }] }),
    ];
    const { buckets } = buildVolumeSeries(byDay, axis('2026-06-01', '2026-06-07'), 'weekly', null);
    expect(buckets[0].devBySize.xs).toEqual([{ user_key: 'a@x.com', count: 2 }]);
    expect(buckets[0].devBySize.m).toEqual([{ user_key: 'b@y.com', count: 1 }]);
    // Same-day count ties fall back to user_key order (stable, deterministic).
    const tie = [
      day('2026-06-01', { xs: 2 }, { xs: [{ user_key: 'b@y.com', count: 1 }, { user_key: 'a@x.com', count: 1 }] }),
    ];
    const tieBuckets = buildVolumeSeries(tie, axis('2026-06-01', '2026-06-07'), 'weekly', null).buckets;
    expect(tieBuckets[0].devBySize.xs.map(d => d.user_key)).toEqual(['a@x.com', 'b@y.com']);
  });
});

describe('buildVolumeSeries — monthly', () => {
  it('buckets by calendar month and clamps to the range', () => {
    // Sat 2026-05-30 → Thu 2026-07-02: May (2 days), June (30), July (2).
    const days = axis('2026-05-30', '2026-07-02');
    const byDay = [
      day('2026-05-30', { s: 1 }),
      day('2026-06-15', { m: 4 }),
      day('2026-07-01', { l: 2 }),
    ];
    const { buckets } = buildVolumeSeries(byDay, days, 'monthly', null);
    expect(buckets).toHaveLength(3);
    expect(buckets[0]).toMatchObject({ key: '2026-05', label: 'May 2026', rangeLabel: 'May 2026', total: 1 });
    expect(buckets[1]).toMatchObject({ key: '2026-06', label: 'Jun 2026', total: 4 });
    expect(buckets[1].days.map(d => d.day)).toEqual(['2026-06-15']);
    expect(buckets[2]).toMatchObject({ key: '2026-07', label: 'Jul 2026', total: 2 });
  });

  it('disambiguates the same month across years', () => {
    const days = axis('2025-06-15', '2026-06-15');
    const { buckets } = buildVolumeSeries([], days, 'monthly', null);
    const jun = buckets.filter(b => b.key.endsWith('-06'));
    expect(jun.map(b => b.key)).toEqual(['2025-06', '2026-06']);
    expect(jun[0].label).toBe('Jun 2025');
    expect(jun[1].label).toBe('Jun 2026');
  });
});

describe('buildVolumeSeries — stats', () => {
  it('sums the period total', () => {
    const byDay = [day('2026-06-01', { xs: 2 }), day('2026-06-10', { m: 3 })];
    const { stats } = buildVolumeSeries(byDay, axis('2026-06-01', '2026-06-14'), 'weekly', null);
    expect(stats.total).toBe(5);
  });

  it('averages over ALL buckets in the range, including empty ones', () => {
    // 10 PRs in week 1 of a 2-week range → 5.0 per week (not 10.0).
    const byDay = [day('2026-06-01', { xs: 10 })];
    const { stats } = buildVolumeSeries(byDay, axis('2026-06-01', '2026-06-14'), 'weekly', null);
    expect(stats.average).toBe(5);
  });

  it('returns the exact (unrounded) average', () => {
    // 10 PRs across 3 monthly buckets → 10/3.
    const byDay = [day('2026-06-01', { xs: 10 })];
    const { stats } = buildVolumeSeries(byDay, axis('2026-05-30', '2026-07-02'), 'monthly', null);
    expect(stats.average).toBeCloseTo(10 / 3);
  });

  it('reports the max bucket with its label, earliest bucket on ties', () => {
    const byDay = [
      day('2026-06-01', { m: 4 }),
      day('2026-06-08', { m: 4 }),
      day('2026-06-09', { xs: 5 }),
    ];
    const { stats } = buildVolumeSeries(byDay, axis('2026-06-01', '2026-06-14'), 'weekly', null);
    // Week 1 = 4, week 2 = 4 + 5 = 9 → max is the week-2 TOTAL, not 5.
    expect(stats.max).toBe(9);
    expect(stats.maxLabel).toBe('06-08');
    // Tie: weeks of 06-01 and 06-08 both have 4 → earliest wins.
    const tie = buildVolumeSeries(
      [day('2026-06-01', { m: 4 }), day('2026-06-08', { m: 4 })],
      axis('2026-06-01', '2026-06-14'),
      'weekly',
      null,
    ).stats;
    expect(tie.max).toBe(4);
    expect(tie.maxLabel).toBe('06-01');
  });

  it('labels the monthly max bucket with the month name', () => {
    const byDay = [day('2026-07-01', { l: 7 })];
    const { stats } = buildVolumeSeries(byDay, axis('2026-05-30', '2026-07-02'), 'monthly', null);
    expect(stats.max).toBe(7);
    expect(stats.maxLabel).toBe('Jul 2026');
  });

  it('yields zeroed stats and null maxLabel when there are no PRs', () => {
    const { stats } = buildVolumeSeries([], axis('2026-06-01', '2026-06-14'), 'weekly', null);
    expect(stats).toEqual({ total: 0, average: 0, max: 0, maxLabel: null, busiestWeekday: null, largeShare: null });
  });
});

describe('buildVolumeSeries — edge cases', () => {
  it('still spans the range with empty buckets when byDay is empty', () => {
    const { buckets } = buildVolumeSeries([], axis('2026-06-01', '2026-06-14'), 'weekly', null);
    expect(buckets).toHaveLength(2);
    for (const b of buckets) {
      expect(b.total).toBe(0);
      expect(b.days).toEqual([]);
    }
  });

  it('returns no buckets and zeroed stats for an empty axis (no division by zero)', () => {
    const { buckets, stats } = buildVolumeSeries([day('2026-06-01', { xs: 1 })], [], 'daily', null);
    expect(buckets).toEqual([]);
    expect(stats).toEqual({ total: 0, average: 0, max: 0, maxLabel: null, busiestWeekday: null, largeShare: null });
  });

  it('ignores byDay entries outside the axis range', () => {
    // A PR on 2026-05-25 is before the 2026-06-01..14 window → not counted.
    const byDay = [day('2026-05-25', { xl: 9 }), day('2026-06-01', { xs: 1 })];
    const { stats } = buildVolumeSeries(byDay, axis('2026-06-01', '2026-06-14'), 'weekly', null);
    expect(stats.total).toBe(1);
  });

  it('is stable across granularities: totals agree with the daily bucketing', () => {
    const days = axis('2026-05-30', '2026-07-02');
    const byDay = [
      day('2026-05-30', { s: 1 }),
      day('2026-06-08', { m: 2 }),
      day('2026-07-02', { xs: 1 }),
    ];
    const granularities: Granularity[] = ['daily', 'weekly', 'monthly'];
    for (const g of granularities) {
      expect(buildVolumeSeries(byDay, days, g, null).stats.total).toBe(4);
    }
  });
});

/**
 * Mutation sweep (MUTATION_TESTS): targeted assertions that make the defensive
 * slicing / UTC-normalisation load-bearing, so Stryker mutants of those
 * expressions cannot survive. Without a time component in the input, `day.slice(0, 10)`
 * and the `'T00:00:00Z'` suffix are no-ops and their mutants are equivalent —
 * these tests feed time-carrying strings so the contract ("a day may arrive as a
 * full ISO timestamp; only its UTC calendar date matters") is actually enforced.
 */
describe('buildVolumeSeries — mutation sweep', () => {
  it('weekStartOf ignores the time component and stays UTC (kills slice/UTC-suffix mutants)', () => {
    // A late-evening UTC timestamp on Sunday 2026-06-07 still belongs to the
    // week of 2026-06-01. If the UTC suffix were mutated away, a non-UTC host
    // would shift the calendar date and this would break.
    expect(weekStartOf('2026-06-07T23:59:59.999Z')).toBe('2026-06-01');
    // Monday 00:00:00 UTC stays in its own week even with a time component.
    expect(weekStartOf('2026-06-01T00:00:00.000Z')).toBe('2026-06-01');
    // A timestamp just before UTC midnight Sunday must NOT roll to the next week.
    expect(weekStartOf('2026-06-07T23:00:00.000Z')).toBe('2026-06-01');
  });

  it('daily bucket key/rangeLabel strip the time component (kills daily slice mutants)', () => {
    // The axis normally holds date-only days, but the bucket key/rangeLabel must
    // be date-only even if a day arrives with a time component.
    const { buckets } = buildVolumeSeries(
      [day('2026-06-01', { xs: 1 })],
      ['2026-06-01T12:00:00.000Z'],
      'daily',
      null,
    );
    expect(buckets[0].key).toBe('2026-06-01');
    expect(buckets[0].rangeLabel).toBe('2026-06-01');
    expect(buckets[0].label).toBe('06-01');
  });

  it('merges devBySize when a day omits the per-size dev breakdown (kills ?? [] fallback)', () => {
    // A day point whose devBySize lacks a size key exercises the `?? []` arm.
    const partial = {
      day: '2026-06-01',
      sizes: { xs: 1, s: 0, m: 0, l: 0, xl: 0 },
      total: 1,
      devBySize: { xs: [{ user_key: 'a@x.com', count: 1 }] } as unknown as DayPoint['devBySize'],
    };
    const { buckets } = buildVolumeSeries([partial], axis('2026-06-01', '2026-06-07'), 'weekly', null);
    expect(buckets[0].devBySize.xs).toEqual([{ user_key: 'a@x.com', count: 1 }]);
    expect(buckets[0].devBySize.s).toEqual([]);
  });
});

// Story da96916f: the stats under the chart no longer repeat the Total PRs
// tile; they say which weekday is busiest and how much of the work is large.
describe('buildVolumeSeries — busiest weekday and large share', () => {
  // 2026-09-01 is a Tuesday; 09-08 the next Tuesday; 09-02 a Wednesday.
  const range = axis('2026-09-01', '2026-09-14');
  const days = [
    day('2026-09-01', { s: 2 }),
    day('2026-09-08', { m: 1, l: 1 }),
    day('2026-09-02', { xl: 3 }),
    day('2026-09-07', { xs: 1 }),
  ];

  it('names the weekday with the most PRs over the range, and its share', () => {
    const { stats } = buildVolumeSeries(days, range, 'daily', null);
    // Two Tuesdays in the range: 4 PRs is 2 per Tuesday.
    expect(stats.busiestWeekday).toEqual({ day: 'Tue', prs: 4, perDay: 2, share: 4 / 8 });
  });

  it('is the same answer whatever the granularity', () => {
    for (const g of ['daily', 'weekly', 'monthly'] as Granularity[]) {
      expect(buildVolumeSeries(days, range, g, null).stats.busiestWeekday?.day).toBe('Tue');
    }
  });

  it('breaks a tie towards the earlier weekday, Monday first', () => {
    const tie = [day('2026-09-02', { s: 2 }), day('2026-09-07', { s: 2 })];
    expect(buildVolumeSeries(tie, range, 'daily', null).stats.busiestWeekday?.day).toBe('Mon');
  });

  it('counts only the days inside the range', () => {
    const outside = [...days, day('2026-08-30', { s: 9 })];
    expect(buildVolumeSeries(outside, range, 'daily', null).stats.busiestWeekday?.day).toBe('Tue');
  });

  it('ranks weekdays by PRs per occurrence, so one that occurs more often has no head start', () => {
    // Tue 09-01 .. Tue 09-08: Tuesday occurs twice, Wednesday once. Raw totals
    // tie at 2 (and the tie would go to Tuesday); per occurrence Wednesday leads.
    const lopsided = axis('2026-09-01', '2026-09-08');
    const d = [day('2026-09-01', { s: 1 }), day('2026-09-08', { s: 1 }), day('2026-09-02', { m: 2 })];
    expect(buildVolumeSeries(d, lopsided, 'daily', null).stats.busiestWeekday).toEqual({ day: 'Wed', prs: 2, perDay: 2, share: 2 / 4 });
  });

  it('gives the share of L and XL PRs', () => {
    expect(buildVolumeSeries(days, range, 'weekly', null).stats.largeShare).toBe(4 / 8);
  });

  it('has neither when there are no PRs', () => {
    const { stats } = buildVolumeSeries([], range, 'daily', null);
    expect(stats.busiestWeekday).toBeNull();
    expect(stats.largeShare).toBeNull();
  });
});

// Epic review round 2 (8706f29a): a rolling 7d/30d window starts at now − N
// days and ends now, so its first and last days are partial. Counted as whole
// occurrences, today's weekday (first AND last day of a 7d window) had its
// rate halved.
describe('edgeCoverage', () => {
  it('is the share of the first and last day the window covers, in the axis zone', () => {
    expect(edgeCoverage('2026-08-04T18:00:00.000Z', '2026-08-11T06:00:00.000Z', 'UTC')).toEqual({ first: 0.25, last: 0.25 });
    // 21:00Z is 18:00 in São Paulo (UTC−3, no DST in August).
    expect(edgeCoverage('2026-08-04T21:00:00.000Z', '2026-08-11T09:00:00.000Z', 'America/Sao_Paulo')).toEqual({ first: 0.25, last: 0.25 });
  });

  it('is about whole days for a window of whole days', () => {
    const c = edgeCoverage('2026-08-04T00:00:00.000Z', '2026-08-11T23:59:59.999Z', 'UTC');
    expect(c.first).toBe(1);
    expect(c.last).toBeCloseTo(1, 5);
  });
});

describe('buildVolumeSeries — partial edge days', () => {
  // Tue 08-04 .. Tue 08-11: a 7d window from Tue 18:00 to Tue 18:00.
  const week = axis('2026-08-04', '2026-08-11');
  const d = [day('2026-08-04', { s: 1 }), day('2026-08-11', { s: 1 }), day('2026-08-05', { m: 2 })];

  it('weights the window\'s partial first and last day by how much of them it covers', () => {
    // The two partial Tuesdays add up to one Tuesday: 2 PRs per Tuesday ties
    // Wednesday's 2, and the tie goes to the earlier weekday.
    const { stats } = buildVolumeSeries(d, week, 'daily', { first: 0.25, last: 0.75 });
    expect(stats.busiestWeekday).toEqual({ day: 'Tue', prs: 2, perDay: 2, share: 2 / 4 });
  });

  it('counts every day whole when told the window is whole days', () => {
    expect(buildVolumeSeries(d, week, 'daily', null).stats.busiestWeekday?.day).toBe('Wed');
  });
});

// Epic review round 3 (471d88f4): From set and To left open, early in the
// day. Today's weekday has one occurrence, a few minutes long; dividing by
// its sliver turned 1 PR into "144 PRs per Thu".
describe('buildVolumeSeries — a sliver of a day', () => {
  it('never counts a weekday as less than one occurrence', () => {
    // Mon 09-28 .. Thu 10-01, the window ending ten minutes into Thursday.
    const shortWindow = axis('2026-09-28', '2026-10-01');
    const d = [
      day('2026-09-28', { s: 3 }), day('2026-09-29', { s: 3 }), day('2026-09-30', { s: 3 }),
      day('2026-10-01', { s: 1 }),
    ];
    const { stats } = buildVolumeSeries(d, shortWindow, 'daily', { first: 1, last: 10 / 1440 });
    expect(stats.busiestWeekday?.day).toBe('Mon');
    expect(stats.busiestWeekday?.perDay).toBe(3);
  });
});
