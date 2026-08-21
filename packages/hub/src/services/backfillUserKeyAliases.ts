import { DB } from '../db.js';
import { isEmailShapedKey, isNamespacedOsUserKey, namespacedOsUserKey } from '../util/userKey.js';

/**
 * Give merges made before user_key_aliases existed the same protection (CGLAB-76).
 *
 * The alias table arrived with the liveness window: because a dormant machine no
 * longer BLOCKS a merge, an alias is what stops it waking later and resurrecting
 * the key that was merged away. Aliases are only written at merge time, so every
 * merge performed before that release has no alias and no such protection.
 *
 * Reconstructed from the merge journal, and reversible because each row keeps its
 * originating merge_id, so reverting that merge removes exactly this alias.
 *
 * The naive `INSERT ... SELECT ... ON CONFLICT DO NOTHING` is wrong four ways,
 * and every one of them writes a silently useless row rather than failing:
 *
 *  - **Duplicate sources.** Refusing to re-merge an already-merged key is newer
 *    than the merge endpoint, so two un-reverted merges CAN share a source. DO
 *    NOTHING keeps whichever row the query emitted first, which may be the
 *    superseded target.
 *  - **The alias key must be what INGEST derives**, not what an admin typed.
 *    Emails were stored verbatim, and older merges predate the osUser namespacing
 *    migration — which rewrote `events.user_key` but never touched this journal.
 *    A row saying `gcs` would alias a key ingest now spells
 *    `osuser:gcs@<installation-prefix>`, so the alias could never match.
 *  - **The canonical target must NOT be normalised.** The historical merge moved
 *    events to the raw `to_user_key`; rewriting it here would point the alias at
 *    a third identity that holds no events at all.
 *  - **A revert can land mid-run**, and re-adding an alias an admin just removed
 *    silently undoes their revert.
 */

export const ALIAS_BACKFILL_MIGRATION = 'migration:backfill_user_key_aliases:v1';

/** org_id and a user_key can both contain most things; a unit separator cannot. */
const KEY_SEP = '␟';

export interface AliasBackfillResult {
  skipped: boolean;
  aliasesWritten: number;
  /** Sources with more than one un-reverted merge, where only the latest was used. */
  supersededSources: number;
  /** Alias keys rewritten to the form ingest derives. */
  canonicalised: number;
  /** Merges whose source key could not be resolved to a derivable key, so no alias was written. */
  unresolvable: number;
}

interface MergeRow {
  id: string;
  org_id: string;
  from_user_key: string;
  to_user_key: string;
  created_at: string | Date;
}

const asTime = (v: string | Date): number =>
  v instanceof Date ? v.getTime() : Date.parse(String(v));

/**
 * Every key ingest would derive for this merge's source. Empty when none can be
 * reconstructed.
 *
 * A bare username is the hard case twice over. It is not what ingest produces any
 * more, and the events that would say which machine it came from have already
 * been moved onto the target — the merge journal still points at them, so the
 * installation is recoverable from there, and when it is not (merges older than
 * the journal itself) we write nothing rather than a dead alias.
 *
 * And it was a BUCKET: 'dev', 'ubuntu' and 'runner' were several people at once,
 * which is the whole reason namespacing exists. So one bare key can legitimately
 * become several namespaced ones, all pointing at the same merged identity.
 */
async function deriveAliasKeys(db: DB, m: MergeRow): Promise<string[]> {
  if (isEmailShapedKey(m.from_user_key)) return [m.from_user_key.toLowerCase()];
  if (isNamespacedOsUserKey(m.from_user_key)) return [m.from_user_key];

  // EVERY machine, not one of them. A bare username was a bucket by
  // construction — 'dev', 'ubuntu' and 'runner' were several people at once,
  // which is why namespacing happened at all. Taking a single row would leave
  // the other machines' keys unprotected and pick the winner at random.
  const rows = await db.all<{ installation_id: string }>(
    `SELECT DISTINCT e.installation_id
       FROM user_key_merge_events j
       JOIN events e ON e.event_id = j.event_id
      WHERE j.merge_id = ? AND e.org_id = ?
      ORDER BY e.installation_id`,
    [m.id, m.org_id],
  );
  return rows
    .map(r => r.installation_id)
    .filter(Boolean)
    .map(id => namespacedOsUserKey(m.from_user_key, id));
}

