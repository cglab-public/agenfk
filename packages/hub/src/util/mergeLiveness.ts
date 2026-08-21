import { DB } from '../db.js';
import { namespacedOsUserKey } from './userKey.js';

/**
 * Who is still allowed to undo an identity merge (CGLAB-72).
 *
 * A merge rewrites history under a source key. If an installation can still
 * EMIT that key, the next event lands under it and the repair quietly undoes
 * itself — so the merge has to be refused. Both the Identities tab's advisory
 * flag and the merge endpoint's own 409 need that answer, and before this module
 * they each computed their own, differently, and both wrong:
 *
 *  - Suggestions asked "did an installation that EVER produced this key keep a
 *    live api_key?". Once a machine has a git email, `userKeyFor` returns the
 *    email and the old `osuser:` key is unreachable forever — yet the flag stayed
 *    on, disabling a safe merge and advising an admin to retire two working
 *    developers' installations.
 *  - The merge guard compared `os_user` against the BARE username, but keys are
 *    namespaced (`osuser:<user>@<prefix>`) and the migration rewrote the
 *    historical bare ones. It matched nothing, so the one case it was written
 *    for — a machine with no git email — sailed through.
 *
 * The predicate here asks the question both wanted: does this installation
 * derive the source key TODAY, does it hold a live key, and has it actually been
 * seen lately. Dormant machines no longer block; the alias written by the merge
 * (see util/userKeyAlias.ts) is what stops them resurrecting the key later.
 */

export const DEFAULT_LIVE_INSTALL_WINDOW_HOURS = 48;

/**
 * How recently an installation must have been seen to count as live.
 *
 * A bad value falls back to the default rather than to zero: a typo must not
 * silently become permission to merge over a machine that is still ingesting.
 */
export function liveInstallWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENFK_HUB_LIVE_INSTALL_WINDOW_HOURS;
  const hours = raw === undefined ? NaN : Number(raw);
  const valid = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_LIVE_INSTALL_WINDOW_HOURS;
  return valid * 60 * 60 * 1000;
}

export interface InstallationIdentityRow {
  id: string;
  os_user: string | null;
  git_email: string | null;
  /** TEXT in SQLite, TIMESTAMPTZ (a Date) via the Postgres driver. */
  last_seen: string | Date | null;
}

/**
 * The user_key this installation would produce right now.
 *
 * This MUST track `userKeyFor` in util/userKey.ts. When the two drift, the guard
 * stops matching the keys ingest actually writes and silently permits the merges
 * it exists to refuse — which is exactly how the namespacing change broke it.
 */
export function derivedUserKeyForInstallation(row: InstallationIdentityRow): string {
  const email = row.git_email?.trim();
  if (email) return email.toLowerCase();
  return namespacedOsUserKey(row.os_user?.trim() ?? '', row.id);
}

/**
 * Was this installation seen inside the window?
 *
 * Normalises the row shape because Postgres returns a Date for TIMESTAMPTZ while
 * SQLite returns the ISO string, and the test suite only ever runs SQLite. An
 * absent or unparseable timestamp counts as dormant: blocking on garbage would
 * reinstate the false positive this module removes.
 */
export function isWithinWindow(
  lastSeen: string | Date | null | undefined,
  now: Date,
  windowMs: number,
): boolean {
  if (lastSeen === null || lastSeen === undefined) return false;
  const seen = lastSeen instanceof Date ? lastSeen.getTime() : Date.parse(String(lastSeen));
  if (!Number.isFinite(seen)) return false;
  // A clock-skewed future timestamp is still "recently seen", not dormant.
  return now.getTime() - seen <= windowMs;
}

/**
 * Every installation that could still emit a user_key, keyed by that key.
 *
 * One query for the whole org rather than one per candidate: the Identities tab
 * asks about every suggestion at once, and the derivation has to happen in JS
 * anyway — building `osuser:<user>@<prefix>` in SQL would need string
 * concatenation and substring semantics that differ between SQLite and Postgres.
 */
export async function liveIdentityBlockers(
  db: DB,
  orgId: string,
  now: Date = new Date(),
  windowMs: number = liveInstallWindowMs(),
): Promise<Map<string, string[]>> {
  // A plain join, NOT a correlated EXISTS: referencing the outer alias from a
  // subquery is one of the constructs that works in SQLite and fails on
  // Postgres, and only the pg-parity suite would ever catch it. The join can
  // repeat an installation once per key, so dedupe by id below.
  const rows = await db.all<InstallationIdentityRow>(
    `SELECT i.id, i.os_user, i.git_email, i.last_seen
       FROM installations i
       JOIN api_keys k ON k.installation_id = i.id
      WHERE i.org_id = ?
        AND k.org_id = ?
        AND i.retired_at IS NULL
        AND k.revoked_at IS NULL`,
    [orgId, orgId],
  );

  const byKey = new Map<string, string[]>();
  const seenInstalls = new Set<string>();
  for (const row of rows) {
    if (seenInstalls.has(row.id)) continue;
    seenInstalls.add(row.id);
    if (!isWithinWindow(row.last_seen, now, windowMs)) continue;
    const key = derivedUserKeyForInstallation(row);
    const ids = byKey.get(key);
    if (ids) ids.push(row.id);
    else byKey.set(key, [row.id]);
  }
  for (const ids of byKey.values()) ids.sort();
  return byKey;
}

/**
 * The installations that would undo a merge of `from`, or an empty list.
 *
 * Case-insensitive because an email key is stored lowercased while a merge form
 * accepts whatever was typed; osUser-derived keys keep their case, so a Windows
 * `DPolistchuck` still matches its own installation.
 */
export function blockersFor(blockers: Map<string, string[]>, from: string): string[] {
  const direct = blockers.get(from);
  if (direct) return direct;
  const wanted = from.toLowerCase();
  for (const [key, ids] of blockers) {
    if (key.toLowerCase() === wanted) return ids;
  }
  return [];
}
