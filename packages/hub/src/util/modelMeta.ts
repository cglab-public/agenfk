/**
 * Provider + license class per model, backed by the `model_meta` table
 * (CGLAB-133 follow-up).
 *
 * The hub stores `model` as free text an agent self-reports (see
 * modelMapping.ts, which owns the *name* axis) and has no provider or license
 * column, so the PR Overview's Provider / Open-weights / Commercial facets need
 * a source of truth. That source is the `model_meta` table:
 *
 *   - first read for an org inserts MODEL_META_SEED, so it works out of the box;
 *   - from then on the TABLE wins and the admin edits rows in Admin → Models;
 *   - this file is never consulted again, so shipping a new seed cannot
 *     silently overwrite an operator's corrections.
 *
 * Matching is longest-prefix, on the normalised id, for two reasons:
 *   - one family spans both license classes (qwen3.8-27b Apache-2.0 vs
 *     qwen3.8-max API-only), so a family-level row would be wrong for one of
 *     them;
 *   - a new patch release of a family usually keeps the licence, so a family
 *     row is a useful fallback that an admin can specialise.
 *
 * Unmatched models are `unclassified`, never guessed — the UI shows that bucket
 * so an unknown model is visible and filterable rather than silently mislabelled.
 */
import type { HubDb } from '../db/types.js';
import { MODEL_META_SEED, type LicenseClass } from './modelMetaSeed.js';

export type { LicenseClass };

/** Synthetic facet value for models with no matching row. */
export const UNCLASSIFIED = 'unclassified';

export interface ModelMetaRow {
  model: string;
  provider: string;
  licenseClass: LicenseClass;
  license: string;
  /** 'seed' = untouched auto-inserted row; 'admin' = human-set or edited. */
  source: 'seed' | 'admin';
}

export interface ModelMeta extends ModelMetaRow {
  /** True when nothing matched — callers should surface this, not hide it. */
  unclassified: boolean;
}

/**
 * Normalise a reported model id for matching.
 *
 * Router/provider prefixes are stripped because the same artifact reaches the
 * hub under several routes: `@cf/zai-org/glm-5.2` (Cloudflare Workers AI) and
 * `anthropic/claude-opus-4-8` (OpenRouter) are the models their suffix names —
 * the suffix identifies the artifact, the prefix identifies the reseller.
 *
 * Applied to the MATCH KEY only, never to the stored id: `qwen3.8:27b`,
 * `Qwen38-27b` and `qwen-3.8-27b` are one artifact. Admin aliasing
 * (model_mappings) remains authoritative for names; this is the other axis.
 */
export function normaliseModelId(model: string): string {
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

/**
 * Agent runtimes, not models. These reach the hub in the model axis when a
 * harness reports its own name, and must not be classified as a model from the
 * vendor they resemble — `claude-code` is a harness, not an Anthropic model,
 * even though `claude` is a seeded provider.
 */
const HARNESS_NAMES = new Set([
  'claude-code', 'claude-code-cli', 'codex-cli', 'opencode', 'cursor',
  'windsurf', 'aider', 'pi', 'openclaw', 'gemini-cli', 'copilot-cli',
]);

export function isHarnessName(model: string): boolean {
  return HARNESS_NAMES.has(normaliseModelId(model));
}

const UNCLASSIFIED_META: ModelMeta = {
  model: '',
  provider: UNCLASSIFIED,
  licenseClass: 'commercial',
  license: 'Unknown — no model_meta row matches',
  source: 'seed',
  unclassified: true,
};

/**
 * Load an org's model_meta rows, inserting the seed first time round.
 *
 * The seed insert is `INSERT ... DO NOTHING` guarded by a cheap existence
 * check, so it runs exactly once per org and can never touch rows an admin has
 * edited. A failure to seed (e.g. a read-only DB) degrades to "no metadata"
 * rather than failing the dashboard.
 */
export async function loadModelMeta(db: HubDb, orgId: string): Promise<readonly ModelMetaRow[]> {
  const existing = await db.get<{ c: number | string }>(
    'SELECT COUNT(*) AS c FROM model_meta WHERE org_id = ?',
    [orgId],
  );
  if (Number(existing?.c ?? 0) === 0) {
    for (const s of MODEL_META_SEED) {
      await db.run(
        `INSERT INTO model_meta (org_id, model, provider, license_class, license, source)
         VALUES (?, ?, ?, ?, ?, 'seed')
         ON CONFLICT(org_id, model) DO NOTHING`,
        [orgId, s.model, s.provider, s.licenseClass, s.license],
      );
    }
  }

  const rows = await db.all<{
    model: string; provider: string; license_class: string; license: string; source: string;
  }>(
    'SELECT model, provider, license_class, license, source FROM model_meta WHERE org_id = ? ORDER BY model',
    [orgId],
  );

  return rows.map(r => ({
    model: r.model,
    provider: r.provider,
    // A row written before the CHECK existed, or hand-edited, could hold a
    // value we do not know. Treat anything unrecognised as commercial, the
    // conservative reading (it does not claim a licence it may not grant).
    licenseClass: r.license_class === 'open_weights' ? 'open_weights' : 'commercial',
    license: r.license,
    source: r.source === 'admin' ? 'admin' : 'seed',
  }));
}

/**
 * Resolve one model id against loaded rows. Longest matching `model` prefix
 * wins, so a specific artifact overrides its own family row.
 */
export function resolveModelMeta(
  model: string | null | undefined,
  rows: readonly ModelMetaRow[],
): ModelMeta {
  if (!model) return { ...UNCLASSIFIED_META };
  const id = normaliseModelId(model);
  if (!id || isHarnessName(model)) return { ...UNCLASSIFIED_META };

  let best: ModelMetaRow | null = null;
  for (const r of rows) {
    const key = normaliseModelId(r.model);
    if (!key || (id !== key && !id.startsWith(key))) continue;
    if (!best || normaliseModelId(best.model).length > key.length) best = r;
  }

  if (!best) return { ...UNCLASSIFIED_META };
  return { ...best, unclassified: false };
}

/**
 * Resolve every model in a list, in one pass over the rows.
 *
 * The dashboard calls this for the whole `byModel` array, so it sorts the keys
 * once and reuses them instead of rescanning the table per model.
 */
export function resolveModelMetaAll(
  models: readonly string[],
  rows: readonly ModelMetaRow[],
): Map<string, ModelMeta> {
  const ordered = rows
    .map(r => ({ r, key: normaliseModelId(r.model) }))
    .filter(x => x.key)
    .sort((a, b) => b.key.length - a.key.length);

  const out = new Map<string, ModelMeta>();
  for (const m of models) {
    const id = normaliseModelId(m ?? '');
    if (!id || isHarnessName(m)) { out.set(m, { ...UNCLASSIFIED_META }); continue; }
    const hit = ordered.find(x => id === x.key || id.startsWith(x.key));
    out.set(m, hit ? { ...hit.r, unclassified: false } : { ...UNCLASSIFIED_META });
  }
  return out;
}

export const LICENSE_CLASS_LABEL: Record<LicenseClass, string> = {
  open_weights: 'Open weights',
  commercial: 'Commercial / API only',
};

export function isLicenseClass(v: unknown): v is LicenseClass {
  return v === 'open_weights' || v === 'commercial';
}
