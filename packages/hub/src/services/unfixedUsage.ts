import { DB } from '../db.js';
import { compareSemver, semverOrNull } from '../util/semver.js';

/**
 * GH-398: usage from agenfk versions before the subagent attribution fix.
 *
 * Before it, parallel subagents of one Claude Code session charged their usage
 * to each other's cards, and the hub cannot tell which of the usage it was
 * sent is wrong. So it keeps none of it: the usage an event carries is dropped
 * at ingest when the sender's version is older than the fix (or unknown), and
 * the usage already stored from such senders is cleared once on upgrade. The
 * events themselves are kept. A cleared step reads as unmeasured, a cleared
 * no-card total as zero: no usage, as for any period without any.
 *
 * USAGE_FIXED_VERSION is the first agenfk version whose usage the hub keeps.
 */
export const USAGE_FIXED_VERSION = '2.1.0-beta.21';

export const CLEAR_UNFIXED_USAGE_MIGRATION = 'migration:clear_unfixed_usage:gh398:v1';

const CARD_USAGE_TYPES = new Set(['step.transitioned', 'item.closed']);
const NO_CARD_TYPE = 'usage.no-card';

/** Whether usage sent by this version (an X-Agenfk-Version, a child hub's version) is kept. */
export function usageTrustedFrom(version: string | null | undefined): boolean {
  const v = semverOrNull(version);
  if (!v) return false;
  return compareSemver(v.replace(/^v/, ''), USAGE_FIXED_VERSION) >= 0;
}

/**
 * Drops the usage an event's payload carries, in place. Returns whether there
 * was any. A no-card total keeps an empty usage, so it still reads as a total
 * (of nothing) rather than a malformed send.
 */
export function dropUsage(e: { type?: unknown; payload?: any }): boolean {
  const p = e?.payload;
  if (!p || typeof p !== 'object' || !('usage' in p)) return false;
  if (CARD_USAGE_TYPES.has(String(e.type))) {
    delete p.usage;
    return true;
  }
  if (e.type === NO_CARD_TYPE) {
    if (Array.isArray(p.usage?.byModel) && p.usage.byModel.length === 0 && Object.keys(p.usage).length === 1) return false;
    p.usage = { byModel: [] };
    return true;
  }
  return false;
}

export interface ClearUnfixedUsageResult {
  skipped: boolean;
  eventsCleared: number;
}

const PAGE = 1000;
const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * One-off: clear the usage stored from versions without the fix - every
 * usage-bearing event whose reporting version is older than it or unknown
 * (a forwarded event has none: its child hub's senders cannot be told apart).
 * Runs once (a system_state marker); `force` runs it again.
 */
export async function clearUnfixedUsage(
  db: DB,
  opts: { force?: boolean; pageSize?: number } = {},
): Promise<ClearUnfixedUsageResult> {
  if (!opts.force) {
    const done = await db.get('SELECT value FROM system_state WHERE key = ?', [CLEAR_UNFIXED_USAGE_MIGRATION]);
    if (done) return { skipped: true, eventsCleared: 0 };
  }
  const pageSize = opts.pageSize ?? PAGE;
  let eventsCleared = 0;
  const outboxCleared = await clearQueuedUsage(db);
  let after = '';
  for (;;) {
    const rows = await db.all<{ event_id: string; reporting_version: string | null; payload: string }>(
      `SELECT event_id, reporting_version, payload FROM events
        WHERE type IN ('step.transitioned', 'item.closed', 'usage.no-card') AND event_id > ?
        ORDER BY event_id LIMIT ?`,
      [after, pageSize],
    );
    if (rows.length === 0) break;
    after = rows[rows.length - 1].event_id;
    for (const row of rows) {
      if (usageTrustedFrom(row.reporting_version)) continue;
      let stored: any;
      try { stored = JSON.parse(row.payload); } catch { continue; }
      if (!dropUsage(stored)) continue;
      await db.run('UPDATE events SET payload = ? WHERE event_id = ?', [JSON.stringify(stored), row.event_id]);
      eventsCleared++;
    }
    await yieldToEventLoop();
  }
  const result = { skipped: false, eventsCleared };
  await db.run(
    `INSERT INTO system_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [CLEAR_UNFIXED_USAGE_MIGRATION, JSON.stringify({ ...result, outboxCleared, at: new Date().toISOString() })],
  );
  return result;
}

/**
 * Events queued for a parent hub carry their payload as serialised at the
 * time: an event this hub stored from an unfixed version loses its usage in
 * the queue too, or the parent would take it from this hub's newer version.
 */
async function clearQueuedUsage(db: DB): Promise<number> {
  let cleared = 0;
  const rows = await db.all<{ seq: number; payload: string }>(
    "SELECT seq, payload FROM federation_outbox WHERE kind = 'event' ORDER BY seq",
  );
  for (const row of rows) {
    let queued: any;
    try { queued = JSON.parse(row.payload); } catch { continue; }
    const e = queued?.event;
    if (!e || typeof e.eventId !== 'string') continue;
    const source = await db.get<{ reporting_version: string | null }>(
      'SELECT reporting_version FROM events WHERE event_id = ?', [e.eventId],
    );
    if (usageTrustedFrom(source?.reporting_version ?? null)) continue;
    if (!dropUsage(e)) continue;
    await db.run('UPDATE federation_outbox SET payload = ? WHERE seq = ?', [JSON.stringify(queued), row.seq]);
    cleared++;
  }
  return cleared;
}
