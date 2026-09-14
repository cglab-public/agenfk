/**
 * Signalling an agent and everything it started (CGLAB eda2628f).
 *
 * node-pty's `kill` is `process.kill(this.pid, signal)` — the direct child and
 * nothing else. Agents do not run alone: they start MCP servers, `npx`,
 * language servers, test runners. One Claude Code session measured on this
 * machine had five children of its own, none of them reachable. STOP and
 * window close left them running with nothing pointing at them.
 *
 * The child of a pty is a session leader — `forkpty` calls `setsid` — so its
 * pid is also its process-group id, and a NEGATIVE pid signals the whole
 * group. That is the entire mechanism.
 *
 * THE SIGN IS THE DANGEROUS PART, and it is why this is its own module with
 * its own tests. `kill(-0)` signals the caller's own group: this app, and
 * every agent it is running. `kill(-1)` signals every process the user owns.
 * A pid that arrives as 0, NaN or undefined and gets negated anyway is the
 * difference between closing a terminal and logging somebody out. So the
 * validation below runs before anything is negated, and refusing is always the
 * safe answer — a surviving subprocess is a nuisance; the alternative is not.
 *
 * Under tmux this still does the right thing without a special case: the tmux
 * server daemonises itself with its own `setsid`, so it is not in our group.
 * The group kill reaches the attach client and leaves the server running,
 * which is exactly what `persist` promises.
 */

export interface KillDeps {
  /** Injected so the SIGN can be asserted without signalling anything real. */
  readonly kill: (pid: number, signal: string) => void;
}

const defaultDeps: KillDeps = {
  kill: (pid, signal) => process.kill(pid, signal as NodeJS.Signals),
};

/**
 * Is this a pid we may negate?
 *
 * Integer, and strictly greater than 1. Both boundaries are load-bearing
 * rather than defensive: 0 negates to the caller's own group and 1 to
 * everything the user owns. Anything else — a float, a NaN, a string that came
 * through JSON, a handle that never started — is not a process.
 */
function isSignallable(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1;
}

/**
 * Signal a pty child and its process group.
 *
 * Silent on failure, like node-pty: a terminal closing must not surface an
 * error because the agent had already exited, and a teardown loop must not
 * abort part-way through because one session was gone.
 */
export function killProcessTree(
  pid: number,
  signal: string = 'SIGHUP',
  deps: KillDeps = defaultDeps,
): void {
  // Before any negation. See the header.
  if (!isSignallable(pid)) return;

  try {
    deps.kill(-pid, signal);
    return;
  } catch {
    /*
     * No such group — the child is not a session leader after all. Fall back
     * to the bare pid, which is exactly what node-pty did, so this change can
     * only ever reach MORE than before and never less.
     */
  }

  try {
    deps.kill(pid, signal);
  } catch {
    /* Already gone, or not ours to signal. Neither is worth a crash. */
  }
}
