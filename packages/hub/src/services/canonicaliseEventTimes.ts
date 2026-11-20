import { DB } from '../db.js';
import { canonicalOccurredAt } from '../util/occurredAt.js';
import { recomputeRollups } from '../rollup.js';

/**
 * One-time rewrite of event times stored before ingest canonicalised them
 * (GH-391, BUG 4f507284).
 *
 * Only a SQLite hub needs it: its occurred_at is TEXT, compared as text, so a
 * row spelled '...10:00:00Z' or '...09:30:00-03:00' filters and sorts apart
 * from the same instant in the stored form. Postgres keeps TIMESTAMPTZ, which
 * hands back Date objects, so the scan finds nothing to rewrite there.
 *
 * Rollups bucket by SQLite's date(occurred_at), which mostly agrees with the
 * canonical day but not always: '...T24:00:00Z' is the same day to date() and
 * the next to toISOString(), and date() cannot read '+0530' or a lowercase 't'
 * at all, so those rows were in no rollup. The days a page moves rows out of
 * and into are rebuilt from scratch (the recompute only upserts, so a group
 * that left a day would otherwise keep its stale row). They are recorded as
 * pending before the rewrite and cleared after the rebuild, so a run cut short
 * in between repairs them on the next boot.
 *
 * A row that does not parse is counted and kept, never deleted; the usage
 * overview already skips those (malformedEvents).
 */

export const CANONICAL_EVENT_TIMES_MIGRATION = 'migration:canonical_event_times:v1';
/** Rollup days a page is rewriting, until they are rebuilt. */
export const CANONICAL_EVENT_TIMES_PENDING_DAYS = 'migration:canonical_event_times:v1:pending_days';

export interface CanonicalEventTimesResult {
  skipped: boolean;
  eventsRewritten: number;
  unparseable: number;
  daysRecomputed: number;
}

/** Rows read per page: bounded memory, and a bounded stretch between yields. */
const PAGE = 1000;

/**
 * Let the event loop run. The SQLite adapter is synchronous, so its promises are
 * already settled and awaiting them yields only to microtasks: without this, a
 * boot over a large history would hold every request and health check until
 * the whole scan finished.
 */
const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

export async function canonicaliseEventTimes(
  db: DB,
  opts: { force?: boolean; pageSize?: number } = {},
): Promise<CanonicalEventTimesResult> {
  const pageSize = opts.pageSize ?? PAGE;
  if (!opts.force) {
    const done = await db.get('SELECT value FROM system_state WHERE key = ?', [CANONICAL_EVENT_TIMES_MIGRATION]);
    if (done) return { skipped: true, eventsRewritten: 0, unparseable: 0, daysRecomputed: 0 };
  }

  let eventsRewritten = 0;
  let unparseable = 0;
  // A previous run that stopped between a page's rewrite and its rebuild.
  const leftOver = await db.get<{ value: string }>('SELECT value FROM system_state WHERE key = ?', [CANONICAL_EVENT_TIMES_PENDING_DAYS]);
  let daysRecomputed = leftOver ? await rebuildDays(db, JSON.parse(leftOver.value)) : 0;
  // Keyset over the primary key, so a rewrite (which never changes event_id)
  // cannot move a row into or out of a page still to be read.
  let after = '';
  for (;;) {
    const rows = await db.all<{ event_id: string; occurred_at: unknown; old_day: string | null; payload: string | null }>(
      'SELECT event_id, occurred_at, date(occurred_at) AS old_day, payload FROM events WHERE event_id > ? ORDER BY event_id LIMIT ?',
      [after, pageSize],
    );
    if (rows.length === 0) break;
    after = rows[rows.length - 1].event_id;
    const rewrites: Array<{ row: typeof rows[number]; canonical: string }> = [];
    const days = new Set<string>();
    for (const row of rows) {
      // Postgres: a TIMESTAMPTZ comes back as a Date, already an instant.
      if (typeof row.occurred_at !== 'string') continue;
      const canonical = canonicalOccurredAt(row.occurred_at);
      if (canonical === null) { unparseable++; continue; }
      if (canonical === row.occurred_at) continue;
      rewrites.push({ row, canonical });
      if (row.old_day) days.add(row.old_day);
      days.add(canonical.slice(0, 10));
    }
    if (rewrites.length > 0) {
      await setState(db, CANONICAL_EVENT_TIMES_PENDING_DAYS, JSON.stringify([...days]));
      for (const { row, canonical } of rewrites) {
        await db.run(
          'UPDATE events SET occurred_at = ?, payload = ? WHERE event_id = ? AND occurred_at = ?',
          [canonical, withOccurredAt(row.payload, canonical), row.event_id, row.occurred_at],
        );
        eventsRewritten++;
      }
      daysRecomputed += await rebuildDays(db, [...days]);
    }
    await yieldToEventLoop();
  }

  const result: CanonicalEventTimesResult = { skipped: false, eventsRewritten, unparseable, daysRecomputed };
  await setState(db, CANONICAL_EVENT_TIMES_MIGRATION, JSON.stringify(result));
  return result;
}

/** Rebuild these rollup days from their events, then clear them from the pending record. */
async function rebuildDays(db: DB, days: string[]): Promise<number> {
  for (const day of days) {
    await db.run('DELETE FROM rollups_daily WHERE day = ?', [day]);
    await recomputeRollups(db, { days: [day] });
  }
  await db.run('DELETE FROM system_state WHERE key = ?', [CANONICAL_EVENT_TIMES_PENDING_DAYS]);
  return days.length;
}

async function setState(db: DB, key: string, value: string): Promise<void> {
  await db.run(
    `INSERT INTO system_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

/** The stored event with its time in the stored form; unchanged if it is not a JSON object. */
function withOccurredAt(payload: string | null, occurredAt: string): string | null {
  if (payload == null) return payload;
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return payload;
    return JSON.stringify({ ...parsed, occurredAt });
  } catch {
    return payload;
  }
}
