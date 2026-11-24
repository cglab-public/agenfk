/**
 * A per-key mutex inside this process.
 *
 * The hub is a single Node process (see `util/rateLimit.ts`, which reasons the
 * same way about per-process state), so an await-serialised queue is what
 * "one at a time" means here: two requests that both touch one repository's
 * revision row pass through the same key and cannot interleave.
 *
 * It is NOT cross-process and NOT cross-hub. It never replaces the transaction
 * that makes a write correct — it only keeps two callers of the same process
 * from starting that transaction at the same instant. A hub that ever runs more
 * than one process needs a real lock (an advisory lock in the database, or a
 * queue) at the service layer, and every caller of this must stay correct
 * without it.
 *
 * The lock is dropped when `fn` settles, including when it throws: the promise
 * a waiting caller awaits is settled in `finally`, so one caller's failure can
 * never strand the queue behind it.
 */
const waiting = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Take the tail of the queue for this key and stand behind it. The map entry
  // is removed only by the caller still at the head, once nobody is behind it,
  // so a caller that joined while we were queued is never cut out.
  const previous = waiting.get(key);
  let release: () => void = () => {};
  const mine = new Promise<void>(resolve => { release = resolve; });
  const tail = (previous ?? Promise.resolve()).then(() => mine);
  waiting.set(key, tail);

  await (previous ?? Promise.resolve()).catch(() => { /* the caller before us failed; the lock is ours */ });
  try {
    return await fn();
  } finally {
    release();
    if (waiting.get(key) === tail) waiting.delete(key);
  }
}

/** Test-only: how many keys currently hold or queue a caller. */
export function __lockQueueSize(): number {
  return waiting.size;
}
