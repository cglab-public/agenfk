import type { DB } from '../../db.js';
import { compareSemver } from '../../util/semver.js';
import { eligibleInstallations, inFlightInstallationIds } from '../fleetUpgrade.js';

/**
 * A child hub carrying out the group upgrade its parent dispatched
 * (CGLAB-183, task 2).
 *
 * The parent named a VERSION. Which machines that means is the child's
 * question, because only the child knows its own fleet — so this creates an
 * ordinary local upgrade directive, the same kind an admin of this hub would
 * create, over the installations it can actually reach.
 *
 * An installation it cannot reach is SKIPPED WITH A REASON, never a cause to
 * fail the whole directive (confirmed with the user). A partial rollout is
 * still progress, and one retired laptop must not block a hub. There is also
 * nobody upstream to answer a 409, which is what the admin route returns for
 * the same facts.
 *
 * Out of scope, deliberately: upgrading the child hub's own Docker image.
 */

export type SkipReason = 'retired' | 'hidden' | 'in-flight' | 'downgrade' | 'ineligible';

export interface UpgradeSkip {
  installationId: string;
  reason: SkipReason;
}

/**
 * What happened, as one word.
 *
 * This replaces a boolean that meant three different things at once: a clean
 * rollout and a malformed directive both reported the same value in the only
 * success-shaped field the upstream report has, and "did nothing because there
 * was nothing to do" was indistinguishable from "did nothing because it was
 * already done".
 */
export type UpgradeOutcome =
  /** A local directive was created and machines are now upgrading. */
  | 'applied'
  /** Nothing to upgrade — every machine was skipped, or there are none. */
  | 'nothing-to-do'
  /** This dispatch was already carried out; the recorded result is returned. */
  | 'already-applied'
  /** The directive itself was unusable; nothing was written. */
  | 'invalid';

export interface UpgradeFanoutResult {
  outcome: UpgradeOutcome;
  /** Installations this directive moved. */
  upgraded: number;
  /** One entry per installation left alone, with why. Reported upstream. */
  skipped: UpgradeSkip[];
  /** Set only when the outcome is 'invalid'. */
  error?: string;
  /** The local directive created, when one was. */
  directiveId?: string;
}

export interface UpgradeDispatch {
  kind?: string;
  dispatchId?: string;
  targetVersion?: string;
  confirmDowngrade?: boolean;
}

/**
 * The same strict tag allowlist the admin route applies to an admin's own
 * input, applied again here.
 *
 * The parent is a DIFFERENT HUB — a trust boundary — and this value travels
 * from here to every machine in this fleet, where it is interpolated into a
 * shell command. One regex at the far end is not somewhere to keep the only
 * check: a parent that is buggy, newer, or hostile would otherwise fill this
 * hub's upgrade board with targets that can never complete while the parent is
 * told the rollout succeeded.
 */
const SEMVER_TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** A remote-chosen id becomes a primary key, so it is bounded. */
const MAX_DISPATCH_ID = 200;

/**
 * The id of the local directive a given dispatch produces.
 *
 * Derived from the dispatch id rather than random, so a redelivered directive
 * — which happens as a matter of course, delivery being at-least-once — is a
 * no-op instead of a second upgrade of the same fleet. A parent that wants to
 * change its mind issues a NEW dispatch id; replaying an old id with a
 * different version is deliberately ignored.
 */
const localDirectiveId = (dispatchId: string) => `updisp-${dispatchId}`;

const invalid = (error: string): UpgradeFanoutResult =>
  ({ outcome: 'invalid', upgraded: 0, skipped: [], error });

