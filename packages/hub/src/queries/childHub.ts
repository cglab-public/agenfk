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
 * The originating-hub column, per table.
 *
 * `events.child_hub_id` is NULLable and left NULL by the ingest path, so reads
 * there normalise with COALESCE and `idx_events_org_childnorm_time` indexes that
 * same expression. `rollups_daily.child_hub_id` is NOT NULL DEFAULT '' because
 * it is part of that table's PRIMARY KEY, so the plain column is already total
 * there — and wrapping it would be a semantic no-op that blinds both its index
 * and its primary key, turning a seek into an org-wide scan. That is not
 * hypothetical: it shipped that way for one commit. See
 * child-hub-index-usage.test.ts, which pins the plan for both tables.
 */
export const HUB_COL_EVENTS = `COALESCE(child_hub_id, '')`;
export const HUB_COL_ROLLUPS = `child_hub_id`;

/** Lower-cased for comparison. Hub ids are `randomUUID()` — lowercase hex — so
 *  normalising costs nothing and stops a case-normalised or hand-edited link
 *  (`?childHubId=LOCAL`, or an upper-cased UUID) from matching nothing and
 *  showing an empty board instead of the data asked for. */
const norm = (h: string) => h.toLowerCase();

/**
 * SQL for a child-hub selection, or null when there is nothing to constrain.
 *
 * `col` is REQUIRED, and deliberately has no default. The regression this guards
 * against was a rollups query silently getting the events spelling by omission —
 * a wrong plan, never a wrong answer, so nothing failed and nothing complained.
 * A required parameter turns the next occurrence into a compile error instead.
 * Pass HUB_COL_EVENTS or HUB_COL_ROLLUPS to match the table you are querying.
 */
export function childHubPredicate(
  hubs: string[] | null,
  col: string,
): { sql: string; params: string[] } | null {
  if (!hubs || !hubs.length) return null;
  // Not de-duplicated: a repeated id costs a placeholder and changes no row, and
  // the one place duplication is actually visible — the /v1/child-hubs picker —
  // is guarded in selectedHubIds. One guard, so a test can hold it.
  const ids = hubs.map(norm).filter(h => h !== LOCAL_HUB);
  const parts: string[] = [];
  if (ids.length) parts.push(`${col} IN (${ids.map(() => '?').join(',')})`);
  if (hubs.some(h => norm(h) === LOCAL_HUB)) parts.push(`${col} = ''`);
  // An id list matching no hub yields `... IN ('nope')`, which matches nothing —
  // deliberately, so a stale link to a hub that has since been removed shows an
  // empty result rather than quietly widening to the whole group.
  return { sql: `(${parts.join(' OR ')})`, params: ids };
}

/**
 * The same predicate as a trailing `AND ...` fragment, for the facet queries
 * that build their own WHERE instead of going through applyEventFilters. Events
 * only — every caller is a facet over `events`.
 */
export function childHubClause(hubs: string[] | null): { and: string; params: string[] } {
  const hub = childHubPredicate(hubs, HUB_COL_EVENTS);
  return hub ? { and: ` AND ${hub.sql}`, params: hub.params } : { and: '', params: [] };
}

/** The hub ids a caller explicitly selected — sentinel excluded, normalised and
 *  de-duplicated, so a repeated or mixed-case id cannot list a hub twice. */
export function selectedHubIds(hubs: string[] | null): string[] {
  return [...new Set((hubs ?? []).map(norm).filter(h => h !== LOCAL_HUB))];
}
