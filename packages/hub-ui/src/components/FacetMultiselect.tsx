import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { filterFacetOptions } from './facetSearch';

interface Props {
  label: string;
  options: string[];
  selected: Set<string>;
  onToggle: (v: string) => void;
  onClear: () => void;
  optionLabel?: (v: string) => string;
  /**
   * Below this option count we render a simple flat chip row instead of the
   * popover — the popover earns its keep only at scale.
   */
  inlineThreshold?: number;
  placeholder?: string;
}

export function FacetMultiselect({
  label,
  options,
  selected,
  onToggle,
  onClear,
  optionLabel,
  inlineThreshold = 0,
  placeholder = 'Search…',
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    // Focus the search input when opening.
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(
    () => filterFacetOptions(options, query, optionLabel),
    [options, query, optionLabel],
  );

  if (options.length === 0) return null;

  // Below the threshold, fall back to the existing flat chip layout — keeps
  // the popover off small, fully-visible facets like EPIC/STORY/TASK/BUG.
  if (options.length <= inlineThreshold) {
    return (
      <div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-ink-tertiary">{label}</h3>
          {selected.size > 0 && (
            <button onClick={onClear} className="text-[11px] font-medium text-ink-tertiary hover:text-danger-muted">
              Clear ({selected.size})
            </button>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {options.map((t) => {
            const on = selected.has(t);
            return (
              <button
                key={t}
                onClick={() => onToggle(t)}
                title={t}
                className={`px-2.5 py-1 rounded-full font-mono text-[11px] border transition-colors max-w-[260px] truncate ${on
                  ? 'text-accent-text border-border-brand bg-chip'
                  : 'text-ink-secondary border-border-soft hover:text-accent-text hover:border-border-brand'}`}
              >
                {optionLabel ? optionLabel(t) : t}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const selectedArr = [...selected];

  return (
    <div ref={rootRef} className="relative">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-ink-tertiary">{label}</h3>
        {selected.size > 0 && (
          <button onClick={onClear} className="text-[11px] font-medium text-ink-tertiary hover:text-danger-muted">
            Clear ({selected.size})
          </button>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-mono text-[11px] border text-ink-secondary border-border-soft hover:border-border-brand hover:text-accent-text transition-colors"
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          {selected.size === 0
            ? `All ${options.length}`
            : `${selected.size} selected · ${options.length} total`}
          <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>

        {selectedArr.map((v) => (
          <span
            key={v}
            title={v}
            className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full font-mono text-[11px] border text-accent-text border-border-brand bg-chip max-w-[260px]"
          >
            <span className="truncate">{optionLabel ? optionLabel(v) : v}</span>
            <button
              onClick={() => onToggle(v)}
              aria-label={`Remove ${v}`}
              className="rounded-full hover:bg-brand/20 p-0.5 -mr-0.5"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>

      {open && (
        <div className="absolute z-20 mt-2 w-[min(420px,calc(100vw-2rem))] bg-card-glass backdrop-blur border border-border-soft rounded-xl shadow-xl overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border-soft">
            <Search className="w-3.5 h-3.5 text-ink-tertiary" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className="flex-1 bg-transparent outline-none text-[12px] text-ink placeholder:text-ink-tertiary"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="text-ink-tertiary hover:text-ink"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <ul role="listbox" aria-multiselectable="true" className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-[12px] text-ink-tertiary">No matches.</li>
            ) : (
              filtered.map((v) => {
                const on = selected.has(v);
                return (
                  <li key={v} role="option" aria-selected={on}>
                    <button
                      onClick={() => onToggle(v)}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] font-mono transition-colors ${on
                        ? 'bg-chip text-accent-text'
                        : 'text-ink hover:bg-chip/50'}`}
                      title={v}
                    >
                      <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${on
                        ? 'bg-brand border-brand text-navy'
                        : 'border-border-soft'}`}>
                        {on && <Check className="w-2.5 h-2.5" />}
                      </span>
                      <span className="truncate">{optionLabel ? optionLabel(v) : v}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          {selected.size > 0 && (
            <div className="flex items-center justify-between px-3 py-2 border-t border-border-soft text-[11px]">
              <span className="text-ink-tertiary">{selected.size} selected</span>
              <button onClick={onClear} className="font-medium text-ink-tertiary hover:text-danger-muted">
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
