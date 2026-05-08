import { describe, it, expect } from 'vitest';
import { readPersistedSet, writePersistedSet } from '../hooks/useToggleSet';

function makeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
  };
}

describe('readPersistedSet', () => {
  it('returns fallback when the key is absent', () => {
    const s = readPersistedSet(makeStorage(), 'k', ['item.closed']);
    expect([...s].sort()).toEqual(['item.closed']);
  });

  it('returns the parsed JSON array as a Set', () => {
    const s = readPersistedSet(makeStorage({ k: '["a","b","c"]' }), 'k', ['fallback']);
    expect([...s].sort()).toEqual(['a', 'b', 'c']);
  });

  it('round-trips an explicitly-stored empty array as an empty Set (NOT the fallback)', () => {
    // This is the whole point of persistence — "Clear" must stick across refresh.
    const s = readPersistedSet(makeStorage({ k: '[]' }), 'k', ['item.closed']);
    expect(s.size).toBe(0);
  });

  it('returns the fallback when the stored value is malformed JSON', () => {
    const s = readPersistedSet(makeStorage({ k: 'not-json' }), 'k', ['fallback']);
    expect([...s]).toEqual(['fallback']);
  });

  it('returns the fallback when the stored value is JSON but not an array', () => {
    const s = readPersistedSet(makeStorage({ k: '{"foo":1}' }), 'k', ['fallback']);
    expect([...s]).toEqual(['fallback']);
  });

  it('drops non-string members of the stored array', () => {
    const s = readPersistedSet(makeStorage({ k: '["ok",1,null,"also-ok"]' }), 'k', []);
    expect([...s].sort()).toEqual(['also-ok', 'ok']);
  });

  it('returns a Set built from fallback when storage is null (SSR/no-window)', () => {
    const s = readPersistedSet(null, 'k', ['item.closed']);
    expect([...s]).toEqual(['item.closed']);
  });
});

describe('writePersistedSet', () => {
  it('writes the set as a JSON array', () => {
    const storage = makeStorage();
    writePersistedSet(storage, 'k', new Set(['a', 'b']));
    const written = storage.data.k;
    expect(JSON.parse(written).sort()).toEqual(['a', 'b']);
  });

  it('writes an empty array for an empty set so reads return empty (preserves Clear)', () => {
    const storage = makeStorage({ k: '["preexisting"]' });
    writePersistedSet(storage, 'k', new Set());
    expect(storage.data.k).toBe('[]');
    // And reading it back stays empty, not falling back to ['default'].
    const s = readPersistedSet(storage, 'k', ['default']);
    expect(s.size).toBe(0);
  });

  it('is a no-op when storage is null', () => {
    expect(() => writePersistedSet(null, 'k', new Set(['a']))).not.toThrow();
  });
});
