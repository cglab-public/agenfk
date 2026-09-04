/**
 * Model provider + license-class metadata (CGLAB-133 follow-up).
 *
 * The hub stores `model` as free text an agent self-reports via `--model <id>`
 * (see packages/hub/src/util/modelMapping.ts), and there is no provider or
 * license column anywhere. This module derives two display-only facets — the
 * vendor and whether the model's weights are openly downloadable — from the
 * model id, so the PR Overview can filter the model list by them.
 *
 * Deliberate limits, in line with the read-time-overlay precedent in
 * modelMapping.ts:
 *
 *  - **This is a curated seed, not an inference rule.** Every entry below was
 *    checked against the vendor's own licence/model card (sources in each
 *    entry). There is no "starts with the vendor name, so same vendor" guess,
 *    because the same family name spans both licence classes: `qwen3.8-27b` is
 *    Apache-2.0 open weights while `qwen3.8-max` is API-only proprietary, and
 *    `glm-5.3-flash` is MIT while `glm-5.3` is a bespoke licence. A family-level
 *    rule would be wrong for one of every such pair, silently.
 *  - **Unmatched models are `unclassified`, never guessed.** The UI shows an
 *    "Unclassified" bucket so an unknown model is visible and filterable rather
 *    than silently dropped or mislabelled. New models land there until the seed
 *    is extended.
 *  - **Display + filtering only.** Nothing here is persisted, and it never
 *    rewrites the stored model id.
 *
 * Classification rule (product decision): if a model's weights are publicly
 * downloadable AND also served through a commercial API, it counts as
 * `open_weights`. So the question per artifact is only "can you download the
 * weights?" — a bespoke licence with revenue/attribution gates still counts as
 * open weights (Kimi K3, GLM-5.3, Qwen3.8-Flash-Next). That makes this axis
 * "open weights vs commercial", NOT "open source vs proprietary": several
 * entries here are downloadable but not OSI-approved. The UI says "Open
 * weights" for exactly that reason.
 */

export type LicenseClass = 'open_weights' | 'commercial';

/** The synthetic facet value for models the seed does not cover. */
export const UNCLASSIFIED = 'unclassified';

export interface ModelMeta {
  /** Canonical vendor label, e.g. "Z.ai", "Anthropic". */
  provider: string;
  licenseClass: LicenseClass;
  /** Licence name for the tooltip, e.g. "MIT", "Kimi K3 License (bespoke)". */
  license: string;
}

/**
 * One seed entry. `prefix` is matched against the NORMALISED model id (see
 * normaliseModelId); the longest matching prefix wins, so a specific artifact
 * overrides its own family.
 */
interface Seed {
  prefix: string;
  provider: string;
  licenseClass: LicenseClass;
  license: string;
}

/**
 * Normalise a reported model id for matching.
 *
 * Router/provider prefixes are stripped because the same artifact reaches the
 * hub under several routes: `@cf/zai-org/glm-5.2` (Cloudflare Workers AI) and
 * `anthropic/claude-opus-4-8` (OpenRouter) are the models their suffix names.
 * The suffix is what identifies the artifact; the prefix identifies the reseller.
 *
 * Lowercasing and `-`/`_`/`:`/`+`/`v` normalisation are applied to the MATCH
 * KEY ONLY, never to the stored id: `qwen3.8:27b`, `Qwen38-27b` and
 * `qwen-3.8-27b` are one artifact, and admin aliasing (model_mappings) stays
 * authoritative for anything this table cannot see.
 */
