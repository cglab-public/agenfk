/**
 * adminModelsUnified — the merge rules behind the single Models table.
 *
 * The properties worth defending are the ones a naive implementation gets
 * wrong: prefix matching must pick the LONGEST rule, an unclassified model must
 * stay unknown rather than inherit a vendor by string similarity, and saving an
 * inherited family rule is a real change (it narrows the rule), not a no-op.
 */
import { describe, it, expect } from 'vitest';
import {
  buildUnifiedRows, matchMeta, normalizeKey, editorInitial, isDirty,
  UNKNOWN_LABEL, UNCLASSIFIED,
} from '../pages/adminModelsUnified';
import type { ModelMetaRow } from '../pages/adminModelMeta';
import type { ModelGroup } from '../pages/modelMappings';

const meta = (
  model: string,
  provider = 'Acme',
  licenseClass: 'open_weights' | 'commercial' = 'open_weights',
  license = 'MIT',
  source: 'seed' | 'admin' = 'seed',
): ModelMetaRow => ({ model, provider, licenseClass, license, source });

const group = (canonicalModel: string, prs = 1, aliasNames: string[] = []): ModelGroup => ({
  canonicalModel,
  prs,
  aliases: [
    { model: canonicalModel, prs, canonicalModel, isMapped: false },
    ...aliasNames.map(a => ({ model: a, prs: 0, canonicalModel, isMapped: true })),
  ],
  canonicalSeen: true,
  unusedMappings: [],
  createdBy: null,
});

