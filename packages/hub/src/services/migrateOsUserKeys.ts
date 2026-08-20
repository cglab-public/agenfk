import { DB } from '../db.js';
import { namespacedOsUserKey, isNamespacedOsUserKey } from '../util/userKey.js';
import { recomputeRollups } from '../rollup.js';

/**
 * One-time rewrite of historical bare-osUser identity keys (task cacb1aed).
 *
 * Ingest now derives `osuser:<user>@<installation-prefix>` when a machine has no
 * git email, because a bare OS username is not an identity — every developer who
 * is `dev`, `ubuntu` or `runner` on their own machine shared one key. Existing
 * events still carry the bare form, so without this the SAME machine would show
 * up as two identities, which is the very split the change removes.
 *
 * A bare key produced by two installations correctly becomes TWO keys. That is
 * the point: it was never one person, and the numbers on the dashboard change as
 * a result — which is why this reports what it did instead of running silently.
 */

export const OS_USER_KEY_MIGRATION = 'migration:namespace_osuser_keys:v1';

export interface OsUserKeyMigrationResult {
  skipped: boolean;
  keysRewritten: number;
  eventsRewritten: number;
  /** Bare keys that belonged to more than one installation and therefore split. */
  identitiesSplit: number;
  daysRecomputed: number;
}

export async function migrateOsUserKeys(
  db: DB,
  opts: { force?: boolean } = {},
): Promise<OsUserKeyMigrationResult> {
  const empty: OsUserKeyMigrationResult = {
    skipped: false, keysRewritten: 0, eventsRewritten: 0, identitiesSplit: 0, daysRecomputed: 0,
  };

  if (!opts.force) {
    const done = await db.get('SELECT value FROM system_state WHERE key = ?', [OS_USER_KEY_MIGRATION]);
    if (done) return { ...empty, skipped: true };
  }

  // Keys with no '@' are bare usernames: this excludes real addresses AND our
  // own namespaced output, so the migration cannot chew its own tail.
  const pairs = await db.all<{ installation_id: string; user_key: string; n: number }>(
    `SELECT installation_id, user_key, COUNT(*) AS n
       FROM events
      WHERE user_key NOT LIKE '%@%'
      GROUP BY installation_id, user_key`,
  );

  const perKeyInstallations = new Map<string, number>();
  for (const p of pairs) {
    perKeyInstallations.set(p.user_key, (perKeyInstallations.get(p.user_key) ?? 0) + 1);
  }

  let eventsRewritten = 0;
  const oldKeys = new Set<string>();
  for (const p of pairs) {
    const next = namespacedOsUserKey(p.user_key, p.installation_id);
    if (isNamespacedOsUserKey(p.user_key)) continue; // belt and braces
    const r = await db.run(
      'UPDATE events SET user_key = ? WHERE installation_id = ? AND user_key = ?',
      [next, p.installation_id, p.user_key],
    );
    eventsRewritten += r.changes;
    oldKeys.add(p.user_key);
  }

  let daysRecomputed = 0;
  if (oldKeys.size > 0) {
    // The recompute only rebuilds groups that still have events, so the retired
    // keys' rows would otherwise sit on the dashboard forever.
    for (const key of oldKeys) {
      await db.run('DELETE FROM rollups_daily WHERE user_key = ?', [key]);
    }
    // Full history: a rewrite touches every day the old key ever appeared, and
    // the periodic recompute is forward-only by design.
    daysRecomputed = (await recomputeRollups(db, { full: true })).days;
  }

  const identitiesSplit = [...perKeyInstallations.values()].filter(n => n > 1).length;
  const result: OsUserKeyMigrationResult = {
    skipped: false,
    keysRewritten: oldKeys.size,
    eventsRewritten,
    identitiesSplit,
    daysRecomputed,
  };
  await db.run(
    `INSERT INTO system_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [OS_USER_KEY_MIGRATION, JSON.stringify(result)],
  );
  return result;
}
