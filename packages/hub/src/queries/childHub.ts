// Which hub in a federation group a row came from (CGLAB-184).
//
// A parent hub keeps its own events and every child's in one `events` table,
// told apart only by `child_hub_id`. This module owns the two things that must
// agree across the query routes and the PR aggregator: the reserved id standing
// for "this hub", and the SQL that recognises those rows.

/**
 * The reserved id meaning "this hub's own events" — rows a parent ingested
 * directly rather than receiving from a child. Child hub ids are UUIDs
 * (randomUUID at enrollment), so a bare word cannot collide with one.
 *
 * Shared rather than spelled twice: it is both the value a caller sends as
 * ?childHubId and the value the PR aggregator reports back in `prs[].childHubId`,
 * and a picker built on one and filtering with the other would break silently.
 */
export const LOCAL_HUB = 'local';

/**
 * Rows this hub produced itself.
 *
 * The two tables encode that differently — `events.child_hub_id` is NULLable and
 * left NULL by the ingest path, while `rollups_daily.child_hub_id` is NOT NULL
 * DEFAULT '' because it is part of that table's PRIMARY KEY. Matching both
 * spellings means a caller need not know which table it is building a WHERE for,
 * and a later backfill normalising one to the other cannot change what this hits.
 */
export const OWN_ROWS_SQL = `(child_hub_id IS NULL OR child_hub_id = '')`;

/** SQL for a child-hub selection, or null when there is nothing to constrain. */
export function childHubPredicate(hubs: string[] | null): { sql: string; params: string[] } | null {
  if (!hubs || !hubs.length) return null;
  const ids = hubs.filter(h => h !== LOCAL_HUB);
  const parts: string[] = [];
  if (ids.length) parts.push(`child_hub_id IN (${ids.map(() => '?').join(',')})`);
  if (hubs.includes(LOCAL_HUB)) parts.push(OWN_ROWS_SQL);
  // An id list matching no hub yields `child_hub_id IN ('nope')`, which matches
  // nothing — deliberately, so a stale link to a hub that has since been removed
  // shows an empty result rather than quietly widening to the whole group.
  return { sql: `(${parts.join(' OR ')})`, params: ids };
}

/**
 * The same predicate as a trailing `AND ...` fragment, for the facet queries
 * that build their own WHERE instead of going through applyEventFilters.
 */
export function childHubClause(hubs: string[] | null): { and: string; params: string[] } {
  const hub = childHubPredicate(hubs);
  return hub ? { and: ` AND ${hub.sql}`, params: hub.params } : { and: '', params: [] };
}
