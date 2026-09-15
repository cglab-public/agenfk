import type { DB } from '../../db.js';

/**
 * A child stopping a group upgrade its parent asked it to stop
 * (CGLAB-183, task 4).
 *
 * Its own module rather than a second thing inside upgradeFanout: a cancel is
 * a DIFFERENT directive, not the other half of the fan-out exchange, and a
 * file named for fanning out is the wrong place to look for the code that
 * stops it.
 */
export interface UpgradeCancel {
  kind?: string;
  dispatchId?: string;
}

export interface UpgradeCancelResult {
  /** Installations stopped before they started. */
  cancelled: number;
  error?: string;
}

/**
 * A child stopping the group upgrade its parent asked it to stop
 * (CGLAB-183, task 4).
 *
 * It cancels only what had not started, exactly as this hub's own
 * POST /upgrade/:id/cancel does: a machine that already took the upgrade
 * cannot be un-upgraded, and pretending otherwise on a board would be worse
 * than saying nothing.
 *
 * Clearing the reported snapshot is what tells the parent. The next reporting
 * pass sees counts that have moved and sends them, so the cancel is confirmed
 * through the ordinary progress path rather than a second protocol that could
 * drift out of step with it.
 */
export async function applyUpgradeCancel(
  db: DB,
  orgId: string,
  directive: UpgradeCancel,
): Promise<UpgradeCancelResult> {
  const dispatchId = typeof directive?.dispatchId === 'string' ? directive.dispatchId : '';
  // Without an id there is no way to know WHICH upgrade to stop, and a blank
  // WHERE would cancel every upgrade this hub has running.
  if (!dispatchId) return { cancelled: 0, error: 'the cancel carried no dispatch id' };

  const row = await db.get<{ directive_id: string | null }>(
    'SELECT directive_id FROM upgrade_dispatch_fanout WHERE dispatch_id = ? AND org_id = ?',
    [dispatchId, orgId],
  );

  if (!row) {
    // A cancel for a dispatch this hub has no record of. That is reachable and
    // not an error: the parent creates its target row when it SERVES the
    // directive, so it can be waiting on a hub whose fan-out was refused,
    // crashed, or never received the response at all.
    //
    // Saying nothing is what must not happen. The parent re-offers a cancel
    // ahead of every other directive until it is answered, so silence here
    // starves this hub's whole feed. Recording it as a settled dispatch gives
    // the reporting pass something true to send: nothing is running for it.
    // OR IGNORE because upgrade_dispatch_fanout is keyed on dispatch_id ALONE
    // while every query scopes by org too. On a hub serving one federated org
    // — which is all any hub does today — the two are equivalent; on a
    // hypothetical multi-org child the row belongs to whichever org recorded
    // it first, and a cancel arriving for another org must not collide with it
    // or, worse, overwrite it.
    await db.run(
      `INSERT OR IGNORE INTO upgrade_dispatch_fanout (dispatch_id, org_id, outcome, upgraded, skipped_json, created_at)
       VALUES (?, ?, 'nothing-to-do', 0, '[]', ?)`,
      [dispatchId, orgId, new Date().toISOString()],
    );
    return { cancelled: 0 };
  }

  // Known, but nothing was written because there was nothing to do. Clearing
  // the snapshot below is still right: the parent may be waiting on an answer
  // that was lost.
  if (!row.directive_id) {
    await db.run(
      'UPDATE upgrade_dispatch_fanout SET reported_json = NULL WHERE dispatch_id = ? AND org_id = ?',
      [dispatchId, orgId],
    );
    return { cancelled: 0 };
  }

  const result = await db.run(
    `UPDATE upgrade_directive_targets SET state = 'cancelled'
      WHERE directive_id = ? AND state = 'pending'`,
    [row.directive_id],
  );
  const cancelled = Number(result.changes ?? 0);

  // Make the next reporting pass speak, even though this hub's own view of the
  // counts may be the only thing that changed.
  await db.run(
    'UPDATE upgrade_dispatch_fanout SET reported_json = NULL WHERE dispatch_id = ? AND org_id = ?',
    [dispatchId, orgId],
  );
  return { cancelled };
}
