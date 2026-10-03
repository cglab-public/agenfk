import { vi } from 'vitest';
import { SESSION_USER_SQL } from '../../auth/session';

/**
 * Reproduce the race the last-admin SQL guard exists for, deterministically.
 *
 * The session guard reads the acting user's row, then the route writes. A
 * change landing in between (another admin demoting the actor) is invisible to
 * the guard. Here the actor's guard read is held, `meanwhile` runs to
 * completion, and only then does the actor's request carry on to its write.
 *
 * `start` must return a supertest request; it is started here.
 *
 * `holdAt` moves the hold to a later read of the actor's request (the first
 * call of that method with that exact SQL), for a route that checks again
 * after the guard: the race then lands between that check and the write.
 * `actorUserId` is not consulted then: the first such read is the actor's
 * because `meanwhile` starts only once it has been held.
 */
export async function raceBehindGuard<T>(
  db: { get: (...args: any[]) => Promise<any>; all?: (...args: any[]) => Promise<any> },
  actorUserId: string,
  start: () => PromiseLike<T>,
  meanwhile: () => Promise<unknown>,
  holdAt?: { method: 'get' | 'all'; sql: string },
): Promise<T> {
  const method = holdAt?.method ?? 'get';
  const realRead = (db as any)[method].bind(db);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let heard!: () => void;
  const guardRead = new Promise<void>(r => { heard = r; });
  let held = false;
  const matches = (sql: unknown, params?: unknown[]) => holdAt
    ? sql === holdAt.sql
    : sql === SESSION_USER_SQL && params?.[0] === actorUserId;
  const spy = vi.spyOn(db as any, method).mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const row = await realRead(sql, params);
    if (!held && matches(sql, params)) {
      held = true;
      heard();
      await gate;
    }
    return row;
  });
  try {
    const pending = Promise.resolve(start());
    try {
      await guardRead;
      await meanwhile();
    } finally {
      // Always let the held request go, or a failing `meanwhile` leaves it
      // hanging and the real failure surfaces only as a test timeout. If we
      // leave by that throw, `pending` is never awaited: keep it handled.
      release();
      pending.catch(() => {});
    }
    return await pending;
  } finally {
    spy.mockRestore();
  }
}
