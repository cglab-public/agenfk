/**
 * modelMeta — provider + open-weights/commercial classification (CGLAB-133).
 *
 * The tests that matter here are the ones pinning the TRAPS: the same family
 * spanning both license classes (qwen3.8-27b vs qwen3.8-max), the same version
 * spanning two licences (glm-5.3 vs glm-5.3-flash), a harness string that looks
 * like a model (claude-code), and router prefixes. Those are exactly the cases a
 * family-level prefix rule gets wrong, so they are pinned individually.
 */
import { describe, it, expect } from 'vitest';
import {
  modelMeta,
  normaliseModelId,
  providersFor,
  licenseClassesFor,
  modelsMatching,
  resolveMetaSelection,
  LICENSE_CLASS_LABEL,
  UNCLASSIFIED,
} from '../modelMeta';

describe('modelMeta — the split-family traps', () => {
  it('classifies open and API-only artifacts of ONE family differently', () => {
    // Same "qwen3.8" name, opposite license class. A family-level rule cannot
    // express this, which is why the seed is artifact-level.
    expect(modelMeta('qwen3.8-27b').licenseClass).toBe('open_weights');
    expect(modelMeta('qwen3.8-max').licenseClass).toBe('commercial');
    expect(modelMeta('qwen3.8-flash').licenseClass).toBe('commercial');
    // ...and Flash-Next is the downloadable artifact of the hosted Flash line.
    expect(modelMeta('qwen3.8-flash-next').licenseClass).toBe('open_weights');
  });

  it('keeps every qwen artifact attributed to the same provider despite the split', () => {
    expect(modelMeta('qwen3.8-27b').provider).toBe('Alibaba');
    expect(modelMeta('qwen3.8-max').provider).toBe('Alibaba');
  });

  it('distinguishes glm-5.3 (bespoke) from glm-5.3-flash (MIT) by longest prefix', () => {
    expect(modelMeta('glm-5.3').license).toContain('bespoke');
    expect(modelMeta('glm-5.3-flash').license).toBe('MIT');
    // Both are open weights — the licence differs, this axis does not.
    expect(modelMeta('glm-5.3').licenseClass).toBe('open_weights');
    expect(modelMeta('glm-5.3-flash').licenseClass).toBe('open_weights');
  });

  it('distinguishes mistral-large-3 (Apache) from the API-only mistral-large line', () => {
    expect(modelMeta('mistral-large-3').licenseClass).toBe('open_weights');
    expect(modelMeta('mistral-large-2407').licenseClass).toBe('commercial');
  });

  it('distinguishes the two mistral-small generations', () => {
    expect(modelMeta('mistral-small-2402').licenseClass).toBe('commercial');
    expect(modelMeta('mistral-small-3.2').licenseClass).toBe('open_weights');
  });

  it('never calls Gemini open, and always calls Gemma open', () => {
    // The most common real-world misclassification: Gemini Flash sounds like it
    // could be the open line. It is not; only Gemma is.
    for (const g of ['gemini-3', 'gemini-3-flash', 'gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview']) {
      expect(modelMeta(g).licenseClass).toBe('commercial');
      expect(modelMeta(g).provider).toBe('Google');
    }
    for (const g of ['gemma-4', 'gemma-3-27b', 'gemma-2-9b']) {
      expect(modelMeta(g).licenseClass).toBe('open_weights');
      expect(modelMeta(g).provider).toBe('Google');
    }
  });

  it('splits Grok: only the retired Grok 2 line had weights', () => {
    expect(modelMeta('grok-2').licenseClass).toBe('open_weights');
    expect(modelMeta('grok-2.5').licenseClass).toBe('open_weights');
    expect(modelMeta('grok-4').licenseClass).toBe('commercial');
    expect(modelMeta('grok-4.6').licenseClass).toBe('commercial');
  });

  it('splits DeepSeek: V4 is MIT, the pre-V3 line had a restrictive weights licence', () => {
    expect(modelMeta('deepseek-v4-pro').license).toBe('MIT');
    expect(modelMeta('deepseek-v3').license).toContain('restrictive weights');
    expect(modelMeta('deepseek-r1').license).toBe('MIT');
  });
});

