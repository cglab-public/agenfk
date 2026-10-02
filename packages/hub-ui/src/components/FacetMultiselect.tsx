import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Chip, FilterHeading } from './ui/ChipRow';
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
  /**
   * Render the facet inert without hiding it. Used by the PR Overview's PR-number
   * search, which supersedes this facet: a control that still looks clickable
   * while its selection has no effect on the numbers is a lie, and removing it
   * outright would make the filter look like it had been cleared. Selection is
   * preserved — clearing the search brings the facet back exactly as it was.
   */
  disabled?: boolean;
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
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const triggerId = useId();
  const panelId = useId();
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      setOpen(false);
      // Escape from inside the panel puts the keyboard user back where they
      // opened it. Focus that has already left (an outside click, or Tab into
      // another control with its own Escape) stays where it went.
      if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
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

  // Superseding filters must not leave an open popover hanging over them.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  /**
   * What this control can show: the option universe PLUS whatever the user has
   * selected. The second half is not a nicety. Under a PR search the option list
   * can legitimately come back empty (a search that misses has no developers and
   * no models in its answer) or narrower than the selection (a hit has exactly
   * one of each) while the selection is still live in state and in the URL. Keying
   * the control off `options` alone then either hides the facet outright or shows
   * a header reading "Clear (1)" above chips that do not include the thing
   * selected — a control misreporting its own state.
   */
  const visible = useMemo(
    () => [...new Set([...options, ...selected])],
    [options, selected],
  );

  const filtered = useMemo(
    () => filterFacetOptions(visible, query, optionLabel),
    [visible, query, optionLabel],
  );

  // Nothing to offer and nothing chosen: only then is there no control.
  if (visible.length === 0) return null;

  // Below the threshold, fall back to the existing flat chip layout — keeps
  // the popover off small, fully-visible facets like EPIC/STORY/TASK/BUG.
  if (visible.length <= inlineThreshold) {
    return (
      <div>
        <FilterHeading id={headingId} label={label} count={selected.size} onClear={onClear} disabled={disabled} />
        <div role="group" aria-labelledby={headingId} className="mt-1.5 flex flex-wrap gap-1.5">
          {visible.map((t) => (
            <Chip key={t} on={selected.has(t)} onClick={() => onToggle(t)} title={t} mono disabled={disabled}>
              {optionLabel ? optionLabel(t) : t}
            </Chip>
          ))}
        </div>
      </div>
    );
  }

  const selectedArr = [...selected];

  return (
    <div ref={rootRef} className="relative">
      <FilterHeading id={headingId} label={label} count={selected.size} onClear={onClear} disabled={disabled} />

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button
          ref={triggerRef}
          id={triggerId}
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          // Named "<facet> <summary>": the summary alone ("All 12") said nothing
          // about which filter this is.
          aria-labelledby={`${headingId} ${triggerId}`}
          aria-controls={open ? panelId : undefined}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-mono text-caption border text-ink-secondary border-border-soft hover:border-accent hover:text-accent-ink transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-border-soft disabled:hover:text-ink-secondary"
          aria-expanded={open}
        >
          {selected.size === 0
            ? `All ${options.length}`
            /* `visible`, not `options`: the list this trigger opens now contains
               options ∪ selection, so quoting the option count here advertised a
               smaller facet than the popover held — reachable on Org/UserDetail
               with a stale `?projects=` link, no search involved. */
            : `${selected.size} selected · ${visible.length} total`}
          <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>

        {selectedArr.map((v) => (
          <span
            key={v}
            title={v}
            className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full font-mono text-caption border text-accent-ink border-accent bg-accent-fill max-w-[260px]"
          >
            <span className="truncate">{optionLabel ? optionLabel(v) : v}</span>
            <button
              onClick={() => onToggle(v)}
              disabled={disabled}
              aria-label={`Remove ${optionLabel ? optionLabel(v) : v}`}
              className="rounded-full hover:bg-accent-fill p-0.5 -mr-0.5 disabled:cursor-not-allowed"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>

      {open && (
        <div id={panelId} className="absolute z-20 mt-2 w-[min(420px,calc(100vw-2rem))] bg-card-glass backdrop-blur border border-border-soft rounded-xl shadow-xl overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border-soft">
            <Search className="w-3.5 h-3.5 text-ink-tertiary" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              aria-label={`Search ${label}`}
              className="flex-1 bg-transparent outline-none text-small text-ink placeholder:text-ink-tertiary"
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
          {/* A group of checkboxes, named by the facet heading: each choice
              announces its own checked state. */}
          <div role="group" aria-labelledby={headingId} className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-small text-ink-tertiary">No matches.</p>
            ) : (
              filtered.map((v) => {
                const on = selected.has(v);
                return (
                  <label
                    key={v}
                    title={v}
                    // relative: the sr-only checkbox is absolutely positioned, and
                    // must scroll with the list or a focused option stays hidden.
                    className={`relative w-full flex items-center gap-2 px-3 py-1.5 text-left text-small font-mono transition-colors cursor-pointer has-[:disabled]:cursor-not-allowed has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent ${on
                      ? 'bg-accent-fill text-accent-ink'
                      : 'text-ink hover:bg-accent-fill/50'}`}
                  >
                    <input type="checkbox" className="sr-only" checked={on} disabled={disabled} onChange={() => onToggle(v)} />
                    <span aria-hidden="true" className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${on
                      ? 'bg-accent border-accent text-surface'
                      : 'border-border-soft'}`}>
                      {on && <Check className="w-2.5 h-2.5" />}
                    </span>
                    <span className="truncate">{optionLabel ? optionLabel(v) : v}</span>
                  </label>
                );
              })
            )}
          </div>
          {selected.size > 0 && (
            <div className="flex items-center justify-between px-3 py-2 border-t border-border-soft text-caption">
              <span className="text-ink-tertiary">{selected.size} selected</span>
              <button onClick={onClear} disabled={disabled} className="font-medium text-ink-tertiary hover:text-danger-muted disabled:cursor-not-allowed disabled:opacity-50">
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
