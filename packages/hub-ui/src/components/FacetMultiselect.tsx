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
          <h3 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-slate-500 dark:text-slate-400">{label}</h3>
          {selected.size > 0 && (
            <button onClick={onClear} className="text-[11px] font-medium text-slate-500 hover:text-rose-600 dark:hover:text-rose-400">
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
                  ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm'
                  : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-300 hover:text-indigo-700 dark:hover:text-indigo-300'}`}
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
        <h3 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-slate-500 dark:text-slate-400">{label}</h3>
        {selected.size > 0 && (
          <button onClick={onClear} className="text-[11px] font-medium text-slate-500 hover:text-rose-600 dark:hover:text-rose-400">
            Clear ({selected.size})
          </button>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-mono text-[11px] border bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-300 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors"
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
            className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full font-mono text-[11px] border bg-indigo-600 border-indigo-600 text-white shadow-sm max-w-[260px]"
          >
            <span className="truncate">{optionLabel ? optionLabel(v) : v}</span>
            <button
              onClick={() => onToggle(v)}
              aria-label={`Remove ${v}`}
              className="rounded-full hover:bg-indigo-500/40 p-0.5 -mr-0.5"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>

      {open && (
        <div className="absolute z-20 mt-2 w-[min(420px,calc(100vw-2rem))] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 dark:border-slate-800">
            <Search className="w-3.5 h-3.5 text-slate-400" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className="flex-1 bg-transparent outline-none text-[12px] text-slate-700 dark:text-slate-200 placeholder:text-slate-400"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <ul role="listbox" aria-multiselectable="true" className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-[12px] text-slate-500">No matches.</li>
            ) : (
              filtered.map((v) => {
                const on = selected.has(v);
                return (
                  <li key={v} role="option" aria-selected={on}>
                    <button
                      onClick={() => onToggle(v)}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] font-mono transition-colors ${on
                        ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-200'
                        : 'text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
                      title={v}
                    >
                      <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${on
                        ? 'bg-indigo-600 border-indigo-600 text-white'
                        : 'border-slate-300 dark:border-slate-600'}`}>
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
            <div className="flex items-center justify-between px-3 py-2 border-t border-slate-100 dark:border-slate-800 text-[11px]">
              <span className="text-slate-500">{selected.size} selected</span>
              <button onClick={onClear} className="font-medium text-slate-500 hover:text-rose-600 dark:hover:text-rose-400">
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
