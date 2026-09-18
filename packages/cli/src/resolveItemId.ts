/**
 * Resolve an item id the way every other AgEnFK command does: a full UUID is
 * taken as-is, a shorter value is matched as a PREFIX against the item list.
 *
 * Extracted because `run list --item` did NOT do this: it passed the value
 * straight to a route that filters by exact id, so `run list --item 2cab541e`
 * returned [] for a card that plainly had runs. That inconsistency with
 * `agenfk get` is not cosmetic - it made a working feature look broken during
 * a diagnosis. Ambiguity is an error rather than a guess, same as `get`.
 *
 * Pure: the caller fetches the list. Returns the full id, or why it could not.
 */
export function resolveItemIdPrefix<T extends { id: string }>(
  items: readonly T[],
  id: string,
): { ok: true; id: string } | { ok: false; error: string } {
  if (id.length >= 36) return { ok: true, id };
  const found = items.filter(i => i.id.startsWith(id));
  if (found.length === 0) return { ok: false, error: `No item found starting with ${id}` };
  if (found.length > 1) return { ok: false, error: `Ambiguous ID ${id}, matches multiple items` };
  return { ok: true, id: found[0].id };
}