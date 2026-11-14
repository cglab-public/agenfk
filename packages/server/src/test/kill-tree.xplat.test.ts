/**
 * @file #208 branch review — a timed-out command is killed with everything it started, on Windows too.
 *
 * Off Windows the server spawns a command in its own process group and kills
 * the group. On Windows a negative pid throws, and the fallback killed only
 * cmd.exe: npm, vitest and their workers ran on, and a leftover one could write
 * the NEXT capture's report. `taskkill /T` ends the whole tree there - started
 * without blocking the server, and only while the child is alive.
 */
import { describe, it, expect } from 'vitest';
import { killProcessTree, type KillTreeDeps } from '../killTree';

type Child = Parameters<typeof killProcessTree>[0];

function fakes(platform: NodeJS.Platform, opts: { groupKillThrows?: boolean; taskkillFails?: boolean; exited?: boolean } = {}) {
  const calls: string[] = [];
  const deps: KillTreeDeps = {
    platform,
    killPid: (pid, sig) => {
      calls.push(`kill ${pid} ${sig}`);
      if (pid < 0 && opts.groupKillThrows) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    },
    taskkill: (pid, onFailed) => { calls.push(`taskkill ${pid}`); if (opts.taskkillFails) onFailed(); },
  };
  const child: Child = {
    pid: 42,
    exitCode: opts.exited ? 0 : null,
    signalCode: null,
    kill: (sig?: NodeJS.Signals) => { calls.push(`child.kill ${sig}`); return true; },
  };
  return { deps, child, calls };
}

describe('killProcessTree()', () => {
  it('off Windows, kills the process group', () => {
    const { deps, child, calls } = fakes('linux');
    killProcessTree(child, deps);
    expect(calls).toEqual(['kill -42 SIGKILL']);
  });

  it('off Windows, falls back to the child when there is no group to kill', () => {
    const { deps, child, calls } = fakes('darwin', { groupKillThrows: true });
    killProcessTree(child, deps);
    expect(calls).toEqual(['kill -42 SIGKILL', 'child.kill SIGKILL']);
  });

  it('off Windows, still kills the group after the shell exited: its workers may live on', () => {
    const { deps, child, calls } = fakes('linux', { exited: true });
    killProcessTree(child, deps);
    expect(calls).toEqual(['kill -42 SIGKILL']);
  });

  it('on Windows, ends the whole tree with taskkill, not just cmd.exe', () => {
    const { deps, child, calls } = fakes('win32');
    killProcessTree(child, deps);
    expect(calls).toEqual(['taskkill 42']);
  });

  it('on Windows, still kills the child itself when taskkill fails', () => {
    const { deps, child, calls } = fakes('win32', { taskkillFails: true });
    killProcessTree(child, deps);
    expect(calls).toEqual(['taskkill 42', 'child.kill SIGKILL']);
  });

  // Every normal finish calls it too. taskkill /T walks from a LIVE root only, a dead pid can be
  // reused by an unrelated process, and each run cost the server ~0.5 s (branch re-review).
  it('on Windows, does nothing once the child has exited', () => {
    const { deps, child, calls } = fakes('win32', { exited: true });
    killProcessTree(child, deps);
    expect(calls).toEqual([]);
  });

  it('does nothing to a child that never got a pid (spawn failed) but kill it', () => {
    const { deps, calls } = fakes('win32');
    const child: Child = { pid: undefined, exitCode: null, signalCode: null, kill: () => { calls.push('child.kill'); return true; } };
    killProcessTree(child, deps);
    expect(calls).toEqual(['child.kill']);
  });
});
