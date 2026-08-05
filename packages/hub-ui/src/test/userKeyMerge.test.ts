import { describe, it, expect } from 'vitest';
import {
  MAX_MERGE_SOURCES,
  normalizeUserKey,
  deriveMergeSources,
  validateMerge,
  mergeSourceCandidates,
  mergeConfirmMessage,
  formatMergeResult,
} from '../pages/userKeyMerge';

describe('normalizeUserKey', () => {
  it('trims and lowercases, matching the server', () => {
    expect(normalizeUserKey('  Jonatan.Sporn@CGLab.com ')).toBe('jonatan.sporn@cglab.com');
    expect(normalizeUserKey('JonatanSporn')).toBe('jonatansporn');
  });

  it('maps non-strings to empty', () => {
    expect(normalizeUserKey(undefined)).toBe('');
    expect(normalizeUserKey(null)).toBe('');
    expect(normalizeUserKey(42)).toBe('');
  });

  it('preserves the literal = key a broken git config produces', () => {
    expect(normalizeUserKey('=')).toBe('=');
  });
});

describe('deriveMergeSources', () => {
  it('normalizes, dedupes and drops the target', () => {
    expect(deriveMergeSources(['=', 'JonatanSporn', 'jonatansporn', 'real@x'], 'real@x'))
      .toEqual(['=', 'jonatansporn']);
  });

  it('drops blanks', () => {
    expect(deriveMergeSources(['', '   ', '='], 'real@x')).toEqual(['=']);
  });

  it('returns empty when only the target was selected', () => {
    expect(deriveMergeSources(['Real@X'], 'real@x')).toEqual([]);
  });
});

describe('validateMerge', () => {
  it('requires a target first', () => {
    expect(validateMerge(['='], '')).toMatch(/identity to keep/);
    expect(validateMerge(['='], '   ')).toMatch(/identity to keep/);
  });

  it('requires at least one source that differs from the target', () => {
    expect(validateMerge([], 'real@x')).toMatch(/at least one/);
    expect(validateMerge(['real@x'], 'real@x')).toMatch(/at least one/);
  });

  it('enforces the same cap as the server', () => {
    const many = Array.from({ length: MAX_MERGE_SOURCES + 1 }, (_, i) => `k${i}@x`);
    expect(validateMerge(many, 'real@x')).toMatch(/at most 50/);
    const atCap = Array.from({ length: MAX_MERGE_SOURCES }, (_, i) => `k${i}@x`);
    expect(validateMerge(atCap, 'real@x')).toBeNull();
  });

  it('passes a valid selection', () => {
    expect(validateMerge(['=', 'jonatansporn'], 'jonatan.sporn@cglab.com')).toBeNull();
  });
});

describe('mergeSourceCandidates', () => {
  it('excludes the target case-insensitively', () => {
    const rows = [{ user_key: '=' }, { user_key: 'Real@X' }, { user_key: 'jonatansporn' }];
    expect(mergeSourceCandidates(rows, 'real@x').map(r => r.user_key)).toEqual(['=', 'jonatansporn']);
  });

  it('returns every row when no target is chosen', () => {
    const rows = [{ user_key: '=' }, { user_key: 'a@x' }];
    expect(mergeSourceCandidates(rows, '')).toHaveLength(2);
  });
});

describe('mergeConfirmMessage', () => {
  it('singularises one source and warns it is irreversible', () => {
    const m = mergeConfirmMessage(['='], 'real@x');
    expect(m).toContain('Merge 1 identity into real@x?');
    expect(m).toContain('cannot be undone');
  });

  it('pluralises several sources', () => {
    expect(mergeConfirmMessage(['=', 'jonatansporn'], 'real@x')).toContain('Merge 2 identities');
  });
});

describe('formatMergeResult', () => {
  it('summarises what moved', () => {
    const s = formatMergeResult('Real@X', { events: 3, rollupsRemoved: 1, installations: 1, hiddenRemoved: 1 });
    expect(s).toContain('3 events now credited to real@x');
    expect(s).toContain('1 daily rollup row(s) folded in');
    expect(s).toContain('1 installation(s) relabelled');
    expect(s).toContain('1 stale hide(s) cleared');
  });

  it('singularises a single event', () => {
    expect(formatMergeResult('a@x', { events: 1 })).toContain('1 event now credited');
  });

  it('reports an already-merged no-op plainly rather than as a failure', () => {
    const s = formatMergeResult('a@x', { events: 0, rollupsRemoved: 0 });
    expect(s).toMatch(/already merged into a@x/);
    expect(s).not.toMatch(/error|fail/i);
  });

  it('omits zero-valued companion counts', () => {
    const s = formatMergeResult('a@x', { events: 2, rollupsRemoved: 0, installations: 0, hiddenRemoved: 0 });
    expect(s).toBe('2 events now credited to a@x.');
  });
});
