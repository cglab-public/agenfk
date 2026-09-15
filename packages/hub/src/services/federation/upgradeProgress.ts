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

/** Whether a stored snapshot already says the dispatch finished. */
const isCompleteSnapshot = (raw: string): boolean => {
  try { return JSON.parse(raw)?.completed === true; } catch { return false; }
};

/**
 * The skip list as it goes UPSTREAM.
 *
 * A machine skipped because its owner is hidden loses its id. Hiding someone
 * is a promise that they stop emitting go-forward data (CGLAB-31), and a list
 * naming their installations breaks that promise as surely as forwarding their
 * events would — more quietly, too, because the progress report is deliberately
 * exempt from the hidden-user filter at the other end, so nothing catches it
 * there.
 *
 * The COUNT still travels: the parent needs the fleet arithmetic to add up, and
 * "one machine was skipped because its owner is hidden" discloses nothing about
 * who that is. Only the identity is withheld, and only upstream — this hub's
 * own record keeps it, because it is this hub's fleet.
 */
const parseSkips = (raw: string | null): unknown[] => {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    if (!Array.isArray(p)) return [];
    return p.map((sk: any) => (sk?.reason === 'hidden'
      ? { reason: 'hidden' }
      : sk));
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
    // A dispatch already reported complete cannot change again, so it is
    // skipped before the per-row COUNT query rather than re-derived on every
    // tick forever. A re-serve clears reported_json, which is what puts a
    // dispatch back in play when a report was lost.
    if (row.reported_json && isCompleteSnapshot(row.reported_json)) continue;

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
    // enqueueOutbox returns false rather than throwing when this hub has no
    // usable binding or the payload will not serialise. Advancing the
    // bookkeeping on a report that was never queued loses it for good.
    // The sequence is IN the event id. These reports supersede one another, so
    // a stable per-dispatch id would make every later report a duplicate the
    // parent drops; the sequence is what lets a newer one land while a
    // redelivery of the same one still dedups.
    const queued = await enqueueOutbox(db, 'event', {
      event: {
        eventId: `upgrade-dispatch:${row.dispatch_id}:${seq}`,
        type: 'fleet:upgrade-dispatch:progress',
        occurredAt: new Date().toISOString(),
        userKey: 'system',
        payload: { dispatchId: row.dispatch_id, seq, counts, completed, skipped },
      },
    });
    if (!queued) continue;
    await db.run(
      'UPDATE upgrade_dispatch_fanout SET reported_seq = ?, reported_json = ? WHERE dispatch_id = ? AND org_id = ?',
      [seq, snapshot, row.dispatch_id, orgId],
    );
    sent++;
  }
  return sent;
}
