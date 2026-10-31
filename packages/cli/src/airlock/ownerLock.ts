/**
 * Airlock's lock across processes (a machine's, the smolvm install's: 03d41e43). It names its
 * owner - pid, a token, and the process's identity (6386d4ac) - published whole, and only its owner
 * removes it. One whose owner is gone (or whose pid is another process now) is broken, by one
 * process at a time, which judges it again under its turn: a live owner's lock is never touched.
 */
import crypto from 'crypto';
import fs from 'fs';
import { sameProcess } from './processIdentity';

export interface OwnerLockDeps {
  pidAlive: (pid: number) => boolean;
  /** Which process a pid is now (processIdentity), or null when it cannot be read. */
  identityOf: (pid: number) => string | null;
  /** How long to wait for a live owner before giving up with `timedOut()`. */
  timeoutMs: number;
  pollMs: number;
  timedOut: () => Error;
}

/** This process, as a lock names it: pid, a token of its own, and its identity when it has one. */
export function lockOwner(d: Pick<OwnerLockDeps, 'identityOf'>): string {
  return [process.pid, crypto.randomBytes(8).toString('hex'), d.identityOf(process.pid)].filter(Boolean).join(' ');
}

/** A lock left by an owner that is gone, or naming none (an older AgEnFK's) and a minute old. */
export function lockStale(lock: string, d: Pick<OwnerLockDeps, 'pidAlive' | 'identityOf'>): boolean {
  const st = fs.statSync(lock);
  const [pid, , identity] = fs.readFileSync(lock, 'utf8').split(' ');
  const holder = Number(pid);
  return Number.isInteger(holder) && holder > 0
    ? !sameProcess({ pid: holder, identity }, { pidAlive: d.pidAlive, identityOf: d.identityOf })
    : Date.now() - st.mtimeMs > 60_000;
}

/**
 * Takes `lock` for `owner`, published whole: the owner written to a file of its own, linked into
 * place (a link onto an existing name fails) - a lock is never seen without its owner. False when
 * it is held.
 */
function takeLock(lock: string, owner: string): boolean {
  const tmp = `${lock}.${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(tmp, owner, { flag: 'wx' });
  try {
    fs.linkSync(tmp, lock);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Removes a stale lock. Processes doing so take turns on a second lock, and each checks again
 * under it that the lock is still that same file and still stale: a live owner's lock is never
 * touched. True only when it removed it; false when another holds the turn, or the lock is no
 * longer stale.
 */
export function breakStaleLock(lock: string, ino: number, d: Pick<OwnerLockDeps, 'pidAlive' | 'identityOf'>): boolean {
  const turn = `${lock}.break`;
  const mine = lockOwner(d);
  if (!takeLock(turn, mine)) {
    // Held for an instant; one left by a process that is gone is cleared (an older one's naming
    // none, once a minute old: story review), and only if it is still that same turn.
    try {
      const held = fs.readFileSync(turn, 'utf8');
      if (lockStale(turn, d) && fs.readFileSync(turn, 'utf8') === held) fs.rmSync(turn);
    } catch { /* gone */ }
    return false;
  }
  let removed = false;
  try {
    // Judged again under the turn, by the same rule the caller used (story review).
    if (fs.statSync(lock).ino === ino && lockStale(lock, d)) { fs.rmSync(lock); removed = true; }
  } catch { /* released meanwhile */ } finally {
    try { if (fs.readFileSync(turn, 'utf8') === mine) fs.rmSync(turn); } catch { /* not ours any more */ }
  }
  return removed;
}

/** Runs `fn` holding `lock`; a stale one is broken (breakStaleLock), a live one waited for. */
export async function withOwnerLock<T>(lock: string, fn: () => Promise<T>, d: OwnerLockDeps): Promise<T> {
  const mine = lockOwner(d);
  const deadline = Date.now() + d.timeoutMs;
  for (;;) {
    if (takeLock(lock, mine)) break;
    let ino: number | null = null;
    try { if (lockStale(lock, d)) ino = fs.statSync(lock).ino; } catch { /* released meanwhile */ }
    // Always yield before trying again: a retry that cannot succeed must never spin.
    if (ino !== null && breakStaleLock(lock, ino, d)) { await new Promise((r) => setImmediate(r)); continue; }
    if (Date.now() > deadline) throw d.timedOut();
    await new Promise((r) => setTimeout(r, d.pollMs));
  }
  try {
    return await fn();
  } finally {
    try { if (fs.readFileSync(lock, 'utf8') === mine) fs.rmSync(lock); } catch { /* not ours any more */ }
  }
}
