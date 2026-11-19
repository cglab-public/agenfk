/**
 * The hub's per-key in-process mutex (`util/withLock`), which the repository
 * command revision route takes around its write.
 *
 * What the route needs from it, and nothing more: two callers of one process
 * cannot be inside the same key at once, one caller's failure does not strand
 * the callers behind it, and two different keys do not wait on each other. It
 * is not a cross-process lock and is not asserted to be one here — see the
 * header of the module for why the transaction still has to settle the write.
 */
import { describe, it, expect } from 'vitest';
import { withLock, __lockQueueSize } from '../util/withLock';

const nap = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

describe('hub withLock()', () => {
  it('runs two callers of one key one after the other', async () => {
    const log: string[] = [];
    const a = withLock('k', async () => {
      log.push('a start');
      await nap(30);
      log.push('a end');
      return 'a';
    });
    const b = withLock('k', async () => {
      log.push('b start');
      return 'b';
    });
    expect(await Promise.all([a, b])).toEqual(['a', 'b']);
    expect(log).toEqual(['a start', 'a end', 'b start']);
  });

  it('passes each call’s own result and error back to its own caller', async () => {
    expect(await withLock('k2', async () => 42)).toBe(42);
    await expect(withLock('k2', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });

  it('a caller that throws does not strand the ones queued behind it', async () => {
    const first = withLock('k3', async () => { await nap(20); throw new Error('failed inside the lock'); });
    const second = withLock('k3', async () => 'second ran');
    await expect(first).rejects.toThrow('failed inside the lock');
    expect(await second).toBe('second ran');
    // And the key is free afterwards, not left held by the caller that failed.
    expect(await withLock('k3', async () => 'third ran')).toBe('third ran');
  });

  it('leaves a different key running while one key is held', async () => {
    const log: string[] = [];
    const held = withLock('slow', async () => { await nap(30); log.push('slow done'); });
    const free = withLock('quick', async () => { log.push('quick done'); return 'quick'; });
    expect(await free).toBe('quick');
    expect(log).toEqual(['quick done']);
    await held;
    expect(log).toEqual(['quick done', 'slow done']);
  });

  it('gives the queue back when the last caller finishes', async () => {
    expect(__lockQueueSize()).toBe(0);
    await Promise.all([
      withLock('k4', async () => { await nap(10); }),
      withLock('k4', async () => { await nap(10); }),
      withLock('k5', async () => nap(5)),
    ]);
    expect(__lockQueueSize()).toBe(0);
  });
});
