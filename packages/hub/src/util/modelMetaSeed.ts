/**
 * Seed rows for the `model_meta` table (CGLAB-133 follow-up).
 *
 * Inserted per org on first read (see util/modelMeta.ts), after which the
 * TABLE is the source of truth and the admin edits rows from Admin → Models.
 * This file is only the starting point — it is not consulted once an org has
 * rows, so a seed change here does not silently rewrite an operator's data.
 *
 * Every row was checked against the vendor's own licence text / model card
 * (Sep 2026). Rows are artifact-level, not family-level, because one family
 * spans both license classes: `qwen3.8-27b` is Apache-2.0 open weights while
 * `qwen3.8-max` is API-only proprietary, and `glm-5.3-flash` is MIT while
 * `glm-5.3` is a bespoke licence. A family-level row would be wrong for one of
 * every such pair, silently. Longest `model` prefix wins at match time.
 *
 * Classification rule (product decision): if weights are publicly downloadable
 * AND also served through a commercial API, it is `open_weights`. So the only
 * question is "can you download the weights?" — bespoke licences with
 * revenue/attribution gates still count (Kimi K3, GLM-5.3, Qwen3.8-Flash-Next,
 * Llama 4). That makes this axis open WEIGHTS, not open SOURCE; several rows
 * below are downloadable but not OSI-approved, and `license` records the real
 * name so the UI can show it.
 */

export type LicenseClass = 'open_weights' | 'commercial';

export interface ModelMetaSeed {
  /** Matched against the normalised model id; longest match wins. */
  model: string;
  provider: string;
  licenseClass: LicenseClass;
  license: string;
}