export async function applyUpgradeDispatch(
  db: DB,
  orgId: string,
  directive: UpgradeDispatch,
): Promise<UpgradeFanoutResult> {
  const targetVersion = typeof directive?.targetVersion === 'string' ? directive.targetVersion : '';
  const dispatchId = typeof directive?.dispatchId === 'string' ? directive.dispatchId : '';
  if (!dispatchId) return invalid('the directive carried no dispatch id');
  if (dispatchId.length > MAX_DISPATCH_ID) return invalid('the directive\'s dispatch id is implausibly long');
  if (!SEMVER_TAG_RE.test(targetVersion)) {
    return invalid(`the directive's target version is not a release tag: ${JSON.stringify(targetVersion).slice(0, 80)}`);
  }
  // Strictly a boolean. Read as bare truthiness, the STRING "false" — which is
  // exactly what a careless serialiser produces — would disable the guard and
  // roll the whole fleet backwards.
  const confirmDowngrade = directive.confirmDowngrade === true;

  const recorded = await readFanout(db, orgId, dispatchId);
  if (recorded) return recorded;

  const directiveId = localDirectiveId(dispatchId);

  // Everything this org has, so the ones left out can be NAMED.
  const all = await db.all<{
    id: string; agenfk_version: string | null; retired_at: string | null; git_email: string | null;
  }>(
    'SELECT id, agenfk_version, retired_at, git_email FROM installations WHERE org_id = ? ORDER BY id',
    [orgId],
  );
  const hiddenRows = await db.all<{ user_key: string }>(
    'SELECT user_key FROM hidden_users WHERE org_id = ?', [orgId],
  );
  // Read explicitly rather than inferred from non-eligibility. The shared
  // query stays the authority on who is IN; deriving the REASON by subtracting
  // it would silently relabel any future exclusion as "hidden", and the reason
  // is the part a human reads off the parent's board.
  const hidden = new Set(hiddenRows.map(r => r.user_key));

  let result!: UpgradeFanoutResult;
  await db.transaction(async () => {
    // Inside the transaction: reading the in-flight set outside it left a gap
    // in which a local admin posting scope=all — or any other writer — could
    // claim a machine between the check and the insert, stacking two
    // directives on it, which is the single thing the in-flight skip exists to
    // prevent. Now that one side is a background timer rather than a second
    // human, that gap is routine rather than theoretical.
    const eligible = await eligibleInstallations(db, orgId);
    const eligibleIds = new Set(eligible.map(i => i.id));
    const inFlight = await inFlightInstallationIds(db, orgId, eligible.map(i => i.id));

    const skipped: UpgradeSkip[] = [];
    const targets: string[] = [];
    for (const inst of all) {
      // One reason per installation, first match wins — a retired machine
      // belonging to a hidden person is one skip, not two, or the counts the
      // parent renders would not add up to the fleet.
      if (inst.retired_at) { skipped.push({ installationId: inst.id, reason: 'retired' }); continue; }
      if (hidden.has((inst.git_email ?? '').toLowerCase())) {
        skipped.push({ installationId: inst.id, reason: 'hidden' }); continue;
      }
      // Excluded by the shared rules for a reason this code does not know
      // about yet. Naming it honestly beats guessing, and the counts still add
      // up to the fleet either way.
      if (!eligibleIds.has(inst.id)) { skipped.push({ installationId: inst.id, reason: 'ineligible' }); continue; }
      if (inFlight.has(inst.id)) { skipped.push({ installationId: inst.id, reason: 'in-flight' }); continue; }
      // A machine with no known version is upgradable: absent is not "newer",
      // and refusing it would strand exactly the installations that have never
      // reported in.
      if (!confirmDowngrade
          && inst.agenfk_version
          && compareSemver(targetVersion, inst.agenfk_version) < 0) {
        skipped.push({ installationId: inst.id, reason: 'downgrade' });
        continue;
      }
      targets.push(inst.id);
    }

    if (targets.length === 0) {
      // Nothing to do, and it has been done. No directive is written: an empty
      // one would sit on the local upgrades page forever with no targets.
      result = { outcome: 'nothing-to-do', upgraded: 0, skipped };
    } else {
      await db.run(
        `INSERT INTO upgrade_directives (id, org_id, target_version, scope_type, created_by_email)
         VALUES (?, ?, ?, 'all', ?)`,
        [directiveId, orgId, targetVersion, `parent-hub:${dispatchId}`],
      );
      let landed = 0;
      for (const id of targets) {
        // The in-flight test is made part of the INSERT rather than left in
        // the read above. Reading and then writing leaves a window in which
        // another writer — a local admin posting scope=all, now racing a
        // background timer rather than a second human — claims the machine in
        // between, and it ends up told two different things at once. Checking
        // inside the statement closes that window for anything already
        // committed. It does NOT make this serialisable: two uncommitted
        // transactions can still both pass under READ COMMITTED, which would
        // need SERIALIZABLE or a partial unique index neither backend shares.
        const inserted = await db.run(
          `INSERT INTO upgrade_directive_targets (directive_id, installation_id, state)
           SELECT ?, ?, 'pending'
            WHERE NOT EXISTS (
              SELECT 1 FROM upgrade_directive_targets t
                JOIN upgrade_directives d ON d.id = t.directive_id
               WHERE d.org_id = ? AND t.installation_id = ?
                 AND t.state IN ('pending', 'in_progress')
            )`,
          [directiveId, id, orgId, id],
        );
        if (Number(inserted.changes ?? 0) > 0) landed++;
        else skipped.push({ installationId: id, reason: 'in-flight' });
      }
      if (landed === 0) {
        // Everything we meant to move was claimed while we were moving. The
        // directive would sit on the local upgrades page forever with no
        // targets, so it goes back out.
        await db.run('DELETE FROM upgrade_directives WHERE id = ?', [directiveId]);
        result = { outcome: 'nothing-to-do', upgraded: 0, skipped };
      } else {
        result = { outcome: 'applied', upgraded: landed, skipped, directiveId };
      }
    }

    await db.run(
      `INSERT INTO upgrade_dispatch_fanout (dispatch_id, org_id, outcome, upgraded, skipped_json, directive_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [dispatchId, orgId, result.outcome, result.upgraded,
       JSON.stringify(result.skipped), result.directiveId ?? null, new Date().toISOString()],
    );
  });

  return result;
}

/**
 * What a previous tick recorded for this dispatch, if any.
 *
 * Returned verbatim rather than recomputed. The parent re-serves a dispatch
 * until the child reports it, so the tick that reports is almost never the one
 * that acted — and by then the machines this upgraded are in flight and would
 * re-derive as `skipped`, handing the parent a fleet with no skips in it.
 */
async function readFanout(db: DB, orgId: string, dispatchId: string): Promise<UpgradeFanoutResult | null> {
  const row = await db.get<{
    outcome: string; upgraded: number | string; skipped_json: string; directive_id: string | null;
  }>(
    'SELECT outcome, upgraded, skipped_json, directive_id FROM upgrade_dispatch_fanout WHERE dispatch_id = ? AND org_id = ?',
    [dispatchId, orgId],
  );
  if (!row) return null;
  let skipped: UpgradeSkip[] = [];
  try {
    const parsed = JSON.parse(row.skipped_json);
    if (Array.isArray(parsed)) skipped = parsed;
  } catch {
    // A record we cannot read is still a record that this dispatch was done.
    // Reporting it with no skips is wrong but bounded; re-running the fan-out
    // would be worse.
  }
  return {
    outcome: 'already-applied',
    upgraded: Number(row.upgraded ?? 0),
    skipped,
    directiveId: row.directive_id ?? undefined,
  };
}
