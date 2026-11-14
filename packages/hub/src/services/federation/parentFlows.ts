import { recordAudit } from '../configAudit.js';
import type { DB } from '../../db.js';

/**
 * Hand the parent's flows back to the hub that is holding them (CGLAB-182).
 *
 * Detaching costs a team nothing: the flows STAY and become ordinary local
 * flows, so nothing anybody is mid-project under disappears, and the hub
 * regains control of its own board. That was the user's decision, and it is
 * why this is an UPDATE and not a DELETE.
 *
 * Called from BOTH ways out of a group — the parent-side detach, which this
 * hub discovers as a 401 and records by revoking the binding, and the
 * child-side leave once it has been released. A hub whose parent detached it
 * but whose admin has not yet clicked Leave would otherwise sit holding flows
 * that nobody anywhere can edit: the parent is gone and the guard is still on.
 *
 * NOT scoped to an org. The parent binding lives in system_state and belongs
 * to the whole hub, not to one tenant of it, so the flows it dispatched are
 * released hub-wide. Scoping this to the acting admin's org would leave
 * another org's flows locked to a parent that no longer exists.
 *
 * That rests on an invariant worth naming, because it is real but unenforced:
 * a source='parent' row can only ever exist in config.defaultOrgId, since both
 * enrolment and installDispatchedFlow are wired to it and no production path
 * creates a second org. The schema is nonetheless multi-org. If a second org
 * ever becomes creatable AND can hold its own parent binding, this statement
 * starts releasing flows for an org that left nothing, and it must gain a
 * scope at that point.
 *
 * Idempotent: a hub with nothing from a parent is left alone, which is what
 * makes it safe to call on every exit path without checking first.
 */
export async function releaseParentFlows(db: DB): Promise<number> {
  const held = await db.all<{ id: string; name: string; org_id: string }>("SELECT id, name, org_id FROM flows WHERE source = 'parent'", []);
  const result = await db.run("UPDATE flows SET source = 'hub' WHERE source = 'parent'");
  // STORY a89af514: the parent's lock coming off is a config change of its own.
  for (const orgId of new Set(held.map(f => f.org_id))) {
    const flows = held.filter(f => f.org_id === orgId).map(f => ({ id: f.id, name: f.name }));
    await recordAudit(db, { orgId, actor: null, source: 'federation', ip: null, area: 'federation', action: 'flows.release', target: `${flows.length} flow(s) from the parent hub`, before: { source: 'parent', flows }, after: { source: 'hub', flows } });
  }
  return result.changes ?? 0;
}