describe('modelMeta — the tie-break rule', () => {
  it('counts bespoke/restricted licences as open weights when weights download', () => {
    // Product decision: "are the weights downloadable?" is the only question.
    // These are downloadable but NOT OSI-open, so the UI label is "Open
    // weights", not "Open source".
    const bespoke = ['kimi-k3', 'glm-5.3', 'qwen3.8-flash-next', 'llama-4-scout', 'grok-2'];
    for (const m of bespoke) expect(modelMeta(m).licenseClass).toBe('open_weights');
  });

  it('records the bespoke licence name so the tooltip can show it', () => {
    expect(modelMeta('kimi-k3').license).toContain('bespoke');
    expect(modelMeta('llama-4-maverick').license).toContain('bespoke');
  });

  it('labels the axis "Open weights" rather than "Open source"', () => {
    expect(LICENSE_CLASS_LABEL.open_weights).toBe('Open weights');
    expect(LICENSE_CLASS_LABEL.commercial).toBe('Commercial / API only');
  });
});

describe('modelMeta — closed labs', () => {
  it('has no open weights for OpenAI or Anthropic', () => {
    for (const m of ['gpt-5.2', 'gpt-5.6', 'gpt-6-astra', 'o3-mini', 'codex-mini', 'chatgpt-4o']) {
      expect(modelMeta(m).licenseClass).toBe('commercial');
      expect(modelMeta(m).provider).toBe('OpenAI');
    }
    for (const m of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-5', 'claude-fable-5']) {
      expect(modelMeta(m).licenseClass).toBe('commercial');
      expect(modelMeta(m).provider).toBe('Anthropic');
    }
  });
});

describe('modelMeta — harness strings are not models', () => {
  it('does not let the harness "claude-code" read as a Claude model', () => {
    // `claude-code` reaches the hub in the model axis (harness=claude-code is
    // ALSO reported separately). It must not be classified as a Claude model.
    expect(modelMeta('claude-code').provider).toBe(UNCLASSIFIED);
  });

  it('still classifies a real claude model that happens to mention code', () => {
    expect(modelMeta('claude-sonnet-4-6').provider).toBe('Anthropic');
  });
});

describe('normaliseModelId', () => {
  it('strips router/provider prefixes so the artifact decides', () => {
    expect(modelMeta('@cf/zai-org/glm-5.2').provider).toBe('Z.ai');
    expect(modelMeta('@cf/zai-org/glm-5.2').licenseClass).toBe('open_weights');
    expect(modelMeta('openrouter/anthropic/claude-opus-4-8').provider).toBe('Anthropic');
    expect(modelMeta('anthropic/claude-opus-4-8').provider).toBe('Anthropic');
    expect(modelMeta('cloudflare-workers-ai/@cf/zai-org/glm-5.2').provider).toBe('Z.ai');
  });

  it('folds the spelling variants one artifact arrives under', () => {
    const variants = ['qwen3.8:27b', 'Qwen38-27b', 'qwen-3.8-27b', 'qwen3_8_27b', 'QWEN3.8-27B'];
    for (const v of variants) {
      expect(modelMeta(v).provider).toBe('Alibaba');
      expect(modelMeta(v).licenseClass).toBe('open_weights');
    }
  });

  it('is empty/null-safe', () => {
    expect(modelMeta('').provider).toBe(UNCLASSIFIED);
    expect(modelMeta(null).provider).toBe(UNCLASSIFIED);
    expect(modelMeta(undefined).provider).toBe(UNCLASSIFIED);
    expect(normaliseModelId('  ')).toBe('');
  });
});

describe('modelMeta — unknown models are visible, never guessed', () => {
  it('returns the unclassified provider for anything not in the seed', () => {
    for (const m of ['totally-new-model-9000', 'my-private-finetune', 'sunset-70b-instruct']) {
      expect(modelMeta(m).provider).toBe(UNCLASSIFIED);
    }
  });

  it('does not invent a provider from a vague o-series prefix', () => {
    // `o1` is seeded, but `o10` is a different model number and must not
    // silently inherit OpenAI. This is why the o-series is pinned to o1/o3/o4
    // with an `oN-` form rather than an open-ended `o` prefix.
    expect(modelMeta('o10-new-reasoner').provider).toBe(UNCLASSIFIED);
    expect(modelMeta('o1-mini').provider).toBe('OpenAI');
  });

  it('accepts that gpt- is an open-ended prefix, deliberately', () => {
    // Unlike the o-series, ANY `gpt-*` is OpenAI and closed regardless of
    // number, so the open-ended prefix is safe and future-proof on purpose.
    expect(modelMeta('gpt-9-turbo-ultra').provider).toBe('OpenAI');
    expect(modelMeta('gpt-9-turbo-ultra').licenseClass).toBe('commercial');
  });
});

