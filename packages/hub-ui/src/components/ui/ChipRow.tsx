import { ReactNode, useId } from 'react';
import { cn } from './cn';

/** A filter's heading with its "Clear (n)" action. */
export function FilterHeading({ id, label, count, onClear, disabled }: {
  id: string;
  label: string;
  count: number;
  onClear: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <h3 id={id} className="text-[11px] uppercase tracking-[0.14em] font-semibold text-ink-tertiary">{label}</h3>
      {count > 0 && (
        // Each facet has a Clear: the name says which filter it empties.
        <button type="button" onClick={onClear} disabled={disabled} aria-label={`Clear ${label} filter (${count})`} className="text-xs font-medium text-ink-tertiary hover:text-ink disabled:opacity-50">
          Clear ({count})
        </button>
      )}
    </div>
  );
}

/** One toggle chip. `title` is the hover text (the raw value by default). */
export function Chip({ on, onClick, title, mono = false, disabled, children }: {
  on: boolean;
  onClick: () => void;
  title?: string;
  mono?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        'px-2.5 py-1 rounded-full text-[11px] border transition-colors max-w-[260px] truncate disabled:opacity-50 disabled:cursor-not-allowed',
        mono && 'font-mono',
        on ? 'text-accent-ink border-accent bg-accent-fill'
          : 'bg-surface border-border-soft text-ink-secondary hover:border-accent hover:text-accent-ink',
      )}
    >
      {children}
    </button>
  );
}

/** A labelled row of multi-select filter chips. */
export function ChipRow({ label, options, selected, onToggle, onClear, optionLabel }: {
  label: string;
  options: string[];
  selected: Set<string>;
  onToggle: (v: string) => void;
  onClear: () => void;
  optionLabel?: (v: string) => string;
}) {
  const id = useId();
  if (options.length === 0) return null;
  return (
    <div>
      <FilterHeading id={id} label={label} count={selected.size} onClear={onClear} />
      <div role="group" aria-labelledby={id} className="mt-1.5 flex flex-wrap gap-1.5">
        {options.map(t => (
          <Chip key={t} on={selected.has(t)} onClick={() => onToggle(t)} title={t} mono>
            {optionLabel ? optionLabel(t) : t}
          </Chip>
        ))}
      </div>
    </div>
  );
}
