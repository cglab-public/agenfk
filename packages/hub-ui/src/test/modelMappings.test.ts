import { describe, it, expect } from 'vitest';
import {
  groupModels, validateMapping, knownCanonicalNames,
  MappingRow, ObservedModel,
} from '../pages/modelMappings';

const m = (aliasModel: string, canonicalModel: string, over: Partial<MappingRow> = {}): MappingRow => ({
  aliasModel, canonicalModel,
  createdByUserId: 'u1', createdByEmail: 'admin@acme.com',
  createdAt: '2026-09-01T10:00:00Z', ...over,
});

const o = (model: string, prs: number, canonicalModel = model): ObservedModel => ({
  model, prs, canonicalModel, isMapped: model !== canonicalModel,
});

describe('groupModels', () => {
  it('folds aliases into the desired name and sums their PRs', () => {
    const groups = groupModels(
      [m('qwen38-27b', 'qwen3.8:27b')],
      [o('qwen3.8:27b', 1), o('qwen38-27b', 2, 'qwen3.8:27b'), o('glm-5.2', 40)],
    );
    const qwen = groups.find(g => g.canonicalModel === 'qwen3.8:27b')!;
    expect(qwen.prs).toBe(3);
    expect(qwen.aliases.map(a => a.model)).toEqual(['qwen38-27b', 'qwen3.8:27b']);
    expect(qwen.canonicalSeen).toBe(true);
    // unmapped models are their own group, untouched
    expect(groups.find(g => g.canonicalModel === 'glm-5.2')!.prs).toBe(40);
  });

  it('orders by PR count so the busiest models are top of the table', () => {
    const groups = groupModels([], [o('small', 1), o('big', 100), o('mid', 10)]);
    expect(groups.map(g => g.canonicalModel)).toEqual(['big', 'mid', 'small']);
  });

  it('orders aliases within a group by PR count', () => {
    const groups = groupModels(
      [m('a-alias', 'q')],
      [o('q', 5), o('a-alias', 1, 'q')],
    );
    expect(groups[0].aliases.map(a => a.model)).toEqual(['q', 'a-alias']);
  });

  it('shows a mapping whose alias has never been reported, as waiting rather than missing', () => {
    const groups = groupModels([m('future-model', 'qwen3.8:27b')], [o('qwen3.8:27b', 3)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].unusedMappings.map(x => x.aliasModel)).toEqual(['future-model']);
    expect(groups[0].prs).toBe(3);
  });

  it('creates a group for a desired name that has never been reported at all', () => {
    const groups = groupModels([m('qwen38-27b', 'brand-new-name')], [o('qwen38-27b', 7, 'brand-new-name')]);
    expect(groups[0]).toMatchObject({ canonicalModel: 'brand-new-name', prs: 7, canonicalSeen: false });
  });

  it('handles no data at all', () => {
    expect(groupModels([], [])).toEqual([]);
  });

  it('attributes the group to whoever created its first mapping', () => {
    const groups = groupModels(
      [m('a', 'q', { createdByEmail: 'first@acme.com' }), m('b', 'q', { createdByEmail: 'second@acme.com' })],
      [],
    );
    expect(groups[0].createdBy).toBe('first@acme.com');
  });
});

describe('validateMapping', () => {
  it('accepts a plain new mapping', () => {
    expect(validateMapping('qwen38-27b', 'qwen3.8:27b', [])).toBeNull();
  });

  it('accepts a mapping that already exists identically (the server no-ops it)', () => {
    expect(validateMapping('qwen38-27b', 'qwen3.8:27b', [m('qwen38-27b', 'qwen3.8:27b')])).toBeNull();
  });

  it('rejects blank sides, mentioning which', () => {
    expect(validateMapping('  ', 'qwen3.8:27b', [])).toMatch(/reported today/i);
    expect(validateMapping('qwen38-27b', '  ', [])).toMatch(/want it to appear/i);
  });

  it('rejects mapping a name to itself', () => {
    expect(validateMapping('qwen3.8:27b', 'qwen3.8:27b', [])).toMatch(/same name/i);
  });

  it('compares trimmed values, so trailing space is not treated as a different name', () => {
    expect(validateMapping(' qwen3.8:27b ', 'qwen3.8:27b', [])).toMatch(/same name/i);
  });

  it('rejects an overlong name', () => {
    expect(validateMapping('a'.repeat(201), 'q', [])).toMatch(/200/);
  });

  it('rejects re-pointing an alias that is already mapped elsewhere, naming the current target', () => {
    const err = validateMapping('qwen38-27b', 'other-name', [m('qwen38-27b', 'qwen3.8:27b')])!;
    expect(err).toContain('qwen3.8:27b');
    expect(err).toMatch(/delete that mapping first/i);
  });

  it('rejects a chain and points at the final name', () => {
    const err = validateMapping('qwen-3.8-27b', 'qwen38-27b', [m('qwen38-27b', 'qwen3.8:27b')])!;
    expect(err).toContain('qwen3.8:27b');
    expect(err).toMatch(/final name/i);
  });
});

describe('knownCanonicalNames', () => {
  it('lists distinct desired names for autocomplete', () => {
    expect(knownCanonicalNames([m('a', 'q'), m('b', 'q'), m('c', 'g')])).toEqual(['g', 'q']);
  });

  it('is empty when nothing is mapped', () => {
    expect(knownCanonicalNames([])).toEqual([]);
  });
});
