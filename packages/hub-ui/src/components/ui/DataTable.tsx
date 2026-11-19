import { ReactNode, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react';
import { cn } from './cn';

export interface DataColumn<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Present = sortable. */
  sortValue?: (row: T) => string | number;
  /** Direction of the first click on this header (default ascending); counts
   *  and dates usually want 'desc'. Declared, not guessed from the data. */
  firstDir?: Dir;
  align?: 'left' | 'right';
  /** Classes for this column's header and cells (width, padding). */
  className?: string;
}

type Dir = 'asc' | 'desc';

/** A viewport-filling table never gets shorter than this, however short the window. */
export const FILL_VIEWPORT_MIN = 240;

/** Padding and border between the element's bottom and the bottom of `upTo` (its own padding included). */
function chromeBelow(el: HTMLElement, upTo: HTMLElement | null): number {
  let sum = 0;
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const cs = getComputedStyle(a);
    sum += parseFloat(cs.paddingBottom) || 0;
    if (a === upTo) break;
    sum += parseFloat(cs.borderBottomWidth) || 0;
  }
  return sum;
}

/**
 * Caps an element's height so it ends at the bottom of the view, measured from
 * where it starts. Inside the app shell the view is the scrolling pane
 * (`[data-scroll-root]`), and the position is taken within the pane's content,
 * so a pane left scrolled by another page measures the same. The padding and
 * border below come from the page itself, so they follow its breakpoints.
 * Re-measured after every render, on resize, and when the pane's content
 * changes (a banner appearing above the page does not render this table).
 */
function useFillViewport(on: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!on || !el) return;
    const root = el.closest<HTMLElement>('[data-scroll-root]');
    const top = el.getBoundingClientRect().top;
    const available = root
      ? root.clientHeight - (top - root.getBoundingClientRect().top - root.clientTop + root.scrollTop)
      : window.innerHeight - top;
    setMaxHeight(Math.max(FILL_VIEWPORT_MIN, Math.round(available - chromeBelow(el, root))));
  }, [on]);
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    if (!on) return;
    window.addEventListener('resize', measure);
    const root = ref.current?.closest<HTMLElement>('[data-scroll-root]');
    const mutations = root ? new MutationObserver(measure) : null;
    mutations?.observe(root!, { childList: true, subtree: true });
    const resizes = root && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    resizes?.observe(root!);
    return () => {
      window.removeEventListener('resize', measure);
      mutations?.disconnect();
      resizes?.disconnect();
    };
  }, [on, measure]);
  return { ref, style: on && maxHeight !== null ? { maxHeight: `${maxHeight}px`, overflowY: 'auto' as const } : undefined };
}

/**
 * The hub's table: sortable headers that say how they are sorted (aria-sort on
 * the header, a button inside it), stable ordering (ties keep the order rows
 * arrived in), and an optional search box over the rows. `caption` names the
 * table for assistive tech (aria-label, not a <caption>: each table already
 * sits under a visible heading that says the same). `fillViewport` ends the
 * rows at the bottom of the window and scrolls them there, under a header that
 * stays put; the page no longer grows with the list.
 */
export function DataTable<T>({ caption, columns, rows, rowKey, defaultSort, search, minWidth, rowHover = false, fillViewport = false }: {
  caption: string;
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  defaultSort?: { key: string; dir: Dir };
  search?: { label: string; placeholder?: string; matches: (row: T, query: string) => boolean };
  minWidth?: number;
  /** On only where a row is itself a target: a hover promises a click. */
  rowHover?: boolean;
  fillViewport?: boolean;
}) {
  const [sort, setSort] = useState<{ key: string; dir: Dir } | null>(defaultSort ?? null);
  const [query, setQuery] = useState('');
  const searchId = useId();
  const fill = useFillViewport(fillViewport);

  const shown = useMemo(() => {
    const q = query.trim();
    const filtered = search && q ? rows.filter(r => search.matches(r, q)) : rows;
    const col = sort && columns.find(c => c.key === sort.key);
    if (!col?.sortValue) return filtered;
    const value = col.sortValue;
    const sign = sort!.dir === 'asc' ? 1 : -1;
    // Index tiebreak keeps the sort stable whatever the engine does.
    return filtered
      .map((row, i) => ({ row, i, v: value(row) }))
      .sort((a, b) => {
        const c = typeof a.v === 'number' && typeof b.v === 'number'
          ? a.v - b.v
          : String(a.v).localeCompare(String(b.v), undefined, { sensitivity: 'base', numeric: true });
        return c !== 0 ? c * sign : a.i - b.i;
      })
      .map(x => x.row);
  }, [rows, columns, sort, search, query]);

  const toggle = (col: DataColumn<T>) => {
    setSort(prev => {
      if (prev?.key === col.key) return { key: col.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      return { key: col.key, dir: col.firstDir ?? 'asc' };
    });
  };

  return (
    <div>
      {search && (
        <div className="px-5 py-3 border-b border-border-soft">
          <label htmlFor={searchId} className="sr-only">{search.label}</label>
          <div className="relative max-w-xs">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-tertiary" aria-hidden="true" />
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={search.placeholder ?? search.label}
              className="w-full rounded-lg border border-border-soft bg-surface pl-8 pr-2 py-1.5 text-small text-ink placeholder:text-ink-tertiary"
            />
          </div>
        </div>
      )}
      <div ref={fill.ref} className="relative overflow-x-auto" style={fill.style}>
        <table aria-label={caption} className="w-full text-body" style={minWidth ? { minWidth } : undefined}>
          <thead>
            <tr className="eyebrow text-left font-mono text-ink-tertiary">
              {columns.map(col => {
                const active = sort?.key === col.key;
                const ariaSort = col.sortValue ? (active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined;
                const Icon = !active ? ArrowUpDown : sort!.dir === 'asc' ? ArrowUp : ArrowDown;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={ariaSort}
                    className={cn('px-3 py-2 font-semibold first:pl-5 last:pr-5', col.align === 'right' && 'text-right', fillViewport && 'sticky top-0 z-10 bg-surface', col.className)}
                  >
                    {col.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggle(col)}
                        className={cn(
                          'eyebrow inline-flex items-center gap-1 hover:text-ink',
                          active && 'text-ink-secondary',
                          col.align === 'right' && 'flex-row-reverse',
                        )}
                      >
                        {col.header}
                        <Icon className={cn('w-3 h-3', !active && 'opacity-40')} aria-hidden="true" />
                      </button>
                    ) : col.header}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-soft">
            {shown.map(row => (
              <tr key={rowKey(row)} className={cn(rowHover && 'hover:bg-accent-fill/50 transition-colors')}>
                {columns.map(col => (
                  <td key={col.key} className={cn('px-3 py-3 first:pl-5 last:pr-5', col.align === 'right' && 'text-right', col.className)}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {search && query.trim() && shown.length === 0 && (
          <p className="px-5 py-6 text-center text-body text-ink-tertiary">No rows match “{query.trim()}”.</p>
        )}
      </div>
    </div>
  );
}
