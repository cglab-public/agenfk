/**
 * Accordion wrapper for the PR Overview filter bar (CGLAB-133 follow-up).
 *
 * The facets (Project / Developer / Model) each render a label row plus a chip
 * row, and stacked they were eating most of the first screen before any chart
 * was visible. This collapses them behind one summary row.
 *
 * Two behaviours that are load-bearing, not decoration:
 *
 *  - **Collapsed does not mean inactive.** The filters keep applying while
 *    hidden, so the summary row must show how many facets are active —
 *    otherwise a collapsed bar silently reports numbers from a filtered
 *    window and the reader has no idea. The count is derived from the live
 *    selection, never stored, so it cannot drift from the filters.
 *  - **Open/closed survives a reload and a shared link**, matching every other
 *    piece of filter state on this page: it is kept in the URL (`filters=0`),
 *    not in localStorage, so a bookmarked view restores the same layout.
 *
 * Open by default. Hiding the controls on first visit would be a regression
 * for anyone who has not discovered them yet.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';

export const FILTERS_OPEN = 'filters';

/** Parse the collapsed flag out of the URL. Absent param = open. */
export function parseFiltersOpen(raw: string | null): boolean {
  // Only an explicit "0"/"false" collapses; anything else (including a
  // hand-edited `filters=1` or garbage) leaves the bar open.
  if (raw === null) return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false');
}

interface Props {
  /** Number of facets with at least one selection — drives the badge. */
  activeCount: number;
  /** Label of each active facet, e.g. "Model: 2" — shown when collapsed. */
  activeSummary: string[];
  children: ReactNode;
  initialOpen: boolean;
  /** Called whenever the user toggles the section, so the caller can sync the URL. */
  onOpenChange: (open: boolean) => void;
}

export function FilterAccordion({
  activeCount,
  activeSummary,
  children,
  initialOpen,
  onOpenChange,
}: Props) {
  const [open, setOpen] = useState(initialOpen);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headingId = 'pr-overview-filters-heading';

  // Keep focus reachable when the section is collapsed: a hidden-but-still
  // focusable control is the classic keyboard trap, so the body is removed
  // from the tab order via `hidden` rather than only being visually collapsed.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.hidden = !open;
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    onOpenChange(next);
  };

  return (
    <section className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl overflow-hidden">
      <h2 id={headingId} className="sr-only">Filters</h2>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls="pr-overview-filters-body"
        className="w-full flex items-center gap-2.5 px-5 py-3 text-left hover:bg-chip/40 transition-colors"
      >
        <SlidersHorizontal className="w-4 h-4 text-ink-tertiary shrink-0" aria-hidden="true" />
        <span className="text-sm font-semibold text-ink">Filters</span>

        {activeCount > 0 && (
          <span
            className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono border text-accent-text border-border-brand bg-chip"
            title={`${activeCount} filter${activeCount === 1 ? '' : 's'} active`}
          >
            {activeCount} active
          </span>
        )}

        {!open && activeSummary.length > 0 && (
          <span className="hidden md:flex items-center gap-1.5 min-w-0 text-[11px] font-mono text-ink-tertiary truncate">
            {activeSummary.map(s => (
              <span key={s} className="truncate max-w-[220px]">{s}</span>
            ))}
          </span>
        )}

        <ChevronDown
          className={`w-4 h-4 ml-auto text-ink-tertiary shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      <div
        id="pr-overview-filters-body"
        ref={bodyRef}
        role="region"
        aria-labelledby={headingId}
        className="px-5 pb-4 pt-1 space-y-4 border-t border-border-soft"
      >
        {children}
      </div>
    </section>
  );
}