export async function backfillUserKeyAliases(
  db: DB,
  opts: { force?: boolean } = {},
): Promise<AliasBackfillResult> {
  const empty: AliasBackfillResult = {
    skipped: false, aliasesWritten: 0, supersededSources: 0, canonicalised: 0, unresolvable: 0,
  };

  if (!opts.force) {
    const done = await db.get('SELECT value FROM system_state WHERE key = ?', [ALIAS_BACKFILL_MIGRATION]);
    if (done) return { ...empty, skipped: true };
  }

  const merges = await db.all<MergeRow>(
    `SELECT id, org_id, from_user_key, to_user_key, created_at
       FROM user_key_merges
      WHERE reverted_at IS NULL`,
  );

  // Latest un-reverted merge wins per (org, derived source). Resolved in JS
  // because the tie-break needs the same derivation ingest uses, and because
  // created_at is TEXT in SQLite and a Date in Postgres.
  const winners = new Map<string, { merge: MergeRow; alias: string }>();
  const sourcesSeen = new Set<string>();
  let supersededSources = 0;
  let canonicalised = 0;
  let unresolvable = 0;

  for (const m of merges) {
    const derived = await deriveAliasKeys(db, m);
    if (derived.length === 0) { unresolvable++; continue; }

    for (const alias of derived) {
      if (alias !== m.from_user_key) canonicalised++;

      const key = `${m.org_id}${KEY_SEP}${alias}`;
      const existing = winners.get(key);
      if (!existing) { winners.set(key, { merge: m, alias }); continue; }

      // Count SOURCES with a conflict, not the extra rows: three merges of one
      // source is still one superseded source, and the boot log says "source(s)".
      if (!sourcesSeen.has(key)) { supersededSources++; sourcesSeen.add(key); }

      // Strict > would let an exact tie fall back to row order, and SQLite's
      // datetime('now') has one-second resolution, so back-to-back merges tie.
      // An unparseable timestamp must not hand the decision to row order either;
      // treat it as oldest and let the id break it deterministically.
      const mine = asTime(m.created_at);
      const theirs = asTime(existing.merge.created_at);
      const newer = (Number.isFinite(mine) ? mine : 0) - (Number.isFinite(theirs) ? theirs : 0);
      if (newer > 0 || (newer === 0 && m.id > existing.merge.id)) {
        winners.set(key, { merge: m, alias });
      }
    }
  }

  let aliasesWritten = 0;
  for (const { merge: m, alias } of winners.values()) {
    // The target is written RAW: that is where the merge actually moved the rows.
    if (alias === m.to_user_key) continue; // a self-alias would resolve to itself
    // The not-reverted check is part of the INSERT, not a read before it. This
    // runs unawaited while /v1/admin is already serving, so a separate SELECT is
    // a TOCTOU: a revert committing in the gap would be silently undone, and
    // because system_state gets stamped regardless it would never self-correct.
    // DO NOTHING, not DO UPDATE: an alias written by a live merge is newer and
    // more authoritative than anything reconstructed from history.
    const r = await db.run(
      `INSERT INTO user_key_aliases (org_id, alias_key, canonical_key, merge_id)
       SELECT ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM user_key_merges WHERE id = ? AND reverted_at IS NULL)
       ON CONFLICT(org_id, alias_key) DO NOTHING`,
      [m.org_id, alias, m.to_user_key, m.id, m.id],
    );
    aliasesWritten += r.changes;
  }

  const result: AliasBackfillResult = {
    skipped: false, aliasesWritten, supersededSources, canonicalised, unresolvable,
  };
  await db.run(
    `INSERT INTO system_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [ALIAS_BACKFILL_MIGRATION, JSON.stringify(result)],
  );
  return result;
}
