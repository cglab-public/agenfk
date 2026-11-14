// Re-files the histogram's hourly groups into the viewer's local days or hours
// (BUG 27ede354). SQLite has no time zones, so the SQL groups by UTC hour —
// shifted by the zone's sub-hour offset so a :30 or :45 zone's local hours line
// up — and this places each hour by the zone's rules for ITS date. A single
// offset could not: a January range seen from July sat an hour off.
import type { HistogramRow } from './histogram-aggregate.js';

/** The part of an offset below a whole hour, as minutes in 0–59. DST moves
 *  whole hours almost everywhere, so this is one value per zone across the
 *  year. The exception is Australia/Lord_Howe (+10:30 / +11:00): for a range
 *  in its other season, up to 30 minutes at each local hour edge are filed
 *  under the neighbouring hour. Accepted, as the one zone it affects. */
export function subHourShift(tzOffsetMin: number): number {
  return ((tzOffsetMin % 60) + 60) % 60;
}

/** The zone's offset from UTC in minutes EAST at an instant, by Intl. */
export function zoneOffsetMin(timeZone: string, at: number): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at).find(p => p.type === 'timeZoneName')?.value ?? 'GMT';
  // "GMT", "GMT+5:30", "GMT-03:30"
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === '-' ? -mins : mins;
}

/** True when the runtime knows the zone. */
export function isKnownTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; }
}

/**
 * `rows` are grouped by 'YYYY-MM-DDTHH:00' of (occurred_at + shift minutes) in
 * UTC. Each hour's real start is that minus the shift; it is filed under its
 * local day ('YYYY-MM-DD') or hour ('YYYY-MM-DDTHH:00') in `timeZone`, with
 * counts summed per (local bucket, type) and the result ordered by time.
 */
export function rebucketToZone(
  rows: ReadonlyArray<HistogramRow>,
  timeZone: string,
  shift: number,
  bucket: 'day' | 'hour',
): Array<{ time: string; type: string; n: number }> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  });
  const sums = new Map<string, { time: string; type: string; n: number }>();
  // Many types share an hour: work out each hour's local key once.
  const keyOf = new Map<string, string | null>();
  const localKey = (t: string): string | null => {
    if (keyOf.has(t)) return keyOf.get(t)!;
    const start = Date.parse(`${t.length === 10 ? `${t}T00:00` : t}:00Z`) - shift * 60_000;
    let key: string | null = null;
    if (!Number.isNaN(start)) {
      const p = Object.fromEntries(parts.formatToParts(start).map(x => [x.type, x.value]));
      key = bucket === 'day' ? `${p.year}-${p.month}-${p.day}` : `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
    }
    keyOf.set(t, key);
    return key;
  };
  for (const r of rows) {
    const time = localKey(r.time);
    if (time === null) continue;
    const key = `${time}\u0000${r.type}`;
    const cur = sums.get(key) ?? { time, type: r.type, n: 0 };
    cur.n += Number(r.n) || 0;
    sums.set(key, cur);
  }
  return [...sums.values()].sort((a, b) => a.time.localeCompare(b.time) || a.type.localeCompare(b.type));
}
