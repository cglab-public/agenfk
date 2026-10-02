/**
 * @vitest-environment node
 *
 * Killing an agent AND what it started (CGLAB eda2628f).
 *
 * node-pty's `kill` is `process.kill(this.pid, signal)` — one pid. Agents do
 * not run alone: they spawn MCP servers, `npx`, language servers, test
 * runners. Measured on this machine, a single Claude Code session had five
 * direct children of its own. None of them was signalled, so STOP and window
 * close left them running with nothing pointing at them.
 *
 * The child of a pty is a session leader (`forkpty` calls `setsid`), so its pid
 * is also its process-group id, and a negative pid signals the whole group.
 *
 * MOST OF THIS FILE IS ABOUT THE SIGN, not the feature. `process.kill(-0)`
 * signals the CALLER'S OWN GROUP — this app and everything it has spawned —
 * and `-1` signals every process the user owns. A pid that arrives as 0,
 * undefined or NaN and is negated anyway is the difference between closing a
 * terminal and logging the user out. That is the one failure here that is
 * catastrophic rather than annoying, so it is tested first and hardest.
 */
import { describe, it, expect, vi } from 'vitest';
import { killProcessTree } from '../main/processTree';

/** Records what was signalled, so the SIGN can be asserted. */
const spy = (throwOn?: (pid: number) => Error) => {
  const calls: Array<{ pid: number; signal: string }> = [];
  return {
    calls,
    kill: (pid: number, signal: string) => {
      const boom = throwOn?.(pid);
      if (boom) throw boom;
      calls.push({ pid, signal });
    },
  };
};

describe('the pids it refuses to touch', () => {
  it('will not signal its own process group', () => {
    /*
     * THE test. `-0` is `0` is "every process in the caller's group", which
     * here is the app itself and every agent it has running. A pid of 0 should
     * never reach this function, and the day it does the answer must be to do
     * nothing at all.
     */
    const s = spy();
    killProcessTree(0, 'SIGHUP', { kill: s.kill });
    expect(s.calls).toEqual([]);
  });

  it('will not signal every process the user owns', () => {
    // `-1` is "all processes the caller may signal". There is no scenario in
    // this app where that is the intent.
    const s = spy();
    killProcessTree(1, 'SIGHUP', { kill: s.kill });
    expect(s.calls).toEqual([]);
  });

  it('will not act on a pid that is not a pid', () => {
    // A pty handle that never started, a record read back from disk, a number
    // that came through JSON as a string. None of these are a process.
    const s = spy();
    for (const bad of [-1, -5, NaN, Infinity, 1.5, undefined, null, '900']) {
      killProcessTree(bad as never, 'SIGHUP', { kill: s.kill });
    }
    expect(s.calls).toEqual([]);
  });
});

describe('an ordinary session', () => {
  it('signals the GROUP, which is what reaches the children', () => {
    // Negative pid, once. This is the entire feature: the agent's own MCP
    // servers and subprocesses share its group and die with it.
    const s = spy();
    killProcessTree(4242, 'SIGHUP', { kill: s.kill });
    expect(s.calls).toEqual([{ pid: -4242, signal: 'SIGHUP' }]);
  });

  it('passes the signal through rather than choosing one', () => {
    const s = spy();
    killProcessTree(4242, 'SIGKILL', { kill: s.kill });
    expect(s.calls[0].signal).toBe('SIGKILL');
  });

  it('defaults to SIGHUP, like node-pty does', () => {
    // A hangup is what a closing terminal means, and agents handle it. Keeping
    // the same default means this changes the REACH of the signal, not its
    // kind.
    const s = spy();
    killProcessTree(4242, undefined, { kill: s.kill });
    expect(s.calls[0].signal).toBe('SIGHUP');
  });
});

