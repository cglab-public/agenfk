import { describe, it, expect } from 'vitest';
import { resolveItemIdPrefix, AMBIGUOUS_CANDIDATES_SHOWN } from '../resolveItemId';

const items = [
  { id: '2cab541e-d262-4241-a0fa-104b894ffb98' },
  { id: '2cab541f-0000-0000-0000-000000000000' },
  { id: '53ed7163-0b3f-403d-9d81-dfb24c28788c' },
];

describe('resolving an item id prefix', () => {
  it('takes a full id as-is, without asking the list', () => {
    expect(resolveItemIdPrefix([], '2cab541e-d262-4241-a0fa-104b894ffb98'))
      .toEqual({ ok: true, id: '2cab541e-d262-4241-a0fa-104b894ffb98' });
  });

  it('a unique 8-char prefix resolves to the full id', () => {
    // The bug: run list passed the short id to an exact-match route and got [].
    expect(resolveItemIdPrefix(items, '53ed7163'))
      .toEqual({ ok: true, id: '53ed7163-0b3f-403d-9d81-dfb24c28788c' });
  });

  it('refuses an ambiguous prefix instead of guessing', () => {
    expect(resolveItemIdPrefix(items, '2cab541')).toMatchObject({ ok: false });
  });

  it('lists the candidates of an ambiguous prefix, and only them', () => {
    const r = resolveItemIdPrefix([...items.slice(0, 1), { id: items[1].id, title: 'Second twin' }, items[2]], '2cab541');
    if (r.ok) throw new Error('resolved an ambiguous prefix');
    expect(r.error).toContain('Ambiguous ID 2cab541');
    expect(r.error).toContain('2cab541e-d262-4241-a0fa-104b894ffb98');
    expect(r.error).toContain('2cab541f-0000-0000-0000-000000000000  Second twin');
    expect(r.error).not.toContain('53ed7163');
  });

  it('caps the candidate list and says how many it left out', () => {
    const many = Array.from({ length: AMBIGUOUS_CANDIDATES_SHOWN + 3 }, (_, n) => ({ id: `aaaa${String(n).padStart(4, '0')}-0000-0000-0000-000000000000` }));
    const r = resolveItemIdPrefix(many, 'aaaa');
    if (r.ok) throw new Error('resolved an ambiguous prefix');
    expect(r.error.split('\n').filter(l => l.startsWith('  aaaa'))).toHaveLength(AMBIGUOUS_CANDIDATES_SHOWN);
    expect(r.error).toContain('... and 3 more');
  });

  it('says so when nothing matches', () => {
    expect(resolveItemIdPrefix(items, 'deadbeef')).toMatchObject({ ok: false });
  });
});