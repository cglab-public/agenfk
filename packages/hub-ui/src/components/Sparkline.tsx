import { SPARK_STROKE } from '../chartColours';

/**
 * A tiny line of daily counts over `axis` (the period's days). Decorative
 * unless given a `label`, in which case it is an image that says what it
 * shows: "Activity: 30 over 31 days, peak 20".
 */
export function Sparkline({ daily, axis, label }: { daily: Record<string, number>; axis: string[]; label?: string }) {
  const values = axis.map(d => daily[d] ?? 0);
  const w = 96, h = 24, max = Math.max(...values, 1);
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
