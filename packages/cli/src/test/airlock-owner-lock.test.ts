/**
 * 03d41e43: one lock for every Airlock lock across processes (a machine's, the smolvm install's).
 * Its owner is published whole; a stale lock is broken by one process at a time, which judges it
 * again under its turn, so a lock a live owner took meanwhile is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { breakStaleLock, withOwnerLock, type OwnerLockDeps } from '../airlock/ownerLock';

let dir: string;
let lock: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-lock-')); lock = path.join(dir, 'lock'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const deps = (over: Partial<OwnerLockDeps> = {}): OwnerLockDeps => ({
  pidAlive: (pid) => pid === process.pid,
  identityOf: (pid) => (pid === process.pid ? 'boot-1/this' : null),
  timeoutMs: 5000,
  pollMs: 5,
  timedOut: () => new Error('timed out'),
  ...over,
});

describe('withOwnerLock', () => {
  it('holds the lock while its work runs, named by its owner, and releases it after', async () => {
    let held = '';
    await withOwnerLock(lock, async () => { held = fs.readFileSync(lock, 'utf8'); }, deps());
    expect(held).toMatch(new RegExp(`^${process.pid} [0-9a-f]{16} boot-1/this$`));
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('lets one holder in at a time, however many ask at once', async () => {
    let inside = 0;
    let most = 0;
    await Promise.all(Array.from({ length: 8 }, () => withOwnerLock(lock, async () => {
      most = Math.max(most, ++inside);
      await new Promise((r) => setTimeout(r, 10));
      inside--;
    }, deps())));
    expect(most).toBe(1);
  });

  it('takes over a lock whose owner is gone, or whose pid is another process now', async () => {
    for (const owner of ['999999 gone', `${process.pid} other boot-0/before`]) {
      fs.writeFileSync(lock, owner);
      let ran = false;
      await withOwnerLock(lock, async () => { ran = true; }, deps());
      expect(ran, owner).toBe(true);
    }
  });

  it('waits for a lock its live owner holds, and gives up when told to', async () => {
    fs.writeFileSync(lock, `${process.pid} other boot-1/this`);
    await expect(withOwnerLock(lock, async () => undefined, deps({ timeoutMs: 100 }))).rejects.toThrow('timed out');
    expect(fs.readFileSync(lock, 'utf8')).toBe(`${process.pid} other boot-1/this`);
  });

  it('releases only its own lock: one another took over meanwhile stays', async () => {
    await withOwnerLock(lock, async () => { fs.rmSync(lock); fs.writeFileSync(lock, `${process.pid} theirs boot-1/this`); }, deps());
    expect(fs.readFileSync(lock, 'utf8')).toBe(`${process.pid} theirs boot-1/this`);
  });
});

describe('breakStaleLock', () => {
  it('never breaks a lock a live owner took after the stale one was seen', () => {
    fs.writeFileSync(lock, '999999 gone');
    const staleIno = fs.statSync(lock).ino;
    fs.rmSync(lock);
    fs.writeFileSync(lock, `${process.pid} live boot-1/this`);
    expect(breakStaleLock(lock, staleIno, deps())).toBe(false);
    expect(fs.readFileSync(lock, 'utf8')).toBe(`${process.pid} live boot-1/this`);
  });

  it('breaks nothing while another process has the turn to', () => {
    fs.writeFileSync(lock, '999999 gone');
    fs.writeFileSync(`${lock}.break`, `${process.pid} breaking boot-1/this`);
    expect(breakStaleLock(lock, fs.statSync(lock).ino, deps())).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
  });
});