describe('normalizeKey', () => {
  it('strips router prefixes and folds separators', () => {
    expect(normalizeKey('@cf/zai-org/glm-5.2')).toBe('glm-5-2');
    expect(normalizeKey('openrouter/anthropic/claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeKey('qwen_3_8_27b')).toBe('qwen-3-8-27b');
  });

  it('leaves a colon alone, matching the server exactly', () => {
    // Deliberate parity with the hub's normaliseModelId: `:` is NOT folded, so
    // an Ollama-style id normalises to "qwen3-8:27b". It still classifies — but
    // via the shorter `qwen3-8` family rule rather than the specific
    // `qwen3.8-27b` row. Both resolve to Apache-2.0, so the answer is right;
    // the specificity loss is only visible where a family and its artifact
    // disagree. Pinned here so the two implementations cannot drift.
    expect(normalizeKey('Qwen3.8:27b')).toBe('qwen3-8:27b');
  });

  it('is empty-safe', () => {
    expect(normalizeKey('   ')).toBe('');
  });
});

describe('matchMeta', () => {
  const rows = [meta('glm-', 'Z.ai'), meta('glm-5.2', 'Z.ai Exact'), meta('claude', 'Anthropic')];

  it('prefers the LONGEST matching rule', () => {
    expect(matchMeta('glm-5.2', rows)?.row.provider).toBe('Z.ai Exact');
    expect(matchMeta('glm-9.9', rows)?.row.provider).toBe('Z.ai');
  });

  it('reports whether the match was exact or inherited by prefix', () => {
    expect(matchMeta('glm-5.2', rows)?.exact).toBe(true);
    const inherited = matchMeta('glm-7.1', rows);
    expect(inherited?.exact).toBe(false);
    expect(inherited?.row.model).toBe('glm-');
  });

  it('matches a router-prefixed id by its artifact', () => {
    expect(matchMeta('@cf/zai-org/glm-5.2', rows)?.row.provider).toBe('Z.ai Exact');
  });

  it('returns null for an unclassified model rather than guessing', () => {
    expect(matchMeta('totally-new-9000', rows)).toBeNull();
    expect(matchMeta('', rows)).toBeNull();
  });

  it('returns null when there are no rules at all', () => {
    expect(matchMeta('glm-5.2', [])).toBeNull();
  });
});

describe('buildUnifiedRows', () => {
  const groups = [group('glm-5.2', 12, ['glm52']), group('claude-opus-4-8', 40), group('mystery-model', 3)];
  const rows = [meta('glm-', 'Z.ai'), meta('claude', 'Anthropic', 'commercial', 'Proprietary (API only)')];

  it('merges alias counts onto the same row as the classification', () => {
    const out = buildUnifiedRows(groups, rows);
    const glm = out.find(r => r.canonicalModel === 'glm-5.2');
    expect(glm?.prs).toBe(12);
    expect(glm?.aliasCount).toBe(1);
    expect(glm?.meta?.provider).toBe('Z.ai');
  });

  it('marks a newly arrived model unknown, with no licence', () => {
    const m = buildUnifiedRows(groups, rows).find(r => r.canonicalModel === 'mystery-model');
    expect(m?.unknown).toBe(true);
    expect(m?.meta).toBeNull();
    expect(m?.provider ?? (m as any).licenseClass).toBeUndefined();
  });

  it('sorts unknown models first so they are not buried among seeded rules', () => {
    const out = buildUnifiedRows(groups, rows);
    expect(out[0].canonicalModel).toBe('mystery-model');
  });

  it('orders the rest by admin-edited, then traffic', () => {
    const withAdmin = [...rows, meta('claude-opus-4-8', 'Anthropic', 'commercial', 'X', 'admin')];
    const out = buildUnifiedRows(groups, withAdmin);
    expect(out.map(r => r.canonicalModel)).toEqual([
      'mystery-model', 'claude-opus-4-8', 'glm-5.2',
    ]);
  });

  it('counts how many observed models a family rule covers', () => {
    const many = [group('glm-5.2', 5), group('glm-4.6', 2), group('glm-5.3', 1)];
    const out = buildUnifiedRows(many, [meta('glm-', 'Z.ai')]);
    for (const r of out) expect(r.familyCovers).toBe(3);
  });

  it('does not report familyCovers for an exact per-model rule', () => {
    const out = buildUnifiedRows([group('glm-5.2')], [meta('glm-5.2', 'Z.ai')]);
    expect(out[0].familyCovers).toBeUndefined();
  });

  describe('scope', () => {
    const seeded = [meta('glm-'), meta('kimi-'), meta('llama-')];
    const observedOnly = [group('glm-5.2', 3)];

    it('observed scope hides seeded rules that matched nothing', () => {
      const out = buildUnifiedRows(observedOnly, seeded, 'observed');
      expect(out.map(r => r.canonicalModel)).toEqual(['glm-5.2']);
    });

    it('all scope surfaces seeded rules that matched nothing', () => {
      // `glm-` is excluded: it already matched the glm-5.2 group, so it is
      // represented by that row rather than duplicated as a bare rule.
      const out = buildUnifiedRows(observedOnly, seeded, 'all');
      expect(out.map(r => r.canonicalModel).sort()).toEqual(['glm-5.2', 'kimi-', 'llama-']);
    });

    it('all scope does not duplicate a rule that already matched a group', () => {
      const out = buildUnifiedRows(observedOnly, [meta('glm-5.2', 'Z.ai')], 'all');
      expect(out.filter(r => r.canonicalModel === 'glm-5.2')).toHaveLength(1);
    });

    it('defaults to observed', () => {
      expect(buildUnifiedRows(observedOnly, seeded).map(r => r.canonicalModel)).toEqual(['glm-5.2']);
    });
  });

  it('is empty-safe', () => {
    expect(buildUnifiedRows([], [])).toEqual([]);
  });
});

describe('editorInitial', () => {
  it('prefills from an applied rule', () => {
    const row = buildUnifiedRows([group('glm-5.2')], [meta('glm-', 'Z.ai', 'open_weights', 'MIT')])[0];
    expect(editorInitial(row)).toEqual({ provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' });
  });

  it('prefills blank for an unknown model', () => {
    const row = buildUnifiedRows([group('mystery')], [])[0];
    expect(editorInitial(row)).toEqual({ provider: '', licenseClass: '', license: '' });
  });
});

describe('isDirty', () => {
  const row = buildUnifiedRows([group('glm-5.2')], [meta('glm-', 'Z.ai', 'open_weights', 'MIT')])[0];
  const clean = { provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' };

  it('is false when nothing changed', () => {
    expect(isDirty(row, clean)).toBe(false);
  });

  it('ignores surrounding whitespace', () => {
    expect(isDirty(row, { ...clean, provider: '  Z.ai ' })).toBe(false);
  });

  it('is true when any field changes', () => {
    expect(isDirty(row, { ...clean, provider: 'Zhipu' })).toBe(true);
    expect(isDirty(row, { ...clean, licenseClass: 'commercial' })).toBe(true);
    expect(isDirty(row, { ...clean, license: 'Apache-2.0' })).toBe(true);
  });

  it('treats saving an untouched INHERITED rule as not dirty', () => {
    // Saving it would narrow the family rule to one model — a real change, so
    // the form must not offer Save for it.
    expect(row.meta?.exact).toBe(false);
    expect(isDirty(row, clean)).toBe(false);
  });

  it('is dirty for an unknown model once anything is typed', () => {
    const unknown = buildUnifiedRows([group('mystery')], [])[0];
    expect(isDirty(unknown, { provider: '', licenseClass: '', license: '' })).toBe(false);
    expect(isDirty(unknown, { provider: 'New', licenseClass: 'open_weights', license: 'MIT' })).toBe(true);
  });
});

describe('labels', () => {
  it('names the unknown state without inventing a licence', () => {
    expect(UNKNOWN_LABEL).toBe('Unknown');
    expect(UNCLASSIFIED).toBe('unclassified');
  });
});