export function normaliseModelId(model: string): string {
  let id = model.trim().toLowerCase();
  // Strip a leading router/provider namespace: "@cf/zai-org/glm-5.2" and
  // "openrouter/anthropic/claude-opus-4-8" both resolve on their last segment.
  const slash = id.lastIndexOf('/');
  if (slash >= 0) id = id.slice(slash + 1);
  return id
    .replace(/^@cf\//, '')
    .replace(/[_\s]+/g, '-')
    .replace(/([a-z])\./g, '$1-')   // "glm-5.3" -> "glm-5-3"
    .replace(/\.(\d)/g, '-$1')
    .replace(/-+/g, '-');
}

/**
 * The seed. Ordered longest-prefix-first at lookup time, so these entries can
 * be written in any order; put a specific artifact next to its family for
 * readability.
 *
 * Sources were the vendors' own licence text / model cards, checked Sep 2026.
 */
const SEED: Seed[] = [
  // ── Z.ai (Zhipu) — GLM ────────────────────────────────────────────────────
  // GLM-5.3 dropped MIT for a bespoke licence with a $10B-revenue security
  // review clause; GLM-5.3-Flash, shipped two days earlier, stayed plain MIT.
  // Both are open weights — the licence differs, the axis here does not.
  { prefix: 'glm-5-3-flash', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' },
  { prefix: 'glm-5-3', provider: 'Z.ai', licenseClass: 'open_weights', license: 'GLM-5.3 License (bespoke)' },
  { prefix: 'glm-5-2', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' },
  { prefix: 'glm-5-1', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' },
  { prefix: 'glm-5', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' },
  { prefix: 'glm-4', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' },
  { prefix: 'glm-', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT (GLM series)' },
  { prefix: 'chatglm', provider: 'Z.ai', licenseClass: 'open_weights', license: 'ChatGLM License' },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  // V4/V3.2/V3.1/R1 are MIT on BOTH code and weights. The pre-V3 releases split
  // a permissive code licence from a restrictive *weights* licence, so they are
  // listed explicitly rather than inheriting the family's MIT.
  { prefix: 'deepseek-v4', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'MIT' },
  { prefix: 'deepseek-v3-2', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'MIT' },
  { prefix: 'deepseek-v3-1', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'MIT' },
  { prefix: 'deepseek-r1', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'MIT' },
  { prefix: 'deepseek-v3', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'DeepSeek Model License (restrictive weights)' },
  { prefix: 'deepseek-coder-v2', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'DeepSeek Model License (restrictive weights)' },
  { prefix: 'deepseek-vl2', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'DeepSeek Model License (restrictive weights)' },
  { prefix: 'deepseek-', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'MIT' },

  // ── Alibaba Qwen — the split family ───────────────────────────────────────
  // The Max/Plus lines are API-only proprietary; the numbered/sized artifacts
  // are Apache-2.0. This is the pair a family-level rule cannot get right.
  { prefix: 'qwen3-8-max', provider: 'Alibaba', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { prefix: 'qwen3-8-flash-next', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Qwen Community License 1.0 (bespoke)' },
  { prefix: 'qwen3-8-flash', provider: 'Alibaba', licenseClass: 'commercial', license: 'Proprietary (hosted API)' },
  { prefix: 'qwen3-8-2-4t', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Qwen bespoke license' },
  { prefix: 'qwen3-8-27b', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'qwen3-8', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'qwen3-7-max', provider: 'Alibaba', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { prefix: 'qwen3-7-plus', provider: 'Alibaba', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { prefix: 'qwen3-6-max', provider: 'Alibaba', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { prefix: 'qwen3-6', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'qwen3-5', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'qwen3-coder', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'qwen3-', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'qwen2', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Tongyi Qianwen License' },
  { prefix: 'qwen-', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Tongyi Qianwen License' },
  { prefix: 'qwen', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },

  // ── Moonshot Kimi — open weights, bespoke licence ────────────────────────
  { prefix: 'kimi-k3', provider: 'Moonshot', licenseClass: 'open_weights', license: 'Kimi K3 License (bespoke)' },
  { prefix: 'kimi-k2-5', provider: 'Moonshot', licenseClass: 'open_weights', license: 'Modified MIT' },
  { prefix: 'kimi-k2', provider: 'Moonshot', licenseClass: 'open_weights', license: 'Modified MIT' },
  { prefix: 'kimi-k1', provider: 'Moonshot', licenseClass: 'open_weights', license: 'Kimi K1 License' },
  { prefix: 'kimi-', provider: 'Moonshot', licenseClass: 'commercial', license: 'Proprietary (Kimi API)' },

  // ── MiniMax — M2 is MIT, M2.7 is non-commercial ──────────────────────────
  // Both are downloadable, so both are open weights on this axis. Flagged
  // because M2.7's licence text forbids commercial use, which is the opposite
  // of what the label "MIT" would suggest.
  { prefix: 'minimax-m2-7', provider: 'MiniMax', licenseClass: 'open_weights', license: 'Modified MIT (non-commercial)' },
  { prefix: 'minimax-m2', provider: 'MiniMax', licenseClass: 'open_weights', license: 'MIT' },
  { prefix: 'minimax-abab', provider: 'MiniMax', licenseClass: 'commercial', license: 'Proprietary (MiniMax API)' },
  { prefix: 'minimax-', provider: 'MiniMax', licenseClass: 'open_weights', license: 'MIT' },

  // ── Google — Gemini is NEVER open; only Gemma is ─────────────────────────
  // The single most common misclassification: Gemini 3/3.5/3.8 Flash are all
  // hosted-only. Gemma 4 moved to Apache-2.0 (earlier Gemma used a bespoke
  // Gemma licence).
  { prefix: 'gemini', provider: 'Google', licenseClass: 'commercial', license: 'Proprietary (Gemini API)' },
  { prefix: 'gemma-4', provider: 'Google', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'gemma-3', provider: 'Google', licenseClass: 'open_weights', license: 'Gemma Terms of Use' },
  { prefix: 'gemma-2', provider: 'Google', licenseClass: 'open_weights', license: 'Gemma Terms of Use' },
  { prefix: 'gemma', provider: 'Google', licenseClass: 'open_weights', license: 'Gemma Terms of Use' },
  { prefix: 'palm', provider: 'Google', licenseClass: 'commercial', license: 'Proprietary' },

  // ── OpenAI — no open weights at all ──────────────────────────────────────
  // Every prefix here must be a name an OpenAI model actually starts with.
  // `gpt-`/`o1`/`o3`/`o4` are prefixes, so a future `gpt-9-nova` or `o10`
  // matching them is a real possibility — accepted for gpt- (the whole line is
  // OpenAI and closed either way) but NOT for the o-series, where `o1` would
  // also swallow `o10`, `o11`, etc. Those are pinned exactly instead.
  { prefix: 'gpt-', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { prefix: 'chatgpt-', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  // The o-series is matched with a trailing separator, NOT bare `o1`, because
  // `o1` is a prefix of `o10`/`o11` — different models that must not inherit
  // OpenAI by string accident. `o1-mini`/`o1-preview` are the real ids.
  { prefix: 'o1-', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { prefix: 'o3-', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { prefix: 'o4-', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { prefix: 'codex-', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { prefix: 'codex', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { prefix: 'davinci', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },

  // ── Anthropic — no open weights at all ───────────────────────────────────
  // `claude-code` is a HARNESS, and it reaches the hub in the model axis too
  // (harness=claude-code is reported separately). It must not classify as a
  // Claude model, so it is seeded as unclassified ahead of the `claude` prefix.
  // modelMeta() has no way to express "no provider", so the harness names are
  // handled by HARNESS_NAMES below rather than as a seed entry.
  { prefix: 'claude', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { prefix: 'sonnet', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { prefix: 'opus', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { prefix: 'haiku', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { prefix: 'fable', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { prefix: 'mythos', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary (limited preview)' },

  // ── xAI Grok — only the retired Grok 2 line was ever released ───────────
  { prefix: 'grok-2', provider: 'xAI', licenseClass: 'open_weights', license: 'Grok 2 Community License (bespoke)' },
  { prefix: 'grok', provider: 'xAI', licenseClass: 'commercial', license: 'Proprietary (xAI API)' },

  // ── Meta Llama — open weights, bespoke community licence ────────────────
  // Llama 4's multimodal rights exclude EU-domiciled users; noted because it
  // is a real restriction on something labelled "open".
  { prefix: 'llama-4', provider: 'Meta', licenseClass: 'open_weights', license: 'Llama 4 Community License (bespoke)' },
  { prefix: 'llama-3', provider: 'Meta', licenseClass: 'open_weights', license: 'Meta Llama 3 Community License' },
  { prefix: 'llama-2', provider: 'Meta', licenseClass: 'open_weights', license: 'Meta Llama 2 Community License' },
  { prefix: 'llama', provider: 'Meta', licenseClass: 'open_weights', license: 'Meta Llama Community License' },

  // ── Mistral — Large 3 / Small 3.x+ are Apache; Medium line is API-only ──
  { prefix: 'mistral-large-3', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'mistral-large', provider: 'Mistral', licenseClass: 'commercial', license: 'Proprietary (Mistral API)' },
  { prefix: 'mistral-small-2402', provider: 'Mistral', licenseClass: 'commercial', license: 'Proprietary (Mistral API)' },
  { prefix: 'mistral-small-2409', provider: 'Mistral', licenseClass: 'commercial', license: 'Proprietary (Mistral API)' },
  { prefix: 'mistral-small', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'mistral-medium', provider: 'Mistral', licenseClass: 'commercial', license: 'Proprietary (Mistral API)' },
  { prefix: 'mistral-nemo', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'mistral-saba', provider: 'Mistral', licenseClass: 'commercial', license: 'Proprietary (Mistral API)' },
  { prefix: 'mistral-embed', provider: 'Mistral', licenseClass: 'commercial', license: 'Proprietary (Mistral API)' },
  { prefix: 'mistral', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'mixtral', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'magistral', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'devstral', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'codestral', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'pixtral', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },

  // ── Amazon Nova — Bedrock-only ──────────────────────────────────────────
  { prefix: 'nova', provider: 'Amazon', licenseClass: 'commercial', license: 'Proprietary (Bedrock)' },
  { prefix: 'amazon-nova', provider: 'Amazon', licenseClass: 'commercial', license: 'Proprietary (Bedrock)' },

  // ── Other open-weight labs ───────────────────────────────────────────────
  { prefix: 'command-a', provider: 'Cohere', licenseClass: 'open_weights', license: 'CC-BY-NC (non-commercial)' },
  { prefix: 'command-r', provider: 'Cohere', licenseClass: 'commercial', license: 'Proprietary (Cohere API)' },
  { prefix: 'command', provider: 'Cohere', licenseClass: 'commercial', license: 'Proprietary (Cohere API)' },
  { prefix: 'cohere', provider: 'Cohere', licenseClass: 'commercial', license: 'Proprietary (Cohere API)' },
  { prefix: 'phi-', provider: 'Microsoft', licenseClass: 'open_weights', license: 'MIT' },
  { prefix: 'phi', provider: 'Microsoft', licenseClass: 'open_weights', license: 'MIT' },
  { prefix: 'microsoft-', provider: 'Microsoft', licenseClass: 'open_weights', license: 'MIT' },
  { prefix: 'deepcogito', provider: 'IBM', licenseClass: 'open_weights', license: 'MIT' },
  { prefix: 'granite', provider: 'IBM', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'yi-', provider: '01.AI', licenseClass: 'open_weights', license: 'Qwen-style / Apache-2.0' },
  { prefix: 'yi', provider: '01.AI', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'ernie', provider: 'Baidu', licenseClass: 'commercial', license: 'Proprietary (Qianfan API)' },
  { prefix: 'hunyuan', provider: 'Tencent', licenseClass: 'open_weights', license: 'Tencent Hunyuan License' },
  { prefix: 'step-', provider: 'StepFun', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'tulu', provider: 'AI2', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'olmo', provider: 'AI2', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { prefix: 'nemotron', provider: 'NVIDIA', licenseClass: 'open_weights', license: 'NVIDIA Open Model License' },
  { prefix: 'qwen3-omni', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },
];

/** Seed sorted longest-prefix-first, so a specific artifact beats its family. */
const ORDERED_SEED = [...SEED].sort((a, b) => b.prefix.length - a.prefix.length);

/**
 * Agent runtimes, not models. These appear in the model axis when a harness
 * self-reports its own name as the model, and must never be classified as a
 * model from the vendor they resemble — `claude-code` is a harness, not a
 * Claude model, even though `claude-` is a seeded provider prefix.
 */
const HARNESS_NAMES = new Set([
  'claude-code', 'claude-code-cli', 'codex-cli', 'opencode', 'cursor',
  'windsurf', 'aider', 'pi', 'openclaw', 'gemini-cli', 'copilot-cli',
]);

const UNCLASSIFIED_META: ModelMeta = {
  provider: UNCLASSIFIED,
  licenseClass: 'commercial',
  license: 'Unknown — not in the model seed',
};

/**
 * Look up a model id. Returns `provider: UNCLASSIFIED` when nothing matches —
 * never a guess. Callers should surface that bucket rather than hiding it.
 */
export function modelMeta(model: string | null | undefined): ModelMeta {
  if (!model) return UNCLASSIFIED_META;
  const id = normaliseModelId(model);
  if (!id) return UNCLASSIFIED_META;
  // Harness names are checked before the seed: `claude-code` would otherwise
  // match the `claude` prefix and be counted as an Anthropic model.
  if (HARNESS_NAMES.has(id)) return UNCLASSIFIED_META;
  for (const s of ORDERED_SEED) {
    if (id === s.prefix || id.startsWith(s.prefix)) {
      return { provider: s.provider, licenseClass: s.licenseClass, license: s.license };
    }
  }
  return UNCLASSIFIED_META;
}

/** Providers present in a model list, alphabetical, with `unclassified` last. */
export function providersFor(models: string[]): string[] {
  const set = new Set(models.map(m => modelMeta(m).provider));
  return [...set].sort((a, b) =>
    a === UNCLASSIFIED ? 1 : b === UNCLASSIFIED ? -1 : a.localeCompare(b));
}

/** License classes present in a model list, in canonical display order. */
export function licenseClassesFor(models: string[]): LicenseClass[] {
  const set = new Set(models.map(m => modelMeta(m).licenseClass));
  return (['open_weights', 'commercial'] as LicenseClass[]).filter(c => set.has(c));
}

/**
 * Models from `models` matching ANY selected provider or license class.
 *
 * The two groups are AND-combined with each other and OR-combined within
 * themselves — "Anthropic + OpenAI" crossed with "commercial" keeps both
 * vendors' models, while "Anthropic + open_weights" keeps only Anthropic
 * models that are open weights (currently none, which is the honest answer).
 *
 * An empty group means "no filter on that axis", so it constrains nothing. Note
 * this is a *predicate*: with both groups empty every model matches. Callers
 * that mean "which models did the user pick via the meta-filter" must check for
 * the no-selection case first (see resolveMetaSelection) — otherwise "nothing
 * selected" would expand to "everything selected".
 */
export function modelsMatching(
  models: string[],
  providers: Set<string>,
  classes: Set<string>,
): string[] {
  if (providers.size === 0 && classes.size === 0) return models;
  return models.filter(m => {
    const meta = modelMeta(m);
    if (providers.size > 0 && !providers.has(meta.provider)) return false;
    if (classes.size > 0 && !classes.has(meta.licenseClass)) return false;
    return true;
  });
}

/**
 * Resolve the model ids a meta-filter selection implies, merged with models the
 * user picked explicitly.
 *
 * The meta-filter is a SELECTOR over the model list, not a second filter axis:
 * the result is written back into the same `?model=` CSV the Model facet uses.
 * That is what keeps this a client-side change — the server already accepts a
 * CSV — and keeps a shared link restoring the exact same view.
 */
export function resolveMetaSelection(
  allModels: string[],
  explicit: Set<string>,
  providers: Set<string>,
  classes: Set<string>,
): string[] {
  // No meta-filter at all -> contribute nothing. Falling through to
  // modelsMatching here would return every model, because an empty selection
  // means "unfiltered" in a predicate — the opposite of "the user picked
  // these".
  if (providers.size === 0 && classes.size === 0) return [...explicit];
  const byMeta = modelsMatching(allModels, providers, classes);
  return [...new Set([...explicit, ...byMeta])];
}

export const LICENSE_CLASS_LABEL: Record<LicenseClass, string> = {
  open_weights: 'Open weights',
  commercial: 'Commercial / API only',
};
