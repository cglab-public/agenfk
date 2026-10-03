/**
 * Reading a worktree's git status without stopping the server (CGLAB 70d3dfb7).
 *
 * The route did this with `execFileSync`, and the comment under it
 * acknowledged the problem instead of fixing it: "the server is
 * single-threaded and this runs on its event loop."
 *
 * It is not a rare path. The worktree panel refetches every four seconds and
 * is always shown, so this is around nine hundred `git` forks an hour, each
 * holding the entire server still for its duration — tens to hundreds of
 * milliseconds on a large worktree, up to the full timeout on a hung one.
 * During each block the server serves no REST and no Socket.io, including the
 * `resolveWorktree` calls that opening a terminal depends on. Blocking here
 * therefore widens the window of a completely unrelated race.
 *
 * Extracted from the route so the exec can be injected: "does the event loop
 * keep turning" is not answerable against a call the test cannot get between.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseGitStatus, type GitWorktreeStatus } from '@agenfk/core';

const execFileAsync = promisify(execFile);

/**
 * How long a single `git status` may take.
 *
 * Unchanged from the synchronous version. It matters less now — a slow git no
 * longer holds the server — but a request still should not hang forever, and a
 * worktree that takes ten seconds to describe has something wrong with it.
 */
export const GIT_STATUS_TIMEOUT_MS = 10_000;

export interface GitStatusDeps {
  readonly exec: (
    file: string,
    args: readonly string[],
    opts: { cwd: string; encoding: 'utf8'; timeout: number },
  ) => Promise<string>;
}

const defaultDeps: GitStatusDeps = {
  exec: async (file, args, opts) => {
    const { stdout } = await execFileAsync(file, args as string[], opts);
    return stdout;
  },
};

/**
 * The worktree's status, or a rejection.
 *
 * REJECTS rather than answering empty, and that is deliberate: an empty
 * porcelain output parses as "no changes", which would be a confident lie
 * about a directory that may not be a repository at all. The caller turns this
 * into a 409 with the reason attached.
 */
export async function readGitStatus(
  cwd: string,
  deps: GitStatusDeps = defaultDeps,
): Promise<GitWorktreeStatus> {
  // `--porcelain=v1 -z` is a contract with the parser, not a preference: v2
  // and newline separation both parse to nonsense.
  const out = await deps.exec('git', ['status', '--porcelain=v1', '-z'], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
  return parseGitStatus(out);
}