describe('when the group is not there', () => {
  it('falls back to the process itself', () => {
    /*
     * ESRCH on the group means no such group — which happens when the child is
     * not a session leader after all. Falling back to the bare pid keeps the
     * old behaviour rather than silently killing nothing, so this can only
     * ever reach MORE than before, never less.
     */
    const s = spy(pid => (pid < 0 ? Object.assign(new Error('no such process'), { code: 'ESRCH' }) : undefined));
    killProcessTree(4242, 'SIGHUP', { kill: s.kill });
    expect(s.calls).toEqual([{ pid: 4242, signal: 'SIGHUP' }]);
  });

  it('does not fall back when the group was signalled fine', () => {
    // Signalling twice would deliver two hangups to everything in the group.
    const s = spy();
    killProcessTree(4242, 'SIGHUP', { kill: s.kill });
    expect(s.calls).toHaveLength(1);
  });

  it('gives up quietly when the process is gone too', () => {
    // Both throwing means it already exited. node-pty swallows this and so do
    // we: a terminal closing must not surface an error because the agent beat
    // it to the exit.
    const s = spy(() => Object.assign(new Error('no such process'), { code: 'ESRCH' }));
    expect(() => killProcessTree(4242, 'SIGHUP', { kill: s.kill })).not.toThrow();
  });

  it('stays quiet when it is not allowed to signal at all', () => {
    // EPERM. Nothing useful to do, and nothing worth crashing a teardown over.
    const s = spy(() => Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));
    expect(() => killProcessTree(4242, 'SIGHUP', { kill: s.kill })).not.toThrow();
  });
});

/**
 * Reaping the children of a process that has already gone (review follow-up).
 *
 * The three explicit reaping paths were covered; the fourth — the agent
 * exiting on its own, which is how a session ends most of the time — was not.
 * Its MCP servers and subprocesses survived exactly as before, so the commit's
 * own premise ("a missed path is a leak that only ever shows up as 'my fans
 * are on'") was not satisfied by the common case.
 *
 * The group is still the right target, and the timing is safer than it looks:
 * POSIX keeps a process group alive while any member remains, and the kernel
 * will not hand the leader's pid to a new process while it is still a pgid. So
 * signalling `-pid` here reaches the orphans without the recycled-pid hazard.
 *
 * WHAT MUST NOT HAPPEN is the fallback. If the group is gone — no children
 * left — falling back to the bare pid would signal whatever the OS has since
 * given that number to.
 */
describe('when the leader has already exited', () => {
  it('still signals the group, to reach the orphans', () => {
    const s = spy();
    killProcessTree(4242, 'SIGHUP', { kill: s.kill }, { fallbackToPid: false });
    expect(s.calls).toEqual([{ pid: -4242, signal: 'SIGHUP' }]);
  });

  it('does NOT fall back to the bare pid', () => {
    /*
     * The whole reason this variant exists. The leader is dead, so the pid may
     * already belong to something else — and unlike the group, a bare pid
     * carries no evidence of who it is.
     */
    const s = spy(pid => (pid < 0 ? Object.assign(new Error('gone'), { code: 'ESRCH' }) : undefined));
    killProcessTree(4242, 'SIGHUP', { kill: s.kill }, { fallbackToPid: false });
    expect(s.calls).toEqual([]);
  });

  it('keeps the guards, which do not depend on the variant', () => {
    const s = spy();
    killProcessTree(0, 'SIGHUP', { kill: s.kill }, { fallbackToPid: false });
    killProcessTree(1, 'SIGHUP', { kill: s.kill }, { fallbackToPid: false });
    expect(s.calls).toEqual([]);
  });

  it('still falls back by default, for a process that is still alive', () => {
    // The explicit paths keep the old reach: there the leader is alive and the
    // bare pid is unambiguously ours.
    const s = spy(pid => (pid < 0 ? Object.assign(new Error('gone'), { code: 'ESRCH' }) : undefined));
    killProcessTree(4242, 'SIGHUP', { kill: s.kill });
    expect(s.calls).toEqual([{ pid: 4242, signal: 'SIGHUP' }]);
  });
});
