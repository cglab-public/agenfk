import { DB } from '../db.js';
import { userKeyFor } from './userKey.js';

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

/** Below this a machine mid-batch would read as dormant; above it, nothing ever merges. */
export const MIN_LIVE_INSTALL_WINDOW_HOURS = 0.25;
export const MAX_LIVE_INSTALL_WINDOW_HOURS = 24 * 365;

/**
 * How recently an installation must have been seen to count as live.
 *
 * A bad value falls back to the default rather than to zero: a typo must not
 * silently become permission to merge over a machine that is still ingesting.
 * Valid-but-absurd values are clamped for the same reason — `0.0001` parses
 * fine and yields a sub-second window, which is the typo dressed as a number.
 */
export function liveInstallWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENFK_HUB_LIVE_INSTALL_WINDOW_HOURS;
  const hours = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_LIVE_INSTALL_WINDOW_HOURS * 60 * 60 * 1000;
  const clamped = Math.min(Math.max(hours, MIN_LIVE_INSTALL_WINDOW_HOURS), MAX_LIVE_INSTALL_WINDOW_HOURS);
  return clamped * 60 * 60 * 1000;
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
 * Delegates to `userKeyFor` rather than reimplementing it. A second copy of the
 * derivation is what broke the guard in the first place: namespacing changed one
 * and not the other, so the guard compared a bare username against keys ingest
 * no longer writes and matched nothing. Routing both through one function makes
 * that drift impossible instead of merely discouraged.
 */
export function derivedUserKeyForInstallation(row: InstallationIdentityRow): string {
  return userKeyFor(
    { osUser: row.os_user ?? '', gitName: null, gitEmail: row.git_email },
    row.id,
  );
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