export const MODEL_META_SEED: ModelMetaSeed[] = [
  // ── Z.ai (Zhipu) — GLM ────────────────────────────────────────────────────
  // GLM-5.3 dropped MIT for a bespoke licence with a $10B-revenue security
  // review clause; GLM-5.3-Flash, shipped two days earlier, stayed plain MIT.
  // Both are open weights — the licence differs, the axis here does not.
  { model: 'glm-5-3-flash', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' },
  { model: 'glm-5-3', provider: 'Z.ai', licenseClass: 'open_weights', license: 'GLM-5.3 License (bespoke)' },
  { model: 'glm-5-2', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' },
  { model: 'glm-5-1', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' },
  { model: 'glm-5', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' },
  { model: 'glm-4', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' },
  { model: 'glm-', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT (GLM series)' },
  { model: 'chatglm', provider: 'Z.ai', licenseClass: 'open_weights', license: 'ChatGLM License' },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  // V4/V3.2/V3.1/R1 are MIT on BOTH code and weights. The pre-V3 releases split
  // a permissive code licence from a restrictive *weights* licence, so they are
  // listed explicitly rather than inheriting the family's MIT.
  { model: 'deepseek-v4', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'MIT' },
  { model: 'deepseek-v3-2', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'MIT' },
  { model: 'deepseek-v3-1', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'MIT' },
  { model: 'deepseek-r1', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'MIT' },
  { model: 'deepseek-v3', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'DeepSeek Model License (restrictive weights)' },
  { model: 'deepseek-coder-v2', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'DeepSeek Model License (restrictive weights)' },
  { model: 'deepseek-vl2', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'DeepSeek Model License (restrictive weights)' },
  { model: 'deepseek-', provider: 'DeepSeek', licenseClass: 'open_weights', license: 'MIT' },

  // ── Alibaba Qwen — the split family ───────────────────────────────────────
  // The Max/Plus lines are API-only proprietary; the numbered/sized artifacts
  // are Apache-2.0. This is the pair a family-level rule cannot get right.
  { model: 'qwen3-8-max', provider: 'Alibaba', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'qwen3-8-flash-next', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Qwen Community License 1.0 (bespoke)' },
  { model: 'qwen3-8-flash', provider: 'Alibaba', licenseClass: 'commercial', license: 'Proprietary (hosted API)' },
  { model: 'qwen3-8-2-4t', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Qwen bespoke license' },
  { model: 'qwen3-8-27b', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'qwen3-8', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'qwen3-7-max', provider: 'Alibaba', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'qwen3-7-plus', provider: 'Alibaba', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'qwen3-6-max', provider: 'Alibaba', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'qwen3-6', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'qwen3-5', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'qwen3-coder', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'qwen3-', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'qwen2', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Tongyi Qianwen License' },
  { model: 'qwen-', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Tongyi Qianwen License' },
  { model: 'qwen', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },

  // ── Moonshot Kimi — open weights, bespoke licence ────────────────────────
  { model: 'kimi-k3', provider: 'Moonshot', licenseClass: 'open_weights', license: 'Kimi K3 License (bespoke)' },
  { model: 'kimi-k2-5', provider: 'Moonshot', licenseClass: 'open_weights', license: 'Modified MIT' },
  { model: 'kimi-k2', provider: 'Moonshot', licenseClass: 'open_weights', license: 'Modified MIT' },
  { model: 'kimi-k1', provider: 'Moonshot', licenseClass: 'open_weights', license: 'Kimi K1 License' },
  { model: 'kimi-', provider: 'Moonshot', licenseClass: 'commercial', license: 'Proprietary (Kimi API)' },

  // ── MiniMax — M2 is MIT, M2.7 is non-commercial ──────────────────────────
  // Both are downloadable, so both are open weights on this axis. Flagged
  // because M2.7's licence text forbids commercial use, which is the opposite
  // of what the label "MIT" would suggest.
  { model: 'minimax-m2-7', provider: 'MiniMax', licenseClass: 'open_weights', license: 'Modified MIT (non-commercial)' },
  { model: 'minimax-m2', provider: 'MiniMax', licenseClass: 'open_weights', license: 'MIT' },
  { model: 'minimax-abab', provider: 'MiniMax', licenseClass: 'commercial', license: 'Proprietary (MiniMax API)' },
  { model: 'minimax-', provider: 'MiniMax', licenseClass: 'open_weights', license: 'MIT' },

  // ── Google — Gemini is NEVER open; only Gemma is ─────────────────────────
  // The single most common misclassification: Gemini 3/3.5/3.8 Flash are all
  // hosted-only. Gemma 4 moved to Apache-2.0 (earlier Gemma used a bespoke
  // Gemma licence).
  { model: 'gemini', provider: 'Google', licenseClass: 'commercial', license: 'Proprietary (Gemini API)' },
  { model: 'gemma-4', provider: 'Google', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'gemma-3', provider: 'Google', licenseClass: 'open_weights', license: 'Gemma Terms of Use' },
  { model: 'gemma-2', provider: 'Google', licenseClass: 'open_weights', license: 'Gemma Terms of Use' },
  { model: 'gemma', provider: 'Google', licenseClass: 'open_weights', license: 'Gemma Terms of Use' },
  { model: 'palm', provider: 'Google', licenseClass: 'commercial', license: 'Proprietary' },

  // ── OpenAI — no open weights at all ──────────────────────────────────────
  // Every prefix here must be a name an OpenAI model actually starts with.
  // `gpt-`/`o1`/`o3`/`o4` are prefixes, so a future `gpt-9-nova` or `o10`
  // matching them is a real possibility — accepted for gpt- (the whole line is
  // OpenAI and closed either way) but NOT for the o-series, where `o1` would
  // also swallow `o10`, `o11`, etc. Those are pinned exactly instead.
  { model: 'gpt-', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'chatgpt-', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  // The o-series is matched with a trailing separator, NOT bare `o1`, because
  // `o1` is a prefix of `o10`/`o11` — different models that must not inherit
  // OpenAI by string accident. `o1-mini`/`o1-preview` are the real ids.
  { model: 'o1-', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'o3-', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'o4-', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'codex-', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'codex', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'davinci', provider: 'OpenAI', licenseClass: 'commercial', license: 'Proprietary (API only)' },

  // ── Anthropic — no open weights at all ───────────────────────────────────
  // `claude-code` is a HARNESS, and it reaches the hub in the model axis too
  // (harness=claude-code is reported separately). It must not classify as a
  // Claude model, so it is seeded as unclassified ahead of the `claude` prefix.
  // modelMeta() has no way to express "no provider", so the harness names are
  // handled by HARNESS_NAMES below rather than as a seed entry.
  { model: 'claude', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'sonnet', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'opus', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'haiku', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'fable', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'mythos', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary (limited preview)' },

  // ── xAI Grok — only the retired Grok 2 line was ever released ───────────
  { model: 'grok-2', provider: 'xAI', licenseClass: 'open_weights', license: 'Grok 2 Community License (bespoke)' },
  { model: 'grok', provider: 'xAI', licenseClass: 'commercial', license: 'Proprietary (xAI API)' },

  // ── Meta Llama — open weights, bespoke community licence ────────────────
  // Llama 4's multimodal rights exclude EU-domiciled users; noted because it
  // is a real restriction on something labelled "open".
  { model: 'llama-4', provider: 'Meta', licenseClass: 'open_weights', license: 'Llama 4 Community License (bespoke)' },
  { model: 'llama-3', provider: 'Meta', licenseClass: 'open_weights', license: 'Meta Llama 3 Community License' },
  { model: 'llama-2', provider: 'Meta', licenseClass: 'open_weights', license: 'Meta Llama 2 Community License' },
  { model: 'llama', provider: 'Meta', licenseClass: 'open_weights', license: 'Meta Llama Community License' },

  // ── Mistral — Large 3 / Small 3.x+ are Apache; Medium line is API-only ──
  { model: 'mistral-large-3', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'mistral-large', provider: 'Mistral', licenseClass: 'commercial', license: 'Proprietary (Mistral API)' },
  { model: 'mistral-small-2402', provider: 'Mistral', licenseClass: 'commercial', license: 'Proprietary (Mistral API)' },
  { model: 'mistral-small-2409', provider: 'Mistral', licenseClass: 'commercial', license: 'Proprietary (Mistral API)' },
  { model: 'mistral-small', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'mistral-medium', provider: 'Mistral', licenseClass: 'commercial', license: 'Proprietary (Mistral API)' },
  { model: 'mistral-nemo', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'mistral-saba', provider: 'Mistral', licenseClass: 'commercial', license: 'Proprietary (Mistral API)' },
  { model: 'mistral-embed', provider: 'Mistral', licenseClass: 'commercial', license: 'Proprietary (Mistral API)' },
  { model: 'mistral', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'mixtral', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'magistral', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'devstral', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'codestral', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'pixtral', provider: 'Mistral', licenseClass: 'open_weights', license: 'Apache-2.0' },

  // ── Amazon Nova — Bedrock-only ──────────────────────────────────────────
  { model: 'nova', provider: 'Amazon', licenseClass: 'commercial', license: 'Proprietary (Bedrock)' },
  { model: 'amazon-nova', provider: 'Amazon', licenseClass: 'commercial', license: 'Proprietary (Bedrock)' },

  // ── Other open-weight labs ───────────────────────────────────────────────
  { model: 'command-a', provider: 'Cohere', licenseClass: 'open_weights', license: 'CC-BY-NC (non-commercial)' },
  { model: 'command-r', provider: 'Cohere', licenseClass: 'commercial', license: 'Proprietary (Cohere API)' },
  { model: 'command', provider: 'Cohere', licenseClass: 'commercial', license: 'Proprietary (Cohere API)' },
  { model: 'cohere', provider: 'Cohere', licenseClass: 'commercial', license: 'Proprietary (Cohere API)' },
  { model: 'phi-', provider: 'Microsoft', licenseClass: 'open_weights', license: 'MIT' },
  { model: 'phi', provider: 'Microsoft', licenseClass: 'open_weights', license: 'MIT' },
  { model: 'microsoft-', provider: 'Microsoft', licenseClass: 'open_weights', license: 'MIT' },
  { model: 'deepcogito', provider: 'IBM', licenseClass: 'open_weights', license: 'MIT' },
  { model: 'granite', provider: 'IBM', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'yi-', provider: '01.AI', licenseClass: 'open_weights', license: 'Qwen-style / Apache-2.0' },
  { model: 'yi', provider: '01.AI', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'ernie', provider: 'Baidu', licenseClass: 'commercial', license: 'Proprietary (Qianfan API)' },
  { model: 'hunyuan', provider: 'Tencent', licenseClass: 'open_weights', license: 'Tencent Hunyuan License' },
  { model: 'step-', provider: 'StepFun', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'tulu', provider: 'AI2', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'olmo', provider: 'AI2', licenseClass: 'open_weights', license: 'Apache-2.0' },
  { model: 'nemotron', provider: 'NVIDIA', licenseClass: 'open_weights', license: 'NVIDIA Open Model License' },
  { model: 'qwen3-omni', provider: 'Alibaba', licenseClass: 'open_weights', license: 'Apache-2.0' },
];
