import { ReactNode } from 'react';
import { cn } from './cn';

const SWATCH = ['', 'bg-series-1', 'bg-series-2', 'bg-series-3', 'bg-series-4', 'bg-series-5', 'bg-series-6'] as const;

/**
 * A headline number. `delta` is the % change vs the previous period; its tone
 * says whether that change is good, so `higherIsBetter={false}` for failures.
 * `series` keys the tile to the chart colour of the same measure. `hint` is a
 * line of context under the value (a unit, a ratio); `size="sm"` is the
 * compact tile used under a chart.
 */
export function StatTile({ label, value, delta, higherIsBetter = true, series, hint, size = 'md', className }: {
  label: string;
  value: number | string;
  hint?: ReactNode;
  size?: 'md' | 'sm';
  delta?: number | null;
  higherIsBetter?: boolean;
  series?: 1 | 2 | 3 | 4 | 5 | 6;
  className?: string;
}) {
  const shown = typeof value === 'number' ? value.toLocaleString() : value;
  let deltaEl = null;
  // A previous period of 0 gives Infinity; nothing to compare gives NaN.
  if (typeof delta === 'number' && Number.isFinite(delta)) {
    const pct = Math.round(delta);
    const dir = Math.sign(pct);
    const good = dir === 0 ? null : (dir > 0) === higherIsBetter;
    const arrow = dir > 0 ? '▲' : dir < 0 ? '▼' : '—';
    const spoken = dir === 0 ? 'no change' : `${dir > 0 ? 'up' : 'down'} ${Math.abs(pct)}%, ${good ? 'better' : 'worse'}`;
    deltaEl = (
      <span
        data-testid="stat-delta"
        className={cn(
          'justify-self-start px-1.5 py-0.5 rounded font-mono text-[11px] font-semibold',
          good === null ? 'text-ink-tertiary bg-canvas' : good ? 'text-status-ok-text bg-status-ok-bg' : 'text-status-danger-text bg-status-danger-bg',
        )}
      >
        <span aria-hidden="true">{arrow} {dir === 0 ? 'flat' : `${Math.abs(pct)}%`}</span>
        <span className="sr-only">{spoken}</span>
      </span>
    );
  }
  return (
    <div
      data-stat-tile
      data-size={size}
      className={cn(
        'bg-surface border border-border-soft grid gap-1 min-w-0',
        size === 'sm' ? 'rounded-lg px-3 py-2' : 'rounded-xl px-4 py-3',
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold text-ink-tertiary">
        {series && <span data-testid="stat-swatch" aria-hidden="true" className={cn('w-2 h-2 rounded-sm', SWATCH[series])} />}
        {label}
      </div>
      <div className={cn('font-extrabold tabular-nums text-ink truncate', size === 'sm' ? 'text-[15px]' : 'text-2xl')} title={shown}>{shown}</div>
      {deltaEl}
      {hint != null && hint !== '' && hint !== false && <div data-stat-hint className="text-[11px] text-ink-tertiary">{hint}</div>}
    </div>
  );
}
