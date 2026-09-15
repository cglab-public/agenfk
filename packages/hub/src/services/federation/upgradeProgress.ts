import type { DB } from '../../db.js';
import { enqueueOutbox } from './federationSync.js';

/**
 * A child telling its parent how the group upgrade is actually going
 * (CGLAB-183, task 3).
 *
 * The parent never assumes. It served a directive; what that did to a fleet of
 * machines it cannot see is the child's to report, and the target row stays
 * `pending` until it does.
 *
 * Cadence is ON CHANGE plus a final completion (confirmed with the user). A
 * report goes out only when the counts actually move, and always one when the
 * dispatch finishes, so the parent's board stays live without an event per
 * child per minute for the length of a rollout.
 */

export interface UpgradeCounts {
  pending: number;
  updated: number;
  failed: number;
  skipped: number;
}

interface FanoutRow {
  dispatch_id: string;
  outcome: string;
  directive_id: string | null;
  skipped_json: string;
  reported_seq: number | string;
  reported_json: string | null;
}

/** Local target states, mapped to what the parent's board shows. */
const countsFor = async (db: DB, directiveId: string | null): Promise<UpgradeCounts> => {
  const base: UpgradeCounts = { pending: 0, updated: 0, failed: 0, skipped: 0 };
  if (!directiveId) return base;
  const rows = await db.all<{ state: string; n: number | string }>(
    'SELECT state, COUNT(*) AS n FROM upgrade_directive_targets WHERE directive_id = ? GROUP BY state',
    [directiveId],
  );
  for (const r of rows) {
    const n = Number(r.n ?? 0);
    // 'cancelled' deliberately lands in `failed` rather than a fifth bucket:
    // from the parent's side the machine did not take the upgrade, and the
    // reason is the child's local business.
    if (r.state === 'succeeded') base.updated += n;
    else if (r.state === 'failed' || r.state === 'cancelled') base.failed += n;
    else base.pending += n;
  }
  return base;
};

const parseSkips = (raw: string | null): unknown[] => {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch { return []; }
};

/**
 * Send a progress report for every dispatch whose picture has changed.
 *
 * Returns how many reports were queued, which is 0 on a quiet tick — the
 * common case once a rollout has settled.
 */
export async function reportUpgradeProgress(db: DB, orgId: string): Promise<number> {
  const rows = await db.all<FanoutRow>(
    `SELECT dispatch_id, outcome, directive_id, skipped_json, reported_seq, reported_json
       FROM upgrade_dispatch_fanout
      WHERE org_id = ?
      ORDER BY dispatch_id`,
    [orgId],
  );

  let sent = 0;
  for (const row of rows) {
    const counts = await countsFor(db, row.directive_id);
    const skipped = parseSkips(row.skipped_json);
    counts.skipped = skipped.length;
    // Nothing left in flight. A fan-out that had nothing to do is complete the
    // moment it happens — otherwise a hub whose whole fleet was skipped would
    // sit on the parent's board as pending forever.
    const completed = counts.pending === 0;

    const snapshot = JSON.stringify({ counts, completed });
    if (row.reported_json === snapshot) continue;   // nothing moved

    const seq = Number(row.reported_seq ?? 0) + 1;
    // The sequence is IN the event id. These reports supersede one another, so
    // a stable per-dispatch id would make every later report a duplicate the
    // parent drops; the sequence is what lets a newer one land while a
    // redelivery of the same one still dedups.
    await enqueueOutbox(db, 'event', {
      event: {
        eventId: `upgrade-dispatch:${row.dispatch_id}:${seq}`,
        type: 'fleet:upgrade-dispatch:progress',
        occurredAt: new Date().toISOString(),
        userKey: 'system',
        payload: { dispatchId: row.dispatch_id, seq, counts, completed, skipped },
      },
    });
    await db.run(
      'UPDATE upgrade_dispatch_fanout SET reported_seq = ?, reported_json = ? WHERE dispatch_id = ? AND org_id = ?',
      [seq, snapshot, row.dispatch_id, orgId],
    );
    sent++;
  }
  return sent;
}
