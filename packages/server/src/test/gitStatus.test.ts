/**
 * Reading a worktree's status without stopping the server (CGLAB 70d3dfb7).
 *
 * The route ran `execFileSync`, and the comment beneath it acknowledged the
 * problem rather than fixing it: "the server is single-threaded and this runs
 * on its event loop."
 *
 * It is not a rare path. The worktree panel refetches every four seconds and
 * is always shown, so this is roughly nine hundred `git` forks an hour, each
 * one holding the whole server still for its duration — tens to hundreds of
 * milliseconds on a large worktree, up to the ten second timeout on a hung
 * one. During each block there is no REST and no Socket.io, including the
 * `resolveWorktree` calls that opening a terminal depends on.
 *
 * THE FIRST TEST IS THE WHOLE CARD. The others are about not breaking what the
 * synchronous version got right.
 */
import { describe, it, expect, vi } from 'vitest';
import { readGitStatus, GIT_STATUS_TIMEOUT_MS } from '../gitStatus';

/** An exec that resolves on a timer, so "did the loop keep turning" is answerable. */
const slowExec = (out = '', ms = 20) =>
  vi.fn(() => new Promise<string>(resolve => { setTimeout(() => resolve(out), ms); }));

describe('the event loop', () => {
  it('keeps turning while git runs', async () => {
    /*
     * The point of the card, stated as something a test can actually see: a
     * macrotask scheduled AFTER the call must run BEFORE the read resolves.
     * Against a synchronous implementation that is impossible by construction
     * — the timer cannot fire, because nothing yields.
     */
    const order: string[] = [];
    const pending = readGitStatus('/tmp/wt', { exec: slowExec('', 20) })
      .then(() => { order.push('git'); });
    await new Promise(r => setTimeout(r, 0));
    order.push('timer');
    await pending;
    expect(order).toEqual(['timer', 'git']);
  });

  it('lets two reads overlap instead of queueing', async () => {
    // Two panels, or a panel and a spawn. Synchronously these were strictly
    // serial, and the second waited out the first.
    const exec = slowExec('', 20);
    await Promise.all([
      readGitStatus('/a', { exec }),
      readGitStatus('/b', { exec }),
    ]);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('what it asks git for', () => {
  it('uses the porcelain format the parser expects', async () => {
    // `--porcelain=v1 -z` is a contract with parseGitStatus, not a preference:
    // v2 and newline separation both parse to nonsense.
    const exec = slowExec();
    await readGitStatus('/tmp/wt', { exec });
    const [file, args] = exec.mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe('git');
    expect(args).toEqual(['status', '--porcelain=v1', '-z']);
  });

  it('runs it in the worktree, never anywhere else', async () => {
    /*
     * The route's own comment argues this: the server's cwd would report the
     * state of whatever repository the server happens to be running in —
     * confidently, and about the wrong tree.
     */
    const exec = slowExec();
    await readGitStatus('/tmp/some-worktree', { exec });
    const opts = (exec.mock.calls[0] as unknown as [string, string[], { cwd: string }])[2];
    expect(opts.cwd).toBe('/tmp/some-worktree');
  });

  it('carries a deadline, so a hung git cannot hold a request open', async () => {
    const exec = slowExec();
    await readGitStatus('/tmp/wt', { exec });
    const opts = (exec.mock.calls[0] as unknown as [string, string[], { timeout: number }])[2];
    expect(opts.timeout).toBe(GIT_STATUS_TIMEOUT_MS);
  });
});

describe('when git fails', () => {
  it('throws rather than reporting a clean tree', async () => {
    /*
     * The trap the synchronous version avoided and this must keep avoiding.
     * An empty status parses as "no changes", which is a confident lie about a
     * directory that may not be a repository at all.
     */
    const exec = vi.fn(async () => { throw new Error('not a git repository'); });
    await expect(readGitStatus('/tmp/not-a-repo', { exec })).rejects.toThrow(/not a git/);
  });

  it('does not swallow a timeout into an empty result either', async () => {
    const exec = vi.fn(async () => { throw Object.assign(new Error('ETIMEDOUT'), { killed: true }); });
    await expect(readGitStatus('/tmp/wt', { exec })).rejects.toThrow();
  });
});

describe('what it gives back', () => {
  it('parses the porcelain output', async () => {
    // NUL-separated, two-character status codes. Round-tripped through the
    // real parser rather than asserted on a shape this file invented.
    const out = ' M packages/ui/src/App.tsx\0A  packages/ui/src/New.tsx\0';
    const result = await readGitStatus('/tmp/wt', { exec: vi.fn(async () => out) });
    // `changed` and `staged` are COUNTS, and `files` carries the detail.
    expect(result.files).toHaveLength(2);
    expect(result.changed + result.staged).toBe(2);
  });

  it('reads an empty status as a clean tree', async () => {
    const result = await readGitStatus('/tmp/wt', { exec: vi.fn(async () => '') });
    expect(result).toEqual({ changed: 0, staged: 0, files: [] });
  });
});
