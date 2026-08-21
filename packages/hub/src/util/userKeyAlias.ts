import { DB } from '../db.js';
import { isEmailShapedKey } from './userKey.js';

/**
 * Identity aliases: a merged-away key cannot come back (CGLAB-72).
 *
 * The liveness guard only blocks a merge while a machine is still active, which
 * leaves a gap it used to cover by accident: an installation dormant past the
 * window can wake weeks later, re-derive the key that was merged away, and start
 * a second identity beside the merged one. Nobody would notice, because the
 * dashboard simply grows a row.
 *
 * So the merge records where the key went, and ingest resolves through it. The
 * rows are stamped with the merge that wrote them, so a revert removes exactly
 * its own — the same provenance discipline as user_key_merge_events.
 */

/** Chains are legitimate (an identity merged once can be merged again), cycles are not. */
const MAX_ALIAS_HOPS = 16;

/**
 * Follow `key` to the identity it now belongs to.
 *
 * Resolving only one hop would land a waking machine on an identity that has
 * itself since been merged away. The hop cap and visited set are defensive: a
 * cycle must degrade to a stable answer rather than hang ingest, which runs this
 * for every event in every batch.
 */
export function resolveAliasKey(key: string, aliases: Map<string, string>): string {
  if (aliases.size === 0) return key;
  let current = key;
  const seen = new Set<string>([current]);
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
    const next = aliases.get(current);
    if (next === undefined || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
  return current;
}

/**
 * The org's alias map, loaded once per ingest batch.
 *
 * Same shape as the hidden-users load in routes/events.ts: one small query per
 * batch keeps the per-event path in memory, and the table only grows by one row
 * per merge.
 */
export async function loadAliasMap(db: DB, orgId: string): Promise<Map<string, string>> {
  const rows = await db.all<{ alias_key: string; canonical_key: string }>(
    'SELECT alias_key, canonical_key FROM user_key_aliases WHERE org_id = ?',
    [orgId],
  );
  return new Map(rows.map(r => [r.alias_key, r.canonical_key]));
}

/**
 * The exact key ingest would have written, for a value a human typed.
 *
 * `from` is deliberately not lowercased wholesale: `userKeyFor` lowercases
 * emails only, so an osUser key keeps its case ('DPolistchuck' on Windows) and
 * force-lowercasing made those keys unaddressable. But leaving the input raw was
 * just as bad in the other direction — an admin who typed `Old@CGLab.com` got a
 * 200 with nothing moved, and an alias row under a key ingest can never derive,
 * so the anti-resurrection protection was silently absent.
 *
 * So: normalise emails the way userKeyFor does, and for anything else adopt the
 * casing of the key that actually exists in this org.
 */
export async function canonicaliseSourceKey(db: DB, orgId: string, typed: string): Promise<string> {
  if (isEmailShapedKey(typed)) return typed.toLowerCase();
  const existing = await db.get<{ user_key: string }>(
    'SELECT user_key FROM events WHERE org_id = ? AND lower(user_key) = lower(?) LIMIT 1',
    [orgId, typed],
  );
  return existing?.user_key ?? typed;
}
