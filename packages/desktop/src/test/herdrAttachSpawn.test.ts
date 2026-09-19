/**
 * @vitest-environment node
 *
 * Opening a herdr session in the terminal this app already has (96953f6a).
 *
 * The first version of this feature was a read-only mirror with a keypad,
 * modelled on collie. collie is a bridge you point a phone at, so a photograph
 * is the best it can do; we run on the same machine as the daemon, and this
 * repository already attached to a multiplexer in its own PTY - see
 * buildTmuxShellCommand, which has done exactly this for tmux all along.
 *
 * An ATTACH is not a spawn, and these tests are mostly about the four things it
 * must therefore NOT do.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PtyRegistry } from '../main/ptyRegistry';
import { HERDR_AGENT_ID } from '../main/agents';

interface Rec { file: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }
let spawned: Rec[];
let resolveCwdCalls: string[];
let registeredRuns: unknown[];

const fakePty = () => ({
  pid: 1, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {},
  kill: () => {}, pause: () => {}, resume: () => {},
});

function makeRegistry(over: Partial<ConstructorParameters<typeof PtyRegistry>[0]> = {}): PtyRegistry {
  return new PtyRegistry({
    spawn: ((file: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
      spawned.push({ file, args, cwd: opts.cwd, env: opts.env });
      return fakePty();
    }) as never,
    resolveCwd: async (itemId: string) => {
      resolveCwdCalls.push(itemId);
      return { cwd: '/tmp/wt/i1', branchName: 'feat/x' };
    },
    registerRun: info => { registeredRuns.push(info); },
    emit: () => {},
    ...over,
  } as never);
}

const attach = (r: PtyRegistry) =>
  r.spawn({ itemId: 'no-card', agentId: HERDR_AGENT_ID, windowId: 1, cols: 80, rows: 24 });

beforeEach(() => {
  spawned = [];
  resolveCwdCalls = [];
  registeredRuns = [];
  for (const k of Object.keys(process.env)) if (k.startsWith('HERDR')) delete process.env[k];
});

/* ── it is a terminal, running herdr ───────────────────────────────────── */

describe('what actually runs', () => {
  it('runs herdr itself, in a real PTY', async () => {
    /*
     * The whole point. Not a mirror of a pane over HTTP - the multiplexer, in
     * the terminal this app already draws, the same way tmux is attached for
     * session persistence.
     */
    await attach(makeRegistry());
    expect(spawned[0].file).toBe('herdr');
    expect(spawned[0].args).toEqual([]);
  });
});

/* ── the four things an attach must not do ─────────────────────────────── */

describe('an attach resolves no worktree', () => {
  it('never calls the resolver', async () => {
    /*
     * herdr is already running and already owns the panes. There is no card to
     * resolve, no branch to check out, and nothing to create - which is what
     * makes adopting a session that started outside this app possible at all.
     */
    await attach(makeRegistry());
    expect(resolveCwdCalls).toEqual([]);
  });

  it('opens even when the resolver would have thrown', async () => {
    // A herdr pane in somebody's own checkout has no card behind it. If the
    // attach went through the resolver, the commonest case would be the one
    // that fails.
    const r = makeRegistry({ resolveCwd: async () => { throw new Error('no worktree for this item'); } });
    await expect(attach(r)).resolves.toBeTruthy();
    expect(spawned[0].file).toBe('herdr');
  });
});

describe('an attach is never wrapped in tmux', () => {
  it('runs herdr directly even when tmux is available and persistence is asked for', async () => {
    /*
     * tmux is wrapped around an agent to make it outlive this app. herdr IS
     * that daemon - nesting one multiplexer in the other buys nothing and
     * costs a layer of keybindings fighting each other.
     */
    const r = makeRegistry({ tmux: { available: true } } as never);
    await r.spawn({ itemId: 'x', agentId: HERDR_AGENT_ID, windowId: 1, cols: 80, rows: 24, persist: true } as never);
    expect(spawned[0].file).toBe('herdr');
    expect(spawned[0].args.join(' ')).not.toMatch(/tmux/);
  });
});

describe('an attach registers no run', () => {
  it('records nothing, because this app dispatched nothing', async () => {
    /*
     * `registerRun` means "an agent was dispatched here". The pane was already
     * running, started by somebody else, possibly before this app opened. A run
     * in the feed with no transcript behind it is the same lie the tree rows
     * refuse when they carry a `herdr:` id instead of a real one.
     */
    await attach(makeRegistry());
    expect(registeredRuns).toEqual([]);
  });

  it('still registers one for an ordinary agent', async () => {
    // The guard must be about attaching, not a blanket disabling.
    await makeRegistry().spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24 });
    expect(registeredRuns).toHaveLength(1);
  });
});

describe('an attach carries no HERDR variables', () => {
  it('strips them, or herdr refuses to start', async () => {
    /*
     * MEASURED: herdr launched from inside a herdr pane answers "nested herdr
     * is disabled by default" and exits. If this app was started from such a
     * terminal it inherits HERDR_PANE_ID, and every attach would die with a
     * message nobody would trace back to here.
     */
    process.env.HERDR_PANE_ID = 'w8:p1';
    process.env.HERDR_SOCKET_PATH = '/x/herdr.sock';
    await attach(makeRegistry());
    const env = spawned[0].env;
    expect(Object.keys(env).filter(k => k.toUpperCase().startsWith('HERDR'))).toEqual([]);
  });

  it('keeps PATH, which is how herdr is found at all', async () => {
    // The login-shell PATH capture exists for exactly this; stripping it here
    // would undo that work and the failure would look like "herdr not installed".
    await attach(makeRegistry());
    expect(spawned[0].env.PATH).toBeTruthy();
  });

  it("leaves an ordinary agent's environment alone", async () => {
    process.env.HERDR_PANE_ID = 'w8:p1';
    await makeRegistry().spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24 });
    expect(spawned[0].env.HERDR_PANE_ID).toBe('w8:p1');
  });
});
