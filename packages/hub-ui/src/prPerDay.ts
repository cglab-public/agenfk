// Pure helpers for the PR Overview "Per developer, per day" heatmap redesign —
// kept out of the component so they can be unit-tested without a DOM (see
// prOverview.ts for the same pattern).

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export interface MonthBand { label: string; span: number }

/** Collapse a day axis (YYYY-MM-DD, ascending) into month bands: each band's
 *  `span` is the number of consecutive axis days in that calendar month, so the
 *  header row can render one label spanning exactly its columns. Bands are keyed
 *  by year+month, so the same month across years yields two bands. */
export function buildMonthBands(axis: string[]): MonthBand[] {
  const out: Array<MonthBand & { key: string }> = [];
  for (const day of axis) {
    const key = day.slice(0, 7); // YYYY-MM
    const last = out[out.length - 1];
    if (last && last.key === key) last.span++;
    else out.push({ key, label: MONTHS[Number(day.slice(5, 7)) - 1], span: 1 });
  }
  return out.map(({ label, span }) => ({ label, span }));
}

export interface DayHeader {
  weekday: string;   // 'Sun' … 'Sat'
  dayNum: number;    // 1–31
  isWeekend: boolean;
  isToday: boolean;
}

/** Per-column header info for one axis day (UTC). `today` is the reference
 *  date (YYYY-MM-DD) — injected rather than read from the clock so it's
 *  deterministic under test. */
export function dayHeaderInfo(day: string, today?: string): DayHeader {
  const d = new Date(day.slice(0, 10) + 'T00:00:00Z');
  const wd = d.getUTCDay();
  return {
    weekday: WEEKDAYS[wd],
    dayNum: d.getUTCDate(),
    isWeekend: wd === 0 || wd === 6,
    isToday: day === today,
  };
}

export interface ContributionPcts { prPct: number; ptsPct: number }

/** A developer's rounded share of the period's PR count and of its weighted
 *  size points. Zero totals yield 0 (no division by zero). */
export function contributionPcts(
  dev: { prs: number; sizePoints: number },
  totals: { prs: number; sizePoints: number },
): ContributionPcts {
  return {
    prPct: totals.prs > 0 ? Math.round((dev.prs / totals.prs) * 100) : 0,
    ptsPct: totals.sizePoints > 0 ? Math.round((dev.sizePoints / totals.sizePoints) * 100) : 0,
  };
}

/** Tooltip text for one heatmap cell. Every cell gets one — including 0-count
 *  cells, whose missing tooltip was part of the original hover bug. */
export function cellTooltip(userKey: string, day: string, count: number): string {
  const { weekday } = dayHeaderInfo(day);
  return `${userKey} · ${weekday} ${day}: ${count} PR${count === 1 ? '' : 's'}`;
}
