import { ReactNode, useId } from 'react';
import { cn } from './cn';

/**
 * The period picker every dashboard puts in its header toolbar: a visible
 * "Period" caption that also names the group, the preset pills, and a slot for
 * page-specific extras (PR overview's custom dates). It wraps rather than
 * overflowing on a narrow screen. `active` is null when no preset applies, for
 * example while a custom range is set.
 */
export function PeriodControl<K extends string>({ ranges, active, onPick, disabled, title, children, className }: {
  ranges: ReadonlyArray<{ key: K; label: string }>;
  active: K | null;
  onPick: (key: K) => void;
  disabled?: boolean;
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  const captionId = useId();
  return (
    <div role="group" aria-labelledby={captionId} title={title} className={cn('flex items-center gap-2 flex-wrap', className)}>
      <span id={captionId} className="eyebrow text-ink-tertiary">Period</span>
      <div className="inline-flex rounded-lg border border-border-soft bg-canvas p-0.5 text-caption font-medium">
        {ranges.map(r => (
          <button
            key={r.key}
            type="button"
            aria-pressed={active === r.key}
            onClick={() => onPick(r.key)}
            disabled={disabled}
            className={cn(
              'px-2.5 py-1 rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              active === r.key ? 'bg-surface text-accent-ink shadow-sm' : 'text-ink-tertiary hover:text-ink',
            )}
          >
            {r.label}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}
