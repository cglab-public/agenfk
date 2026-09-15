import type { DB } from '../db.js';

/**
 * The rules that decide which installations a fleet-wide upgrade touches.
 *
 * These live here, not in the admin route, because there are now TWO callers:
 * an admin posting to /v1/admin/upgrade, and a child hub fanning out a group
 * upgrade its parent dispatched (CGLAB-183). A second copy of "which machines
 * count" would drift from the one an admin exercises, and the drift would only
 * show up as a fleet quietly missing a rollout.
 *
 * What is deliberately NOT here is the POLICY. The two callers do different
 * things with the same facts: an admin naming a machine explicitly gets a 409
 * so they can fix their request, while a child hub skips what it cannot touch
 * and reports the skips, because there is nobody upstream to answer a 409 and
 * one retired laptop must not block a whole hub's rollout.
 */

export interface FleetInstallation {
  id: string;
  agenfk_version: string | null;
}

/**
 * Installations a fleet-wide directive may target: this org's, not retired,
 * and not belonging to a hidden person.
 *
 * Both exclusions are deliberate and predate this service. A retired
 * installation had its keys revoked, so it can never poll or report —
 * targeting one hangs the upgrade board on a machine that is never coming
 * back (CGLAB-64). A hidden person's machine must not receive pushes at all
 * (CGLAB-31).
 */
export function eligibleInstallations(db: DB, orgId: string): Promise<FleetInstallation[]> {
  // Written as NOT IN over an org-scoped subquery rather than a CORRELATED
  // NOT EXISTS. The correlated form — `h.org_id = i.org_id AND h.user_key =
  // lower(i.git_email)` — cannot be executed by the pg-mem backend the parity
  // suite runs on, so for as long as it was spelled that way this query had no
  // Postgres coverage at all and the SQLite suites could not see it. The
  // correlation on org_id was redundant in any case: the outer WHERE already
  // pins the org.
  //
  // COALESCE is load-bearing, not decoration. `NULL NOT IN (...)` is NULL, not
  // true, so an installation with no git_email — which the column allows —
  // would be silently EXCLUDED from every fleet-wide upgrade, the opposite of
  // what the NOT EXISTS form did.
  return db.all<FleetInstallation>(
    `SELECT id, agenfk_version FROM installations
      WHERE org_id = ?
        AND retired_at IS NULL
        AND COALESCE(lower(git_email), '') NOT IN (
          SELECT user_key FROM hidden_users WHERE org_id = ?
        )`,
    [orgId, orgId],
  );
}

/**
 * Which of these installations already have an upgrade running.
 *
 * Stacking a second directive on a machine mid-upgrade is how an agent ends up
 * being told two different things at once, so both callers check — they just
 * disagree about what to do about it.
 */
export async function inFlightInstallationIds(
  db: DB,
  orgId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.all<{ installation_id: string }>(
    `SELECT t.installation_id
       FROM upgrade_directive_targets t
       JOIN upgrade_directives d ON d.id = t.directive_id
      WHERE d.org_id = ?
        AND t.installation_id IN (${placeholders})
        AND t.state IN ('pending', 'in_progress')`,
    [orgId, ...ids],
  );
  return new Set(rows.map(r => r.installation_id));
}
