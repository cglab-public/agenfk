import { describe, it, expect } from 'vitest';
import {
  resolveModelId,
  resolveModelFilter,
  loadModelMappings,
  EMPTY_MODEL_MAPPING,
} from '../util/modelMapping';

const map = new Map([
  ['qwen38-27b', 'qwen3.8:27b'],
  ['qwen-3.8-27b', 'qwen3.8:27b'],
]);

describe('resolveModelId', () => {
  it('maps a listed alias to the canonical name', () => {
    expect(resolveModelId('qwen38-27b', map)).toBe('qwen3.8:27b');
    expect(resolveModelId('qwen-3.8-27b', map)).toBe('qwen3.8:27b');
  });

  it('leaves an unmapped id untouched — it is its own group', () => {
    expect(resolveModelId('glm-5.2', map)).toBe('glm-5.2');
  });

  it('is exact, not fuzzy: a near-miss does NOT fold in', () => {
    // The whole point of option A. A normalization rule would merge these and
    // the admin could not see why.
    expect(resolveModelId('qwen3.8:14b', map)).toBe('qwen3.8:14b');
    expect(resolveModelId('qwen38-7b', map)).toBe('qwen38-7b');
    expect(resolveModelId('Qwen38-27b', map)).toBe('Qwen38-27b'); // case is part of the id
    expect(resolveModelId('qwen38-27b ', map)).toBe('qwen38-27b '); // and so is whitespace
  });

  it('passes null/empty through so the row still renders', () => {
    expect(resolveModelId(null, map)).toBeNull();
    expect(resolveModelId('', map)).toBe('');
  });

  it('is identity with no mappings configured', () => {
    expect(resolveModelId('qwen38-27b', EMPTY_MODEL_MAPPING)).toBe('qwen38-27b');
  });
});

describe('resolveModelFilter', () => {
  it('resolves filter values so saved links to an alias still match', () => {
    expect(resolveModelFilter(['qwen38-27b'], map)).toEqual(['qwen3.8:27b']);
  });

  it('collapses aliases that resolve to the same canonical name', () => {
    expect(resolveModelFilter(['qwen38-27b', 'qwen-3.8-27b'], map)).toEqual(['qwen3.8:27b']);
  });

  it('keeps unmapped values so filtering by an unmapped model still works', () => {
    expect(resolveModelFilter(['qwen38-27b', 'glm-5.2'], map))
      .toEqual(['qwen3.8:27b', 'glm-5.2']);
  });

  it('passes empty/null through unchanged (no filter)', () => {
    expect(resolveModelFilter(null, map)).toBeNull();
    expect(resolveModelFilter([], map)).toEqual([]);
  });
});

describe('loadModelMappings', () => {
  it('reads an org\'s rows into a lookup map', async () => {
    const calls: any[] = [];
    const db = {
      all: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return [{ alias_model: 'qwen38-27b', canonical_model: 'qwen3.8:27b' }];
      },
    };
    const m = await loadModelMappings(db, 'org-a');
    expect(m.get('qwen38-27b')).toBe('qwen3.8:27b');
    // org-scoped: a mapping from another org must never leak in.
    expect(calls[0].params).toEqual(['org-a']);
  });

  it('returns the empty map when nothing is configured', async () => {
    const m = await loadModelMappings({ all: async () => [] }, 'org-a');
    expect(m.size).toBe(0);
  });
});
