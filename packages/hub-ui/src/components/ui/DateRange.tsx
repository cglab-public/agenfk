import { useRef } from 'react';
import { cn } from './cn';

const INPUT = 'rounded-lg border border-border-soft bg-surface text-ink-secondary px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50';

/**
 * A custom period as two date inputs (YYYY-MM-DD, the viewer's local days).
 * Each side bounds the other so To can never precede From, and one button
 * clears both. The button stays rendered (disabled when there is nothing to
 * clear) and hands focus back to From, so clearing never drops keyboard focus.
 * `onChange` always reports the pair.
 */
export function DateRange({ from, to, onChange, disabled, className }: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const fromRef = useRef<HTMLInputElement>(null);
  return (
    <div className={cn('inline-flex flex-wrap items-center gap-1.5 text-caption text-ink-tertiary', className)}>
      <label className="inline-flex items-center gap-1">
        <span>From</span>
        <input
          ref={fromRef}
          type="date"
          value={from}
          max={to || undefined}
          onChange={e => onChange(e.target.value, to)}
          aria-label="From date"
          disabled={disabled}
          className={INPUT}
        />
      </label>
      <label className="inline-flex items-center gap-1">
        <span>To</span>
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={e => onChange(from, e.target.value)}
          aria-label="To date"
          disabled={disabled}
          className={INPUT}
        />
      </label>
      <button
        type="button"
        onClick={() => { onChange('', ''); fromRef.current?.focus(); }}
        disabled={disabled || (!from && !to)}
        aria-label="Clear date range"
        title="Clear date range"
        className="px-1.5 py-1 rounded-md text-ink-tertiary hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        ✕
      </button>
    </div>
  );
}
