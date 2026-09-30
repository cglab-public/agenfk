/**
 * The dashboards' filter bar (Org, the user page, PR overview).
 *
 * Collapsed by default: the first screen of a dashboard is its data, not its
 * facet chips (Hub UI review). Three behaviours are load-bearing:
 *
 *  - **Collapsed does not mean inactive.** The filters keep applying while
 *    hidden, so one summary line is always shown ("30 days · item.closed · all
 *    projects"), built from the live selection so it cannot drift from it.
 *  - **Open/closed survives a reload and a shared link**: the caller keeps it
 *    in the URL (`filters=1`), like every other piece of filter state.
 *  - **Controls that outrank the facets stay out of the fold**: the caller puts
 *    the period (and PR overview's PR search) in its always-visible toolbar.
 */
import { useId, type ReactNode } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';

export const FILTERS_OPEN = 'filters';

/** Parse the open flag out of the URL. Absent (or an old `filters=0`) = collapsed. */
export function parseFiltersOpen(raw: string | null): boolean {
  if (raw === null) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true';
}

interface Props {
  /** Number of facets with at least one selection — drives the badge. */
  activeCount: number;
  /** What the filters apply, in one line — always shown. See describeFilters. */
  summary: string;
  children: ReactNode;
  /**
   * Controlled: the caller owns open/closed (it lives in the URL), so the bar
   * can never disagree with the address bar after a navigation.
   */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FilterAccordion({
  activeCount,
  summary,
  children,
  open,
  onOpenChange,
}: Props) {
  const id = useId();
  const headingId = `${id}-heading`;
  const bodyId = `${id}-body`;
  const toggle = () => onOpenChange(!open);

  return (
    <section className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl overflow-hidden">
      <h2 id={headingId} className="sr-only">Filters</h2>
      <div className="flex items-center gap-2.5 px-5 py-2.5">
        <SlidersHorizontal className="w-4 h-4 text-ink-tertiary shrink-0" aria-hidden="true" />
        <p data-filter-summary className="min-w-0 flex-1 truncate text-[12px] text-ink-secondary" title={summary}>{summary}</p>
        {activeCount > 0 && (
          <span
            className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono border text-accent-ink border-accent bg-accent-fill"
            title={`${activeCount} filter${activeCount === 1 ? '' : 's'} active`}
          >
            {activeCount} active
          </span>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] font-semibold text-accent-ink hover:bg-accent-fill/40 transition-colors"
        >
          {open ? 'Hide filters' : 'Edit filters'}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </div>

      <div
        id={bodyId}
        // `hidden`, rendered, not set in an effect: an effect runs after the
        // first paint, so every load flashed the whole fold open. And hidden
        // (not just visually collapsed) keeps the controls out of the tab order.
        hidden={!open}
        role="region"
        aria-labelledby={headingId}
        className="px-5 pb-4 pt-1 space-y-4 border-t border-border-soft"
      >
        {children}
      </div>
    </section>
  );
}
