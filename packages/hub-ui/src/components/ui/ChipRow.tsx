import { useId } from 'react';
import { cn } from './cn';

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
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 id={id} className="text-[11px] uppercase tracking-[0.14em] font-semibold text-ink-tertiary">{label}</h3>
        {selected.size > 0 && (
          <button type="button" onClick={onClear} className="text-xs font-medium text-ink-tertiary hover:text-ink">
            Clear ({selected.size})
          </button>
        )}
      </div>
      <div role="group" aria-labelledby={id} className="mt-1.5 flex flex-wrap gap-1.5">
        {options.map(t => {
          const on = selected.has(t);
          return (
            <button
              key={t}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(t)}
              title={t}
              className={cn(
                'px-2.5 py-1 rounded-full font-mono text-[11px] border transition-colors max-w-[260px] truncate',
                on ? 'text-accent-ink border-accent bg-accent-fill'
                  : 'bg-surface border-border-soft text-ink-secondary hover:border-accent hover:text-accent-ink',
              )}
            >
              {optionLabel ? optionLabel(t) : t}
            </button>
          );
        })}
      </div>
    </div>
  );
}
