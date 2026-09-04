/**
 * Unified model table for Admin → Models (CGLAB-133 follow-up).
 *
 * One row per model NAME, with the reported spellings that fold into it nested
 * underneath. Aliasing and classification are two different axes and the row
 * shape says so deliberately:
 *
 *   - aliasing keys on a reported SPELLING (qwen38-27b -> qwen3.8-27b);
 *   - provider/license keys on the model NAME and matches by prefix.
 *
 * So provider/license attach to the group row — the canonical name the
 * dashboard displays and filters by — never to an individual spelling.
 * Classifying a spelling would mean the same model has two licences depending
 * on which agent reported it.
 *
 * Kept out of the component so the merge rules are testable without a DOM
 * (same reasoning as modelMappings.ts, hiddenPeople.ts).
 */
import type { ModelGroup } from './modelMappings';
import type { ModelMetaRow } from './adminModelMeta';

export const UNCLASSIFIED = 'unclassified';

/**
 * A model_meta row as it applies to one group.
 *
 * `exact` distinguishes a row written for THIS name from a family rule matched
 * by prefix (`glm-` classifying `glm-5.2`). That distinction is what the UI
 * shows, because an inherited rule otherwise looks like a value the admin
 * never set — and saving would silently replace the family rule with a
 * per-model one.
 */
export interface AppliedMeta {
  provider: string;
  licenseClass: 'open_weights' | 'commercial';
  license: string;
  source: 'seed' | 'admin';
  /** True when the row's key is this exact name, false when matched by prefix. */
  exact: boolean;
  /** The model_meta key that matched, e.g. "glm-" for a glm-5.2 row. */
  matchedKey: string;
}

export interface UnifiedRow {
  canonicalModel: string;
  prs: number;
  /** Reported spellings folded into this name, plus mappings never observed. */
  aliasCount: number;
  aliases: Array<{ model: string; prs: number }>;
  meta: AppliedMeta | null;
  /**
   * True when no model_meta row matches at all. This is the state a newly
   * reported model arrives in: unknown licence, not a guessed one.
   */
  unknown: boolean;
  /** How many observed models a family rule currently classifies. */
  familyCovers?: number;
}

/**
 * Normalise a key for prefix comparison.
 *
 * Mirrors the hub's normaliseModelId so the UI's "which rule matched" display
 * agrees with what the server actually resolved. Kept local (rather than
 * importing) because hub-ui cannot import from packages/hub.
 */
export function normalizeKey(model: string): string {
  let id = model.trim().toLowerCase();
  const slash = id.lastIndexOf('/');
  if (slash >= 0) id = id.slice(slash + 1);
  return id
    .replace(/^@cf\//, '')
    .replace(/[_\s]+/g, '-')
    .replace(/([a-z])\./g, '$1-')
    .replace(/\.(\d)/g, '-$1')
    .replace(/-+/g, '-');
}

/** Longest-matching model_meta rule for `model`, or null when none matches. */
export function matchMeta(
  model: string,
  rows: readonly ModelMetaRow[],
): { row: ModelMetaRow; exact: boolean } | null {
  const id = normalizeKey(model);
  if (!id) return null;
  let best: { row: ModelMetaRow; exact: boolean } | null = null;
  for (const row of rows) {
    const key = normalizeKey(row.model);
    if (!key || (id !== key && !id.startsWith(key))) continue;
    const exact = id === key;
    if (!best || key.length > normalizeKey(best.row.model).length) best = { row, exact };
  }
  return best;
}

/**
 * Fold groups + metadata into the unified row list.
 *
 * `scope` controls which models appear:
 *   - 'observed' (default): only names that have actually been reported. The
 *     seed carries ~100 rules for models an org may never run, and showing
 *     them by default buries the handful the admin actually cares about.
 *   - 'all': every group plus every seeded rule that matched nothing, so the
 *     family rules are inspectable and editable.
 */
export function buildUnifiedRows(
  groups: readonly ModelGroup[],
  metaRows: readonly ModelMetaRow[],
  scope: 'observed' | 'all' = 'observed',
): UnifiedRow[] {
  // How many observed models each rule currently classifies, so a family row
  // can say "applies to 3" instead of silently governing models not on screen.
  const covers = new Map<string, number>();
  for (const g of groups) {
    const hit = matchMeta(g.canonicalModel, metaRows);
    if (hit) covers.set(hit.row.model, (covers.get(hit.row.model) ?? 0) + 1);
  }

  const rows: UnifiedRow[] = groups.map(g => {
    const hit = matchMeta(g.canonicalModel, metaRows);
    return {
      canonicalModel: g.canonicalModel,
      prs: g.prs,
      aliasCount: g.aliases.filter(a => a.model !== g.canonicalModel).length + g.unusedMappings.length,
      aliases: g.aliases.map(a => ({ model: a.model, prs: a.prs })),
      meta: hit ? {
        provider: hit.row.provider,
        licenseClass: hit.row.licenseClass,
        license: hit.row.license,
        source: hit.row.source,
        exact: hit.exact,
        matchedKey: hit.row.model,
      } : null,
      unknown: !hit,
      ...(hit && !hit.exact && covers.get(hit.row.model)
        ? { familyCovers: covers.get(hit.row.model) }
        : {}),
    };
  });

  if (scope === 'all') {
    const shown = new Set(rows.map(r => r.meta?.matchedKey));
    for (const row of metaRows) {
      if (shown.has(row.model)) continue;
      // A rule that classified nothing observed. Kept visible in 'all' scope so
      // family rules are editable, but marked unknown:false / prs:0 so it reads
      // as a rule rather than a model with traffic.
      rows.push({
        canonicalModel: row.model,
        prs: 0,
        aliasCount: 0,
        aliases: [],
        meta: {
          provider: row.provider,
          licenseClass: row.licenseClass,
          license: row.license,
          source: row.source,
          exact: true,
          matchedKey: row.model,
        },
        unknown: false,
      });
    }
  }

  // Unknown-first: an unclassified model is the thing needing attention, and
  // after a new agent ships it should be the first row on the page, not
  // alphabetically buried among ~100 seeded rules.
  return rows.sort((a, b) =>
    (b.unknown ? 1 : 0) - (a.unknown ? 1 : 0)
    || (a.meta?.source === 'admin' ? 0 : 1) - (b.meta?.source === 'admin' ? 0 : 1)
    || b.prs - a.prs
    || a.canonicalModel.localeCompare(b.canonicalModel));
}

/**
 * The value to prefill an editor with.
 *
 * An inherited family rule is shown as-is so the admin sees what the model
 * currently resolves to — but the UI labels it "inherited from `glm-`", because
 * saving turns it into a rule for this one model.
 */
export function editorInitial(row: UnifiedRow): {
  provider: string; licenseClass: 'open_weights' | 'commercial' | ''; license: string;
} {
  return {
    provider: row.meta?.provider ?? '',
    licenseClass: row.meta?.licenseClass ?? '',
    license: row.meta?.license ?? '',
  };
}

/**
 * Does this edit actually change anything?
 *
 * Used to disable Save when nothing moved. Saving an unchanged inherited rule
 * is not a no-op — it converts a family rule into a per-model one — so the form
 * should not let that happen by accident.
 */
export function isDirty(
  row: UnifiedRow,
  draft: { provider: string; licenseClass: string; license: string },
): boolean {
  if (!row.meta) return !!(draft.provider || draft.licenseClass || draft.license);
  return draft.provider.trim() !== row.meta.provider
    || draft.licenseClass !== row.meta.licenseClass
    || draft.license.trim() !== row.meta.license;
}

export const UNKNOWN_LABEL = 'Unknown';
