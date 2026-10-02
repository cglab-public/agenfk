import { SPARK_STROKE } from '../chartColours';

/**
 * The highest daily value any of `rows` reaches on `axis`: the shared `max`
 * that lets a table's sparklines be compared row against row (story
 * 4e45bf2f). Over every row the table holds, not the ones a search shows, so
 * the scale does not jump while someone types.
 */
export function sharedPeak<T>(rows: readonly T[], daily: (row: T) => Record<string, number>, axis: readonly string[]): number {
  let peak = 0;
  for (const r of rows) {
    const d = daily(r);
    for (const day of axis) if ((d[day] ?? 0) > peak) peak = d[day];
  }
  return peak;
}

/**
 * A tiny line of daily counts over `axis` (the period's days). Decorative
 * unless given a `label`, in which case it is an image that says what it
 * shows: "Activity: 30 over 31 days, peak 20".
 *
 * `max` puts it on a scale shared with its neighbours (see sharedPeak), so the
 * same count draws at the same height in every row; without it the line
 * scales to its own peak.
 */
export function Sparkline({ daily, axis, label, max: shared }: { daily: Record<string, number>; axis: string[]; label?: string; max?: number }) {
  const values = axis.map(d => daily[d] ?? 0);
  const w = 96, h = 24, max = Math.max(shared ?? 0, ...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`).join(' ');
  const sum = values.reduce((a, b) => a + b, 0);
  const a11y = label
    ? { role: 'img', 'aria-label': `${label}: ${sum.toLocaleString()} over ${axis.length} day${axis.length === 1 ? '' : 's'}, peak ${Math.max(0, ...values).toLocaleString()}` }
    : { 'aria-hidden': true };
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible" {...a11y}>
      {values.length < 2
        // One day has no line to draw: a dot at its height instead.
        ? <circle cx={w / 2} cy={h - ((values[0] ?? 0) / max) * (h - 4) - 2} r={2.5} fill={SPARK_STROKE} />
        : <polyline points={pts} fill="none" stroke={SPARK_STROKE} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />}
    </svg>
  );
}
