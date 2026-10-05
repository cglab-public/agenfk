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
      <h3 id={id} className="eyebrow text-ink-tertiary">{label}</h3>
      {count > 0 && (
        // Each facet has a Clear: the name says which filter it empties, and
        // starts with the visible "Clear (n)" so voice control can still say it.
        <button type="button" onClick={onClear} disabled={disabled} aria-label={`Clear (${count}) ${label} filter`} className="text-small font-medium text-ink-tertiary hover:text-ink disabled:opacity-50">
          Clear ({count})
        </button>
      )}
    </div>
  );
}

/**
 * One toggle chip. `title` is the hover text. `detail` is the raw value behind
 * a short label: shown under it, and the chip's description, so it does not
 * live only in a mouse-only title.
 */
export function Chip({ on, onClick, title, detail, mono = false, disabled, children }: {
  on: boolean;
  onClick: () => void;
  title?: string;
  detail?: string;
  mono?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const detailId = useId();
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={title}
      aria-describedby={detail ? detailId : undefined}
      disabled={disabled}
      className={cn(
        // Wrapped, not truncated: a long label's rest lived only in the title.
        'px-2.5 py-1 rounded-full text-caption border transition-colors max-w-[260px] break-words text-left disabled:opacity-50 disabled:cursor-not-allowed',
        mono && 'font-mono',
        on ? 'text-accent-ink border-accent bg-accent-fill'
          : 'bg-surface border-border-soft text-ink-secondary hover:border-accent hover:text-accent-ink',
      )}
    >
      {children}
      {/* Out of the name (voice control says the label), in the description. */}
      {detail && <span id={detailId} aria-hidden="true" className="block font-mono text-ink-tertiary break-all">{detail}</span>}
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
