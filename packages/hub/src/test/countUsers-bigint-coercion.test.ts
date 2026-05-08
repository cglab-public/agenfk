/**
 * Regression: under Postgres the `pg` driver returns COUNT(*) as a string
 * because bigint values are not safe for the JS Number type. countUsers()
 * was typed `<{ c: number }>` and returned `row?.c ?? 0` — a strict-equal
 * comparison `countUsers() === 0` then misfired in /auth/providers and
 * stamped `requiresSetup: false` on an empty `users` table. SPA then
 * bounced /setup → /login, locking operators out of bootstrap.
 *
 * pg-mem doesn't reproduce the bigint-as-string serialization, so the
 * dual-backend e2e didn't catch it. This test simulates the buggy driver
 * shape directly with a stub HubDb and pins the contract that countUsers
 * always returns a JS number.
 */
import { describe, it, expect } from 'vitest';
import { countUsers } from '../auth/password';
import type { HubDb } from '../db/types';

const stubDb = (overrides: Partial<HubDb>): HubDb => ({
  run: async () => ({ changes: 0 }),
  get: async () => undefined,
  all: async () => [],
  exec: async () => {},
  transaction: async (fn) => fn(),
  close: async () => {},
  ...overrides,
});

describe('countUsers — bigint-as-string coercion', () => {
  it('coerces a string-shaped COUNT result (pg behavior) to a JS number', async () => {
    const db = stubDb({
      get: async () => ({ c: '0' }) as any,
    });
    const c = await countUsers(db);
    expect(c).toBe(0);
    expect(typeof c).toBe('number');
    expect(c === 0).toBe(true); // the strict-equal that misfired in /auth/providers
  });

  it('returns 0 (number) when the row is undefined', async () => {
    const db = stubDb({ get: async () => undefined });
    const c = await countUsers(db);
    expect(c).toBe(0);
    expect(typeof c).toBe('number');
  });

  it('coerces a non-zero string ("3") to 3', async () => {
    const db = stubDb({ get: async () => ({ c: '3' }) as any });
    expect(await countUsers(db)).toBe(3);
  });

  it('preserves a numeric (sqlite) result unchanged', async () => {
    const db = stubDb({ get: async () => ({ c: 5 }) as any });
    expect(await countUsers(db)).toBe(5);
  });

  it('strict equality with literal 0 holds for the empty-table case (the SPA gate)', async () => {
    // This is the contract /auth/providers depends on:
    //   requiresSetup: (await countUsers(ctx.db)) === 0
    const empty = stubDb({ get: async () => ({ c: '0' }) as any });
    expect((await countUsers(empty)) === 0).toBe(true);
  });
});
