/**
 * Model provider + license-class facets for the PR Overview.
 *
 * The classification itself lives server-side in the `model_meta` table
 * (packages/hub/src/util/modelMeta.ts), seeded once per org and then editable
 * in Admin → Models. This module does NOT hold a seed — the old client-side
 * table was removed, because two copies would mean an admin edit in the UI
 * silently not affecting what the browser filters by.
 *
 * So everything here is derived from the `byModel` rows the API already
 * returns, each of which carries `provider` / `licenseClass` / `license`.
 * A model with no metadata arrives as `unclassified`, which is a real,
 * selectable bucket rather than a guess.
 */

export type LicenseClass = 'open_weights' | 'commercial';

/** Synthetic facet value for models the server could not classify. */
export const UNCLASSIFIED = 'unclassified';

/** The slice of a `byModel` entry this module needs. */
export interface ModelFacetRow {
  model: string;
  provider?: string;
  licenseClass?: LicenseClass;
  license?: string;
}

export interface ModelMeta {
  provider: string;
  licenseClass: LicenseClass;
  license: string;
}

const UNKNOWN: ModelMeta = {
  provider: UNCLASSIFIED,
  licenseClass: 'commercial',
  license: 'Unknown — no model_meta row matches',
};

/**
 * Metadata for one model, from the server-provided rows.
 *
 * Returns `unclassified` for a model absent from `rows` — callers must not
 * substitute a guess, since an unknown model being visibly unclassified is what
 * tells the admin the seed needs a row.
 */
export function modelMeta(model: string, rows: readonly ModelFacetRow[]): ModelMeta {
  const hit = rows.find(r => r.model === model);
  if (!hit || !hit.provider) return { ...UNKNOWN };
  return {
    provider: hit.provider,
    // Absent class is treated as commercial — the conservative reading, which
    // does not claim a licence the model may not grant.
    licenseClass: hit.licenseClass === 'open_weights' ? 'open_weights' : 'commercial',
    license: hit.license ?? '',
  };
}

/** Providers present, alphabetical, `unclassified` last. */
export function providersFor(rows: readonly ModelFacetRow[]): string[] {
  const set = new Set(rows.map(r => modelMeta(r.model, rows).provider));
  return [...set].sort((a, b) =>
    a === UNCLASSIFIED ? 1 : b === UNCLASSIFIED ? -1 : a.localeCompare(b));
}

/** License classes present, in canonical display order. */
export function licenseClassesFor(rows: readonly ModelFacetRow[]): LicenseClass[] {
  const set = new Set(rows.map(r => modelMeta(r.model, rows).licenseClass));
  return (['open_weights', 'commercial'] as LicenseClass[]).filter(c => set.has(c));
}

/**
 * Models matching ANY selected provider or license class.
 *
 * The two groups AND-combine with each other and OR-combine within themselves:
 * "Anthropic + OpenAI" crossed with "commercial" keeps both vendors' models,
 * while "Anthropic + open_weights" keeps only Anthropic models that are open
 * weights (currently none, which is the honest answer).
 *
 * This is a *predicate*: with both groups empty every model matches. Callers
 * asking "what did the user select" must handle the empty case first — see
 * resolveMetaSelection.
 */
export function modelsMatching(
  rows: readonly ModelFacetRow[],
  providers: Set<string>,
  classes: Set<string>,
): string[] {
  if (providers.size === 0 && classes.size === 0) return rows.map(r => r.model);
  return rows
    .filter(r => {
      const meta = modelMeta(r.model, rows);
      if (providers.size > 0 && !providers.has(meta.provider)) return false;
      if (classes.size > 0 && !classes.has(meta.licenseClass)) return false;
      return true;
    })
    .map(r => r.model);
}

/**
 * Model ids implied by a meta selection, merged with explicit picks.
 *
 * The meta-filter is a SELECTOR over the model list, not a second filter axis:
 * the result is written into the same `?model=` CSV the Model facet uses, so a
 * shared link restores the same view and the server sees nothing new.
 */
export function resolveMetaSelection(
  rows: readonly ModelFacetRow[],
  explicit: Set<string>,
  providers: Set<string>,
  classes: Set<string>,
): string[] {
  // No meta-selection -> contribute nothing. Falling through to modelsMatching
  // would return every model, because an empty selection means "unfiltered" in
  // a predicate — the opposite of "the user picked these".
  if (providers.size === 0 && classes.size === 0) return [...explicit];
  return [...new Set([...explicit, ...modelsMatching(rows, providers, classes)])];
}

export const LICENSE_CLASS_LABEL: Record<LicenseClass, string> = {
  open_weights: 'Open weights',
  commercial: 'Commercial / API only',
};
