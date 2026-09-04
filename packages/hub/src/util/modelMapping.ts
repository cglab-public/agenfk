/**
 * Admin-curated model identity (the `model` axis of user_key aliases).
 *
 * A model id is free text an agent self-reports via `--model <id>`, so one
 * model reaches the hub as several spellings and every dashboard that groups by
 * the raw string shows them as separate models.
 *
 * The mapping is an overlay resolved at READ time. `events` keeps whatever was
 * actually reported: it is append-only telemetry of what an agent claimed, and
 * rewriting it would destroy that fact and be undone by the next event anyway.
 *
 * Resolution is a single exact lookup — no fuzzy matching, no normalization
 * rule. A rule that maps `-` to `:` and `38` to `3.8` would merge models that
 * are genuinely different, silently and invisibly to the admin. Here the
 * canonical name is exactly the string the admin typed and only the aliases
 * they listed fold into it.
 */

/** alias -> canonical, for one org. Empty map means no mappings configured. */
export type ModelMapping = ReadonlyMap<string, string>;

export const EMPTY_MODEL_MAPPING: ModelMapping = new Map();

/**
 * The name a reported model id should be displayed and grouped under.
 *
 * Returns the input unchanged when nothing is mapped. Unknown and empty ids
 * pass through so the dashboard still shows the raw value rather than dropping
 * the PR or showing a blank row.
 *
 * Matching is alias-keyed, NOT normalised: an alias is a literal spelling the
 * admin chose (the seed itself keeps `:` as a size separator, so `qwen3.8:27b`
 * and `qwen-3.8-27b` are deliberately different aliases for one canonical name),
 * and `model_mappings` has a CHECK that two aliases cannot share a canonical —
 * so one alias can never mean two models. Normalising here would invent a
 * matching rule the admin table does not have.
 */
export function resolveModelId(model: string | null, mapping: ModelMapping): string | null {
  if (!model) return model;
  const hit = mapping.get(model);
  if (hit !== undefined) return hit;
  // A harness may report the same artifact through its route, e.g. pi now
  // reports `coding4/qwen38-27b` where it once reported `qwen38-27b` (the
  // provider prefix disambiguates settings.json's defaultProvider + defaultModel
  // split). Without this, every provider-qualified report would slip past the
  // admin's alias and split into its own dashboard group next to the mapped one.
  // The prefix names the reseller, not the artifact — the same reason
  // modelMeta.normaliseModelId strips it on the licence axis.
  const slash = model.lastIndexOf('/');
  if (slash >= 0) {
    const bare = model.slice(slash + 1);
    const bareHit = bare ? mapping.get(bare) : undefined;
    if (bareHit !== undefined) return bareHit;
  }
  return model;
}

/**
 * Resolve a filter value instead of a stored one.
 *
 * A filter must be resolved through the mapping too: once rows are grouped
 * under the canonical name, a saved link or bookmark to `?model=qwen38-27b`
 * would otherwise match nothing and the dashboard would silently report zero
 * PRs for a model that has plenty. Both sides of the comparison land on the
 * canonical name, so any spelling the admin has mapped resolves to the same
 * group.
 *
 * Values with no mapping are left as-is, which is correct: an unmapped id is
 * its own group, and filtering by it must still return it.
 */
export function resolveModelFilter(models: string[] | null, mapping: ModelMapping): string[] | null {
  if (!models || !models.length) return models;
  return [...new Set(models.map(m => resolveModelId(m, mapping) as string))];
}

/**
 * Load an org's mappings.
 *
 * Called per request by the surfaces that group by model. The table is small by
 * construction — one row per alias an admin has chosen to fold — so a fresh
 * read is cheaper than a cache that has to be invalidated on every admin edit,
 * and it means an edit is visible on the next page load rather than after a TTL.
 */
export async function loadModelMappings(
  db: { all<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> },
  orgId: string,
): Promise<ModelMapping> {
  const rows = await db.all<{ alias_model: string; canonical_model: string }>(
    'SELECT alias_model, canonical_model FROM model_mappings WHERE org_id = ?',
    [orgId],
  );
  if (!rows.length) return EMPTY_MODEL_MAPPING;
  return new Map(rows.map(r => [r.alias_model, r.canonical_model]));
}
