// Board date filter (CGLAB-444): which date a card is filtered on, and over
// what range. Pure logic + per-project persistence; the control lives in
// components/BoardDateFilter.tsx and the board applies matchesDateFilter.
//
// Every range is in LOCAL calendar days with both ends included, so "Today"
// keeps a card updated at 23:59 tonight even though that is later than now.

export type DateField = 'createdAt' | 'updatedAt';

export type DateRange =
  | { kind: 'any' }
  | { kind: 'today' }
  | { kind: 'last7' }
  | { kind: 'last30' }
  // YYYY-MM-DD local days; either end may be absent (open).
  | { kind: 'custom'; from?: string; to?: string };

export interface DateFilter {
  field: DateField;
  range: DateRange;
}

export const DEFAULT_DATE_FILTER: DateFilter = { field: 'updatedAt', range: { kind: 'any' } };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const parseDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
};

// A range typed back to front (From after To) means the days between.
const orderedEnds = (r: { from?: string; to?: string }) =>
  r.from && r.to && r.from > r.to ? { from: r.to, to: r.from } : { from: r.from, to: r.to };

export const isDateFilterActive = (f: DateFilter): boolean => {
  if (f.range.kind === 'any') return false;
  if (f.range.kind === 'custom') return Boolean(f.range.from || f.range.to);
  return true;
};

// [from, to] in epoch ms, either side open (undefined).
const bounds = (range: DateRange, now: Date): [number | undefined, number | undefined] => {
  const lastDays = (n: number): [number, number] =>
    [addDays(startOfDay(now), -(n - 1)).getTime(), endOfDay(now).getTime()];
  switch (range.kind) {
    case 'today': return lastDays(1);
    case 'last7': return lastDays(7);
    case 'last30': return lastDays(30);
    case 'custom': {
      const { from, to } = orderedEnds(range);
      return [
        from ? startOfDay(parseDay(from)).getTime() : undefined,
        to ? endOfDay(parseDay(to)).getTime() : undefined,
      ];
    }
    default: return [undefined, undefined];
  }
};

export const matchesDateFilter = (
  item: { createdAt: string; updatedAt: string },
  f: DateFilter,
  now: Date = new Date(),
): boolean => {
  if (!isDateFilterActive(f)) return true;
  const t = new Date(item[f.field]).getTime();
  if (Number.isNaN(t)) return false;
  const [from, to] = bounds(f.range, now);
  return (from === undefined || t >= from) && (to === undefined || t <= to);
};

const FIELD_LABEL: Record<DateField, string> = { createdAt: 'Created', updatedAt: 'Updated' };

export const describeDateFilter = (f: DateFilter): string => {
  const r = f.range;
  const range =
    r.kind === 'today' ? 'Today'
    : r.kind === 'last7' ? 'Last 7 days'
    : r.kind === 'last30' ? 'Last 30 days'
    : r.kind === 'custom'
      ? ((({ from, to }) => from && to ? `${from} → ${to}` : from ? `from ${from}` : `until ${to}`)(orderedEnds(r)))
    : 'Any time';
  return `${FIELD_LABEL[f.field]} · ${range}`;
};

// Shared by the empty-column state and the live-region announcement.
const rangePhrase = (r: DateRange): string =>
  r.kind === 'today' ? 'today'
  : r.kind === 'last7' ? 'in the last 7 days'
  : r.kind === 'last30' ? 'in the last 30 days'
  : 'in this date range';

const verb = (f: DateFilter) => FIELD_LABEL[f.field].toLowerCase();

export const emptyColumnMessage = (f: DateFilter): string => `No cards ${verb(f)} ${rangePhrase(f.range)}`;

export const announceDateFilter = (f: DateFilter): string =>
  isDateFilterActive(f) ? `Showing cards ${verb(f)} ${rangePhrase(f.range)}` : 'Date filter cleared';

export const dateFilterStorageKey = (projectId: string) => `agenfk_board_date_filter:${projectId}`;

// A real calendar day: 2026-02-31 matches the pattern but rolls over to March.
const isDay = (v: unknown) => {
  if (v === undefined || v === '') return true;
  if (typeof v !== 'string' || !ISO_DAY.test(v)) return false;
  const d = parseDay(v);
  const back = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return back === v;
};

const parseStored = (raw: unknown): DateFilter | null => {
  if (!raw || typeof raw !== 'object') return null;
  const { field, range } = raw as { field?: unknown; range?: { kind?: unknown; from?: unknown; to?: unknown } };
  if (field !== 'createdAt' && field !== 'updatedAt') return null;
  if (!range || typeof range !== 'object') return null;
  switch (range.kind) {
    case 'any': case 'today': case 'last7': case 'last30':
      return { field, range: { kind: range.kind } };
    case 'custom':
      if (!isDay(range.from) || !isDay(range.to)) return null;
      return {
        field,
        range: {
          kind: 'custom',
          ...(range.from ? { from: range.from as string } : {}),
          ...(range.to ? { to: range.to as string } : {}),
        },
      };
    default:
      return null;
  }
};

export const loadDateFilter = (projectId: string | null): DateFilter => {
  if (!projectId) return DEFAULT_DATE_FILTER;
  try {
    const raw = localStorage.getItem(dateFilterStorageKey(projectId));
    if (!raw) return DEFAULT_DATE_FILTER;
    return parseStored(JSON.parse(raw)) ?? DEFAULT_DATE_FILTER;
  } catch {
    return DEFAULT_DATE_FILTER;
  }
};

export const saveDateFilter = (projectId: string, f: DateFilter): void => {
  try {
    if (isDateFilterActive(f)) localStorage.setItem(dateFilterStorageKey(projectId), JSON.stringify(f));
    else localStorage.removeItem(dateFilterStorageKey(projectId));
  } catch {
    // Storage unavailable (private mode, quota): the filter still works for
    // this page, it just will not survive a reload.
  }
};
