import { ReactNode, useId, useMemo, useState } from 'react';
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

/**
 * The hub's table: sortable headers that say how they are sorted (aria-sort on
 * the header, a button inside it), stable ordering (ties keep the order rows
 * arrived in), and an optional search box over the rows. `caption` names the
 * table for assistive tech (aria-label, not a <caption>: each table already
 * sits under a visible heading that says the same).
 */
export function DataTable<T>({ caption, columns, rows, rowKey, defaultSort, search, minWidth, rowHover = false }: {
  caption: string;
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  defaultSort?: { key: string; dir: Dir };
  search?: { label: string; placeholder?: string; matches: (row: T, query: string) => boolean };
  minWidth?: number;
  /** On only where a row is itself a target: a hover promises a click. */
  rowHover?: boolean;
}) {
  const [sort, setSort] = useState<{ key: string; dir: Dir } | null>(defaultSort ?? null);
  const [query, setQuery] = useState('');
  const searchId = useId();

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
              className="w-full rounded-lg border border-border-soft bg-surface pl-8 pr-2 py-1.5 text-[12px] text-ink placeholder:text-ink-tertiary"
            />
          </div>
        </div>
      )}
      <div className="overflow-x-auto">
        <table aria-label={caption} className="w-full text-sm" style={minWidth ? { minWidth } : undefined}>
          <thead>
            <tr className="text-left font-mono text-[10px] uppercase tracking-[0.08em] text-ink-tertiary">
              {columns.map(col => {
                const active = sort?.key === col.key;
                const ariaSort = col.sortValue ? (active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined;
                const Icon = !active ? ArrowUpDown : sort!.dir === 'asc' ? ArrowUp : ArrowDown;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={ariaSort}
                    className={cn('px-3 py-2 font-semibold first:pl-5 last:pr-5', col.align === 'right' && 'text-right', col.className)}
                  >
                    {col.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggle(col)}
                        className={cn(
                          'inline-flex items-center gap-1 uppercase tracking-[0.08em] hover:text-ink',
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
          <p className="px-5 py-6 text-center text-sm text-ink-tertiary">No rows match “{query.trim()}”.</p>
        )}
      </div>
    </div>
  );
}
