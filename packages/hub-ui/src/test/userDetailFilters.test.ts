import { describe, it, expect } from 'vitest';

import { readPersistedSet } from '../hooks/useToggleSet';
import {
  DEFAULT_USER_EVENT_TYPES,
  USER_EVENT_TYPES_STORAGE_KEY,
  USER_ITEM_TYPES_STORAGE_KEY,
  USER_PROJECTS_STORAGE_KEY,
} from '../pages/userDetailFilters';

const makeStorage = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
};

describe('per-user page filter defaults', () => {
  it('hides nothing by default', () => {
    // The regression this guards: a profile page opening on a single event type
    // is indistinguishable, to the person reading it, from a hub that failed to
    // record their work.
    expect([...DEFAULT_USER_EVENT_TYPES]).toEqual([]);
  });

  it('defaults event types the same way as the other two selectors', () => {
    // Event types used to be the one special case on this page. Consistency is
    // the point: three filters, three empty defaults.
    const storage = makeStorage();
    expect([...readPersistedSet(storage, USER_EVENT_TYPES_STORAGE_KEY, DEFAULT_USER_EVENT_TYPES)])
      .toEqual([...readPersistedSet(storage, USER_PROJECTS_STORAGE_KEY, [])]);
    expect([...readPersistedSet(storage, USER_ITEM_TYPES_STORAGE_KEY, [])]).toEqual([]);
  });

  it('uses a storage key that retires the old persisted selection', () => {
    // useToggleSet persists on MOUNT, so everyone who has opened this page has
    // ["item.closed"] written under the v1 key, and readPersistedSet honours a
    // stored value whenever the key exists. Without a new key the fix would ship
    // and change nothing for exactly the people who reported the problem.
    expect(USER_EVENT_TYPES_STORAGE_KEY).not.toBe('agenfk-hub:user:eventTypes');
    expect(USER_EVENT_TYPES_STORAGE_KEY).toMatch(/:v[2-9]\d*$/);

    const stale = makeStorage({ 'agenfk-hub:user:eventTypes': '["item.closed"]' });
    // The stale v1 write is not consulted…
    expect([...readPersistedSet(stale, USER_EVENT_TYPES_STORAGE_KEY, DEFAULT_USER_EVENT_TYPES)])
      .toEqual([]);
    // …while the old key still holds it, proving the read moved rather than the
    // data being cleared out from under an unrelated consumer.
    expect(stale.getItem('agenfk-hub:user:eventTypes')).toBe('["item.closed"]');
  });

  it('still lets a developer narrow to a single type and have it stick', () => {
    // The fix must not remove the capability, only the default.
    const storage = makeStorage({ [USER_EVENT_TYPES_STORAGE_KEY]: '["pr.opened"]' });
    expect([...readPersistedSet(storage, USER_EVENT_TYPES_STORAGE_KEY, DEFAULT_USER_EVENT_TYPES)])
      .toEqual(['pr.opened']);
  });
});
