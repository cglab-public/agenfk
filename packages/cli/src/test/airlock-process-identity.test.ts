/**
 * 6386d4ac: a pid alone does not say a process is the one recorded - after a crash or a reboot
 * the number is reused. Its identity (when it started, in which boot) does.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { processIdentity, sameProcess } from '../airlock/processIdentity';

describe.skipIf(process.platform === 'win32')('processIdentity, on this machine', () => {
  it('names this process the same way each time, without spaces (a lock owner line holds it)', () => {
    const me = processIdentity(process.pid);
    expect(me).toMatch(/^\S+$/);
    expect(processIdentity(process.pid)).toBe(me);
  });

  it('tells another process apart, and has nothing for a process that is gone', async () => {
    // macOS gives a start time to the second: the other process starts in a later one.
    await new Promise((r) => setTimeout(r, 1100));
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const other = processIdentity(child.pid!);
      expect(other).toMatch(/^\S+$/);
      expect(other).not.toBe(processIdentity(process.pid));
    } finally {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
    expect(processIdentity(child.pid!)).toBeNull();
  });
});

describe('sameProcess', () => {
  const alive = (pid: number) => pid === 42;
  it('is the recorded process when its pid is alive and names the same identity', () => {
    expect(sameProcess({ pid: 42, identity: 'b/1' }, { pidAlive: alive, identityOf: () => 'b/1' })).toBe(true);
  });

  it('is not when the pid is alive under another identity (reused), nor when it is not alive', () => {
    expect(sameProcess({ pid: 42, identity: 'b/1' }, { pidAlive: alive, identityOf: () => 'c/7' })).toBe(false);
    expect(sameProcess({ pid: 7, identity: 'b/1' }, { pidAlive: alive, identityOf: () => 'b/1' })).toBe(false);
  });

  it('judges by the pid alone a record without an identity (an older one), or when the identity cannot be read', () => {
    expect(sameProcess({ pid: 42 }, { pidAlive: alive, identityOf: () => 'c/7' })).toBe(true);
    expect(sameProcess({ pid: 42, identity: 'b/1' }, { pidAlive: alive, identityOf: () => null })).toBe(true);
  });
});
