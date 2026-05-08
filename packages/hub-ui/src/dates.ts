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
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(input: string | number | Date): string {
  const d = parseAsUtc(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return d.toLocaleDateString();
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
  return d.toLocaleDateString();
}

export function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}
