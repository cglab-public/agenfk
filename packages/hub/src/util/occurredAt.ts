/**
 * The one form the hub stores an event's time in: `Date#toISOString()`
 * (GH-391, BUG 4f507284).
 *
 * SQLite keeps events.occurred_at as TEXT and compares strings; Postgres keeps
 * TIMESTAMPTZ and compares instants. They agree only when every row is spelled
 * the same way, so ingest stores this form and refuses what has none.
 *
 * Only ISO 8601 is read: a date, optionally a time ('T', 't' or a space before
 * it), optionally an offset. A timestamp with no offset is UTC, as SQLite's
 * date() and Postgres' ::timestamptz on a UTC hub read it. `Date.parse` alone
 * would read it, and any non-ISO string it happens to accept ('Thu, 19 Nov 2026
 * 10:00'), in the host's zone, so those are refused rather than guessed at.
 * Null too for a year outside 0001-9999: a six-digit year's ISO string
 * ('+010000-...') sorts before every other row, and Postgres has no year 0.
 */
const ISO_TIMESTAMP = /^(\d{4})-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?([zZ]|[+-]\d{2}:?\d{2})?)?$/;

export function canonicalOccurredAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = ISO_TIMESTAMP.exec(value);
  if (!m) return null;
  const hasTime = value.length > 10;
  const normalised = hasTime ? `${value.slice(0, 10)}T${value.slice(11)}${m[2] ? '' : 'Z'}` : value;
  const t = Date.parse(normalised);
  if (!Number.isFinite(t)) return null;
  // The UTC year, not the one written: an offset can carry 0001-01-01T00:00+01:00
  // into year 0, or 9999-12-31T23:00-02:00 into year 10000.
  const year = new Date(t).getUTCFullYear();
  return year >= 1 && year <= 9999 ? new Date(t).toISOString() : null;
}
