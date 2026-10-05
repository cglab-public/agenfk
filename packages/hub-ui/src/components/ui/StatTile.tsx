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
export function StatTile({ label, value, delta, higherIsBetter = true, series, hint, size = 'md', onClick, pressed, description, locked, className }: {
  label: string;
  value: number | string;
  hint?: ReactNode;
  size?: 'md' | 'sm';
  /** Makes the tile a toggle button (aria-pressed): only then does it look interactive. */
  onClick?: () => void;
  pressed?: boolean;
  /** What a click does, as the button's description (and its tooltip). */
  description?: string;
  /** Pressed but unable to release (the "all" choice): stays a focusable button. */
  locked?: boolean;
  delta?: number | null;
  higherIsBetter?: boolean;
  series?: 1 | 2 | 3 | 4 | 5 | 6;
  className?: string;
}) {
  const shown = typeof value === 'number' ? value.toLocaleString() : value;
  const Root = onClick ? 'button' : 'div';
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
          'justify-self-start px-1.5 py-0.5 rounded font-mono text-caption font-semibold',
          good === null ? 'text-ink-tertiary bg-canvas' : good ? 'text-status-ok-text bg-status-ok-bg' : 'text-status-danger-text bg-status-danger-bg',
        )}
      >
        <span aria-hidden="true">{arrow} {dir === 0 ? 'flat' : `${Math.abs(pct)}%`}</span>
        <span className="sr-only">{spoken}</span>
      </span>
    );
  }
  return (
    <Root
      data-stat-tile
      data-size={size}
      {...(onClick ? {
        type: 'button' as const,
        // A locked tile ignores clicks but stays the same focused element, so
        // a keyboard user's focus survives the selection change.
        onClick: locked ? undefined : onClick,
        'aria-pressed': !!pressed,
        'aria-disabled': locked || undefined,
        title: description,
      } : {})}
      className={cn(
        'bg-surface border border-border-soft grid gap-1 min-w-0 text-left',
        size === 'sm' ? 'rounded-lg px-3 py-2' : 'rounded-xl px-4 py-3',
        onClick && 'transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        onClick && (locked ? 'cursor-default' : 'cursor-pointer hover:border-accent'),
        onClick && pressed && 'border-accent bg-accent-fill',
        className,
      )}
    >
      {/* Spans, not divs: as a button the tile may only hold phrasing content. */}
      <span className="flex items-center gap-1.5 text-small font-semibold text-ink-tertiary">
        {series && <span data-testid="stat-swatch" aria-hidden="true" className={cn('w-2 h-2 rounded-sm', SWATCH[series])} />}
        {label}
      </span>
      {/* Wrapped, not truncated: a long value's rest lived only in a title. */}
      <span className={cn('block font-extrabold tabular-nums text-ink break-words', size === 'sm' ? 'text-body' : 'text-display')}>{shown}</span>
      {deltaEl}
      {hint != null && hint !== '' && hint !== false && <span data-stat-hint className="block text-caption text-ink-tertiary">{hint}</span>}
    </Root>
  );
}