describe('providersFor / licenseClassesFor', () => {
  it('lists only providers actually present, alphabetical, unclassified last', () => {
    const p = providersFor(['claude-opus-4-8', 'glm-5.2', 'brand-x-1']);
    expect(p).toEqual(['Anthropic', 'Z.ai', UNCLASSIFIED]);
  });

  it('de-duplicates a provider shared by many models', () => {
    expect(providersFor(['qwen3.8-27b', 'qwen3.8-max', 'qwen3.6-27b'])).toEqual(['Alibaba']);
  });

  it('lists license classes in canonical order and omits absent ones', () => {
    expect(licenseClassesFor(['glm-5.2', 'deepseek-v4-pro'])).toEqual(['open_weights']);
    expect(licenseClassesFor(['claude-opus-4-8', 'glm-5.2'])).toEqual(['open_weights', 'commercial']);
  });
});

describe('modelsMatching', () => {
  const MODELS = ['claude-opus-4-8', 'glm-5.2', 'qwen3.8-max', 'qwen3.8-27b', 'new-thing'];

  it('returns everything when neither axis is selected', () => {
    expect(modelsMatching(MODELS, new Set(), new Set())).toEqual(MODELS);
    expect(modelsMatching(MODELS, new Set(), new Set()).length).toBe(MODELS.length);
  });

  it('OR-combines within the provider axis', () => {
    const r = modelsMatching(MODELS, new Set(['Anthropic', 'Z.ai']), new Set());
    expect(r).toEqual(['claude-opus-4-8', 'glm-5.2']);
  });

  it('OR-combines within the license axis', () => {
    expect(modelsMatching(MODELS, new Set(), new Set(['open_weights'])))
      .toEqual(['glm-5.2', 'qwen3.8-27b']);
  });

  it('AND-combines the two axes', () => {
    // Anthropic has no open weights, so this intersection is honestly empty.
    expect(modelsMatching(MODELS, new Set(['Anthropic']), new Set(['open_weights']))).toEqual([]);
    expect(modelsMatching(MODELS, new Set(['Alibaba']), new Set(['commercial'])))
      .toEqual(['qwen3.8-max']);
  });

  it('lets the unclassified bucket be selected explicitly', () => {
    expect(modelsMatching(MODELS, new Set([UNCLASSIFIED]), new Set())).toEqual(['new-thing']);
  });
});

describe('resolveMetaSelection', () => {
  const MODELS = ['claude-opus-4-8', 'glm-5.2', 'qwen3.8-27b'];

  it('merges explicit picks with meta-derived picks, de-duplicated', () => {
    // Explicit glm-5.2 plus the Z.ai meta-selection (which also resolves to
    // glm-5.2) must yield it exactly once.
    const r = resolveMetaSelection(MODELS, new Set(['glm-5.2']), new Set(['Z.ai']), new Set());
    expect(r).toEqual(['glm-5.2']);
  });

  it('adds every model the meta-selection resolves to', () => {
    const r = resolveMetaSelection(MODELS, new Set(['claude-opus-4-8']), new Set(['Alibaba']), new Set());
    expect(r.sort()).toEqual(['claude-opus-4-8', 'qwen3.8-27b']);
  });

  it('never drops an explicit pick that the meta-filter would exclude', () => {
    // User picked a commercial model, then selected "open weights". Their
    // explicit choice survives — the meta-filter adds, it does not veto.
    const r = resolveMetaSelection(MODELS, new Set(['claude-opus-4-8']), new Set(), new Set(['open_weights']));
    expect(r).toContain('claude-opus-4-8');
    expect(r).toContain('glm-5.2');
    expect(r).toContain('qwen3.8-27b');
  });

  it('is a no-op with no meta selection — it must NOT expand to every model', () => {
    // Regression: modelsMatching treats an empty selection as "unfiltered",
    // so calling it unconditionally here returned ALL models for a user who
    // selected nothing.
    expect(resolveMetaSelection(MODELS, new Set(['glm-5.2']), new Set(), new Set())).toEqual(['glm-5.2']);
    expect(resolveMetaSelection(MODELS, new Set(), new Set(), new Set())).toEqual([]);
  });

  it('returns nothing for an empty everything', () => {
    expect(resolveMetaSelection([], new Set(), new Set(), new Set())).toEqual([]);
  });
});
