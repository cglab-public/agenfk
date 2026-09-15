
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

export type SkipReason = 'retired' | 'hidden' | 'in-flight' | 'downgrade';

export interface UpgradeSkip {
  installationId: string;
  reason: SkipReason;
}

export interface UpgradeFanoutResult {
  /** Installations this directive will actually move. */
  upgraded: number;
  /** One entry per installation left alone, with why. Reported upstream. */
  skipped: UpgradeSkip[];
  /**
   * Nothing left to do. True when there was nothing to upgrade at all — a hub
   * whose whole fleet is retired has done its job, and reporting that as a
   * failure would light up the parent's board red for a hub behaving
   * perfectly.
   */
  completed: boolean;
  /** Set only when the directive itself was unusable. */
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
 * The id of the local directive a given dispatch produces.
 *
 * Derived from the dispatch id rather than random, so a redelivered directive
 * — which happens as a matter of course, delivery being at-least-once — is a
 * no-op instead of a second upgrade of the same fleet.
 */
const localDirectiveId = (dispatchId: string) => `updisp-${dispatchId}`;

export async function applyUpgradeDispatch(
  db: DB,
  orgId: string,
  directive: UpgradeDispatch,
): Promise<UpgradeFanoutResult> {
  const targetVersion = typeof directive?.targetVersion === 'string' ? directive.targetVersion : '';
  const dispatchId = typeof directive?.dispatchId === 'string' ? directive.dispatchId : '';
  if (!targetVersion) {
    return { upgraded: 0, skipped: [], completed: false, error: 'the directive carried no target version' };
  }
  if (!dispatchId) {
    return { upgraded: 0, skipped: [], completed: false, error: 'the directive carried no dispatch id' };
  }

  const directiveId = localDirectiveId(dispatchId);
  const already = await db.get<{ id: string }>(
    'SELECT id FROM upgrade_directives WHERE id = ?', [directiveId],
  );
  if (already) {
    // Already carried out. Reporting 0 upgraded and completed is the truth:
    // this delivery changed nothing, and the original report stands.
    return { upgraded: 0, skipped: [], completed: true, directiveId };
  }

  // Everything this org has, so the ones left out can be NAMED. The shared
  // eligibility query says who is in; the difference is who is out, and why.
  const all = await db.all<{ id: string; agenfk_version: string | null; retired_at: string | null }>(
    'SELECT id, agenfk_version, retired_at FROM installations WHERE org_id = ? ORDER BY id',
    [orgId],
  );
  const eligible = await eligibleInstallations(db, orgId);
  const eligibleById = new Map(eligible.map(i => [i.id, i]));
  const inFlight = await inFlightInstallationIds(db, orgId, eligible.map(i => i.id));

  const skipped: UpgradeSkip[] = [];
  const targets: string[] = [];
  for (const inst of all) {
    // One reason per installation, first match wins — a retired machine
    // belonging to a hidden person is one skip, not two, or the counts the
    // parent renders would not add up to the fleet.
    if (inst.retired_at) { skipped.push({ installationId: inst.id, reason: 'retired' }); continue; }
    if (!eligibleById.has(inst.id)) { skipped.push({ installationId: inst.id, reason: 'hidden' }); continue; }
    if (inFlight.has(inst.id)) { skipped.push({ installationId: inst.id, reason: 'in-flight' }); continue; }
    // A machine with no known version is upgradable: absent is not "newer",
    // and refusing it would strand exactly the installations that have never
    // reported in.
    if (!directive.confirmDowngrade
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
    return { upgraded: 0, skipped, completed: true };
  }

  await db.transaction(async () => {
    await db.run(
      `INSERT INTO upgrade_directives (id, org_id, target_version, scope_type, created_by_email)
       VALUES (?, ?, ?, 'all', ?)`,
      [directiveId, orgId, targetVersion, `parent-hub:${dispatchId}`],
    );
    for (const id of targets) {
      await db.run(
        `INSERT INTO upgrade_directive_targets (directive_id, installation_id, state)
         VALUES (?, ?, 'pending')`,
        [directiveId, id],
      );
    }
  });

  return { upgraded: targets.length, skipped, completed: false, directiveId };
}

