import { DB } from '../db.js';
import { effectiveIdentityPolicy } from './federation/forwarding.js';

/**
 * Child-hub developers' names on a federation parent (BUG 4159631f).
 *
 * A parent has no installation for people whose events arrive forwarded, so
 * GET /v1/people/names could not name them. Their names are recorded here, at
 * delivery, from each forwarded event's actor: the newest NAMED event wins, so
 * a later event from a machine without user.name cannot erase it, and an older
 * event delivered late cannot overwrite a newer name.
 */
const UPSERT_CHILD_PERSON_SQL = `
  INSERT INTO child_people (org_id, child_hub_id, user_key, git_name, last_seen)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(org_id, child_hub_id, user_key) DO UPDATE SET
    git_name = excluded.git_name,
    last_seen = excluded.last_seen
  WHERE excluded.last_seen > child_people.last_seen`;

/** Keys that are never a person: control-plane reports and unattributed rows. */
const NOT_A_PERSON = new Set(['system', 'unknown']);
/** A pseudonymFor key: never a person the parent may name. */
const isPseudonym = (key: string) => key.startsWith('anon:');

/** The git name on a forwarded event's actor, if it carries one. */
export function forwardedActorName(event: unknown): string | null {
  const name = (event as { actor?: { gitName?: unknown } } | null)?.actor?.gitName;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/**
 * Record a forwarded person's name. Callers pass only rows whose identity policy
 * is `keep`: a pseudonymizing group's rows carry no name to record, and a row
 * that claims pseudonymize must not be trusted to have stripped one.
 */
export async function recordChildPerson(
  db: DB,
  row: { orgId: string; childHubId: string; userKey: string; name: string | null; occurredAt: string },
): Promise<boolean> {
  if (!row.name || NOT_A_PERSON.has(row.userKey) || isPseudonym(row.userKey)) return false;
  await db.run(UPSERT_CHILD_PERSON_SQL, [row.orgId, row.childHubId, row.userKey, row.name, row.occurredAt]);
  return true;
}

/**
 * Whether the PARENT currently lets this child's people be named: its own
 * effective identity policy, not the label the child put on a row. A child
 * learns of a switch to pseudonymize only on its next heartbeat, and rows it
 * queued before then still say `keep`.
 */
export async function parentAllowsNames(db: DB, orgId: string, childHubId: string): Promise<boolean> {
  const group = await db.get<{ identity_policy: string | null }>(
    'SELECT identity_policy FROM org_settings WHERE org_id = ?', [orgId],
  );
  const child = await db.get<{ identity_policy: string | null }>(
    'SELECT identity_policy FROM child_hubs WHERE id = ? AND org_id = ?', [childHubId, orgId],
  );
  return effectiveIdentityPolicy(group?.identity_policy as any ?? null, child?.identity_policy as any ?? null) === 'keep';
}

export const CHILD_PEOPLE_MIGRATION = 'migration:child_people_names:v1';

/**
 * One-time backfill from events forwarded before names were recorded. Their
 * policy was not stored, but a pseudonymized row has always carried a null
 * actor (redactIdentity), so a row with an actor name came from a keep group.
 * Paged on (occurred_at, event_id) so a large parent never holds its whole
 * history in memory.
 */
export async function migrateChildPeopleNames(db: DB): Promise<{ skipped: boolean; named: number }> {
  const done = await db.get('SELECT value FROM system_state WHERE key = ?', [CHILD_PEOPLE_MIGRATION]);
  if (done) return { skipped: true, named: 0 };
  const PAGE = 2000;
  let named = 0;
  let after: { at: string; id: string } | null = null;
  const allowed = new Map<string, boolean>();
  for (;;) {
    const rows: Array<{ event_id: string; org_id: string; child_hub_id: string; user_key: string; occurred_at: unknown; payload: unknown }> =
      await db.all(
        `SELECT event_id, org_id, child_hub_id, user_key, occurred_at, payload FROM events
         WHERE child_hub_id IS NOT NULL AND child_hub_id <> ''
           ${after ? 'AND (occurred_at > ? OR (occurred_at = ? AND event_id > ?))' : ''}
         ORDER BY occurred_at, event_id
         LIMIT ${PAGE}`,
        after ? [after.at, after.at, after.id] : [],
      );
    for (const r of rows) {
      let event: unknown = r.payload;
      if (typeof event === 'string') {
        try { event = JSON.parse(event); } catch { event = null; }
      }
      const occurredAt = r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at);
      // The same rule as live delivery: never a child the parent now
      // pseudonymizes (recordChildPerson refuses pseudonym keys itself).
      const scope = `${r.org_id}\u0000${r.child_hub_id}`;
      if (!allowed.has(scope)) allowed.set(scope, await parentAllowsNames(db, r.org_id, r.child_hub_id));
      if (!allowed.get(scope)) continue;
      if (await recordChildPerson(db, {
        orgId: r.org_id, childHubId: r.child_hub_id, userKey: r.user_key, name: forwardedActorName(event), occurredAt,
      })) named++;
    }
    if (rows.length < PAGE) break;
    const last = rows[rows.length - 1]!;
    after = { at: last.occurred_at instanceof Date ? last.occurred_at.toISOString() : String(last.occurred_at), id: last.event_id };
  }
  await db.run(
    `INSERT INTO system_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [CHILD_PEOPLE_MIGRATION, JSON.stringify({ named })],
  );
  return { skipped: false, named };
}
