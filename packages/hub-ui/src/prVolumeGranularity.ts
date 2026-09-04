// Pure helpers for the PR Overview "PR volume by size" chart granularity
// (CGLAB-133): re-bucket the per-UTC-day `byDay` data returned by
// /v1/prs/overview into daily / weekly (ISO, Mon–Sun) / monthly buckets, with
// the stats shown under the chart. Kept out of the component so they can be
// unit-tested without a DOM (see prOverview.ts / prPerDay.ts for the same
// pattern).

import { SIZE_META, type SizeKey } from './prOverview';

export type Granularity = 'daily' | 'weekly' | 'monthly';
export type SizeDist = Record<SizeKey, number>;
type DevCount = Array<{ user_key: string; count: number }>;

/** One day point of the API's `byDay` array (day in UTC, YYYY-MM-DD). */
export interface DayPoint {
  day: string;
  sizes: SizeDist;
  total: number;
  devBySize: Record<SizeKey, DevCount>;
}

/** A non-empty day inside a bucket (for tooltips). */
export interface BucketDay { day: string; sizes: SizeDist; total: number }

/** One bucket of the re-bucketed volume series, in axis order. */
export interface VolumeBucket {
  key: string;      // identity: day 'YYYY-MM-DD', ISO week start 'YYYY-MM-DD', month 'YYYY-MM'
  label: string;    // x-axis label: 'MM-DD' (day/week start) or 'Mon YYYY'
  rangeLabel: string; // human span for tooltips: day, 'Week of MM-DD', 'Mon YYYY'
  sizes: SizeDist;
  total: number;
  days: BucketDay[];  // non-empty days in the bucket, bucket order
  devBySize: Record<SizeKey, DevCount>; // merged across the bucket's days
}

export interface VolumeStats {
  total: number;   // sum of the bucket totals (= PRs within the range)
  average: number; // total / bucket count — ALL buckets in the range, incl. empty ones
  max: number;     // highest bucket total (0 when there are no PRs)
  maxLabel: string | null; // label of the max bucket (earliest on ties); null when total is 0
}

export interface VolumeSeries {
  granularity: Granularity;
  buckets: VolumeBucket[];
  stats: VolumeStats;
}

const SIZE_KEYS = SIZE_META.map(s => s.key);

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

const emptyDist = (): SizeDist => ({ xs: 0, s: 0, m: 0, l: 0, xl: 0 });

/** Monday of the ISO week containing `day` (YYYY-MM-DD, UTC) — a Sunday stays
 *  in the week that started on Monday.
 *  Mutation note: the `'T00:00:00Z'` suffix is redundant with the slice (ESM
 *  parses date-only strings as UTC), so its Stryker mutant is an equivalent —
 *  kept for explicitness, not behaviour. */
export function weekStartOf(day: string): string {
  const d = new Date(day.slice(0, 10) + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/** Calendar-month key 'YYYY-MM'. */
export function monthKeyOf(day: string): string {
  return day.slice(0, 7);
}

const bucketKeyOf = (day: string, g: Granularity): string =>
  g === 'daily' ? day.slice(0, 10) : g === 'weekly' ? weekStartOf(day) : monthKeyOf(day);

const labelOf = (key: string, g: Granularity): string => {
  if (g === 'monthly') {
    const mm = Number(key.slice(5, 7));
    return `${SHORT_MONTHS[mm - 1]} ${key.slice(0, 4)}`;
  }
  return key.slice(5); // 'MM-DD' (day, or the week's Monday)
};

const rangeLabelOf = (key: string, g: Granularity): string => {
  if (g === 'weekly') return `Week of ${key.slice(5)}`;
  if (g === 'monthly') return labelOf(key, g);
  return key.slice(0, 10); // daily: full date, as in the original daily tooltip
  // (defensive: bucketKeyOf already yields date-only keys, so this slice is an
  //  equivalent mutant — kept so the contract holds if the caller passes a raw day)
};

/** Re-bucket the per-day series into daily / weekly / monthly buckets spanning
 *  the axis (the selected range). Buckets are derived from the AXIS, so the
 *  chart always covers the full window (empty buckets included — that's what
 *  makes the average a true per-bucket rate); `byDay` entries outside the axis
 *  are ignored, matching the daily chart's behaviour. */
export function buildVolumeSeries(
  byDay: ReadonlyArray<DayPoint>,
  axis: ReadonlyArray<string>,
  granularity: Granularity,
): VolumeSeries {
  const axisSet = new Set(axis);
  const points = new Map<string, DayPoint>();
  // The `axisSet.has` guard is a write-side filter: out-of-range points are
  // never read (the bucket loop below iterates `axis` only), so its Stryker
  // mutant is an equivalent — kept to document intent and bound the map.
  for (const p of byDay) if (axisSet.has(p.day)) points.set(p.day, p);

  interface Acc {
    key: string;
    sizes: SizeDist;
    total: number;
    days: BucketDay[];
    dev: Record<SizeKey, Map<string, number>>;
  }
  const emptyDev = (): Acc['dev'] => {
    const d = {} as Acc['dev'];
    for (const k of SIZE_KEYS) d[k] = new Map();
    return d;
  };

  const accs: Acc[] = [];
  for (const day of axis) {
    const key = bucketKeyOf(day, granularity);
    const last = accs[accs.length - 1];
    if (!last || last.key !== key) {
      accs.push({ key, sizes: emptyDist(), total: 0, days: [], dev: emptyDev() });
    }
    const acc = accs[accs.length - 1];
    const p = points.get(day);
    if (!p) continue;
    for (const k of SIZE_KEYS) {
      acc.sizes[k] += p.sizes[k] ?? 0;
      const m = acc.dev[k];
      for (const dev of p.devBySize[k] ?? []) m.set(dev.user_key, (m.get(dev.user_key) ?? 0) + dev.count);
    }
    acc.total += p.total;
    acc.days.push({ day, sizes: p.sizes, total: p.total });
  }

  const buckets: VolumeBucket[] = accs.map(a => {
    const devBySize = {} as Record<SizeKey, DevCount>;
    for (const k of SIZE_KEYS) {
      devBySize[k] = [...a.dev[k].entries()]
        .map(([user_key, count]) => ({ user_key, count }))
        .sort((x, y) => y.count - x.count || x.user_key.localeCompare(y.user_key));
    }
    return {
      key: a.key,
      label: labelOf(a.key, granularity),
      rangeLabel: rangeLabelOf(a.key, granularity),
      sizes: a.sizes,
      total: a.total,
      days: a.days,
      devBySize,
    };
  });

  const total = buckets.reduce((s, b) => s + b.total, 0);
  let max = 0;
  let maxLabel: string | null = null;
  for (const b of buckets) {
    if (b.total > max) { max = b.total; maxLabel = b.label; } // strict >: earliest bucket wins ties
  }

  return {
    granularity,
    buckets,
    stats: {
      total,
      average: buckets.length ? total / buckets.length : 0,
      max,
      maxLabel,
    },
  };
}
