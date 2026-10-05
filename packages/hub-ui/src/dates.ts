// Centralised date parsing/formatting for the hub UI. All timestamps stored
// by the hub are conceptually UTC, but their on-the-wire form varies:
//
//   "2026-05-04T22:07:38.123Z"   — agenfk client events (Date.toISOString)
//   "2026-05-04 22:07:38"         — SQLite default datetime('now')
//
// JS' `new Date(...)` parses the second form as *local* in most engines,
// which makes a UTC-clock value look like a local one and misleads users
// into thinking the UI is displaying UTC. parseAsUtc() forces UTC parsing
// for the SQLite-default form so toLocaleString always converts cleanly.

const SQLITE_DEFAULT_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

export function parseAsUtc(input: string | number | Date): Date {
  if (input instanceof Date) return input;
  if (typeof input === 'number') return new Date(input);
  if (SQLITE_DEFAULT_TS.test(input)) return new Date(input.replace(' ', 'T') + 'Z');
  return new Date(input);
}

export function fmtDateTime(input: string | number | Date): string {
  const d = parseAsUtc(input);
  if (Number.isNaN(d.getTime())) return String(input);
  // The year only when it is not this one: "Mar 5, 2024, 10:00" vs "Sep 30, 22:14".
  const year = d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {};
  return d.toLocaleString(undefined, { ...year, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// The one rule for showing time in the hub: the viewer's local zone, with the
// UTC instant on hover (see components/ui/LocalTime). Dates use one format with
// the month spelled, because 9/30/2026 and 30/09/2026 next to each other (and
// next to a date input in the browser's own order) are ambiguous.
const DATE_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

export function fmtDate(input: string | number | Date): string {
  const d = parseAsUtc(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return d.toLocaleDateString(undefined, DATE_FORMAT);
}

/** The UTC instant, for a hover title: "2026-09-30 22:14:05 UTC". Empty for
 *  something that is not a time. */
export function utcTitle(input: string | number | Date): string {
  const d = parseAsUtc(input);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** A real calendar date as a date input writes it (YYYY-MM-DD). Values come
 *  from shared links, so "garbage" and 2026-02-30 both reach this. */
export function isDateInput(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The first instant of a date input's LOCAL day, as ISO; '' (no bound) for
 *  anything that is not a real date. */
export function startOfLocalDay(value: string): string {
  return isDateInput(value) ? new Date(`${value}T00:00:00`).toISOString() : '';
}

/** The last instant of a date input's LOCAL day, as ISO; '' (no bound) for
 *  anything that is not a real date. */
export function endOfLocalDay(value: string): string {
  return isDateInput(value) ? new Date(`${value}T23:59:59.999`).toISOString() : '';
}

export function fmtRelative(input: string | number | Date): string {
  const d = parseAsUtc(input);
  if (Number.isNaN(d.getTime())) return String(input);
  const diff = Date.now() - d.getTime();
  const m = 60_000, h = 3600_000, day = 86400_000;
  if (diff < m)        return 'just now';
  if (diff < h)        return `${Math.floor(diff / m)}m ago`;
  if (diff < day)      return `${Math.floor(diff / h)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return d.toLocaleDateString(undefined, DATE_FORMAT);
}

/** The browser's IANA zone, or null when it cannot name one (never a made-up
 *  'UTC', which a server would then trust over the real offset). */
export function browserTimezone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; }
  catch { return null; }
}

/**
 * " (<date, time>)" for a control's accessible name, or "" when there is no
 * time. Two actions on the same version (an upgrade, a dispatch) differ only
 * by when they were issued, so their names need it to be told apart.
 */
export function issuedAt(input: string | null | undefined): string {
  return input ? ` (${fmtDateTime(input)})` : '';
}
