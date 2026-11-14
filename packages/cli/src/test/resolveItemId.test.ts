import { describe, it, expect } from 'vitest';
import { resolveItemIdPrefix } from '../resolveItemId';

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

  it('says so when nothing matches', () => {
    expect(resolveItemIdPrefix(items, 'deadbeef')).toMatchObject({ ok: false });
  });
});