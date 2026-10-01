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
 */
export async function raceBehindGuard<T>(
  db: { get: (...args: any[]) => Promise<any> },
  actorUserId: string,
  start: () => PromiseLike<T>,
  meanwhile: () => Promise<unknown>,
): Promise<T> {
  const realGet = db.get.bind(db);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let heard!: () => void;
  const guardRead = new Promise<void>(r => { heard = r; });
  let held = false;
  const spy = vi.spyOn(db, 'get').mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const row = await realGet(sql, params);
    if (!held && sql === SESSION_USER_SQL && params?.[0] === actorUserId) {
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
