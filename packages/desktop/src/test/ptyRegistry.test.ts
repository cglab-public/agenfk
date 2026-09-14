/**
 * @vitest-environment node
 *
 * CGLAB-169: the live PTY sessions, and who is allowed to touch them.
 *
 * A PTY is a real child process holding a real shell in a real worktree. Two
 * things therefore have to hold, and neither is visible by reading the happy
 * path:
 *
 *  1. Sessions are owned. `pty:write` carries a session id, and a session id is
 *     just a string once it is in the renderer. Without an ownership check,
 *     any window could write into any other window's shell — which is keystroke
 *     injection into a process running with the user's credentials.
 *  2. Sessions are reaped. A PTY outlives the window that opened it unless
 *     something kills it. Closing the app with orphaned shells still attached
 *     to worktrees is how you end up with processes nobody can find.
 *
 * The spawner is injected so none of this needs real processes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PtyRegistry, MAX_SESSIONS_PER_WINDOW } from '../main/ptyRegistry';
import { HIGH_WATERMARK } from '../main/flowControl';

interface FakePty {
  pid: number;
  written: string[];
  resizes: Array<[number, number]>;
  killed: boolean;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  kill: () => void;
  /** Flow control. Counted rather than flagged: calling pause per chunk of a
   *  firehose is thousands of no-op syscalls a second, so the COUNT matters. */
  pause: () => void;
  resume: () => void;
  pauses: number;
  resumes: number;
  /** Test hooks to drive the fake from outside. */
  emitData?: (d: string) => void;
  emitExit?: (code: number) => void;
}

let spawned: Array<{ file: string; args: readonly string[]; cwd: string; pty: FakePty }>;

const makeSpawner = () =>
  vi.fn((file: string, args: readonly string[], opts: { cwd: string; cols: number; rows: number }) => {
    let dataCb: (d: string) => void = () => {};
    let exitCb: (e: { exitCode: number }) => void = () => {};
    const pty: FakePty = {
      pid: 1000 + spawned.length,
      written: [],
      resizes: [],
      killed: false,
      onData: cb => { dataCb = cb; },
      onExit: cb => { exitCb = cb; },
      write: d => { pty.written.push(d); },
      resize: (c, r) => { pty.resizes.push([c, r]); },
      kill: () => { pty.killed = true; },
      pauses: 0,
      resumes: 0,
      pause: () => { pty.pauses += 1; },
      resume: () => { pty.resumes += 1; },
    };
    pty.emitData = d => dataCb(d);
    pty.emitExit = code => exitCb({ exitCode: code });
    spawned.push({ file, args, cwd: opts.cwd, pty });
    return pty;
  });

/**
 * Opens a session and hands back the PTY handle.
 *
 * spawn() returns BOTH ids now — the pty handle and the agent's conversation
 * id — because they are different things and a bare "sessionId" was ambiguous
 * enough to send a pty handle to `--resume`. These tests are about process
 * ownership, so they want the handle.
 */
const open = async (registry: PtyRegistry, windowId: number, itemId = 'i1') =>
  (await registry.spawn({ itemId, agentId: 'shell', windowId, cols: 80, rows: 24 })).sessionId;

let registry: PtyRegistry;
let spawner: ReturnType<typeof makeSpawner>;
let emitted: Array<{ windowId: number; channel: string; payload: unknown }>;

beforeEach(() => {
  spawned = [];
  emitted = [];
  spawner = makeSpawner();
  registry = new PtyRegistry({
    spawn: spawner as never,
    resolveCwd: async () => ({ cwd: '/tmp/wt/i1', branchName: 'feat/x' }),
    emit: (windowId, channel, payload) => { emitted.push({ windowId, channel, payload }); },
  });
});

describe('opening a session', () => {
  it('spawns in the worktree the resolver returned, not anywhere else', async () => {
    await open(registry, 1);
    expect(spawned[0].cwd).toBe('/tmp/wt/i1');
  });

  it('hands back an opaque id, not the item id', async () => {
    // The session id travels to the renderer. If it were the item id, a
    // renderer could address a session it never opened just by knowing a card.
    const id = await open(registry, 1, 'item-abc');
    expect(id).not.toContain('item-abc');
    expect(id.length).toBeGreaterThan(8);
  });

  it('gives two sessions on the same card different ids', async () => {
    const a = await open(registry, 1, 'same');
    const b = await open(registry, 1, 'same');
    expect(a).not.toBe(b);
  });

  it('does not register a session when the worktree cannot be resolved', async () => {
    // Otherwise the registry accumulates entries with no process behind them,
    // and kill/write on them look like ownership failures rather than the
    // resolution failure they are.
    const failing = new PtyRegistry({
      spawn: spawner as never,
      resolveCwd: async () => { throw new Error('no project root'); },
      emit: () => {},
    });
    await expect(open(failing, 1)).rejects.toThrow(/project root/);
    expect(failing.countForWindow(1)).toBe(0);
    expect(spawner).not.toHaveBeenCalled();
  });
});

describe('the environment the shell is born into', () => {
  it('does not hand the child our raw process env', async () => {
    // The defect this replaced: `env: process.env` gave every agent launchd's
    // minimal PATH and no TERM at all, so node-pty fell back to plain `xterm`.
    await open(registry, 1);
    const opts = spawner.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(opts.env).not.toBe(process.env);
    expect(opts.env.TERM).toBe('xterm-256color');
    expect(opts.env.COLORTERM).toBe('truecolor');
  });

  it('spawns with the same PATH detection probed with', async () => {
    // Detecting an agent against a recovered login PATH and then launching it
    // against the inherited one is exactly how "Installed" becomes ENOENT.
    const withLogin = new PtyRegistry({
      spawn: spawner as never,
      resolveCwd: async () => ({ cwd: '/tmp/wt/i1', branchName: null }),
      emit: () => {},
      loginPath: () => '/opt/homebrew/bin:/usr/bin',
    });
    await open(withLogin, 1);
    const opts = spawner.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(opts.env.PATH).toContain('/opt/homebrew/bin');
  });

  it('does not leak ELECTRON_RUN_AS_NODE into the agent', async () => {
    // An agent that shells out to node would re-enter our own binary.
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      await open(registry, 1);
      const opts = spawner.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE;
    }
  });
});

describe('surviving the app closing', () => {
  // A PTY we spawn is a child of this app: close the app and the agent dies.
  // Running the agent INSIDE a tmux session breaks that link — tmux owns the
  // process and our PTY is only a view attached to it.

  const withTmux = (available: boolean) => new PtyRegistry({
    spawn: spawner as never,
    resolveCwd: async () => ({ cwd: '/tmp/wt/i1', branchName: null }),
    emit: () => {},
    tmux: { available },
  });

  it('does NOT use tmux unless asked, even where it is available', async () => {
    // Off by default. Running inside tmux changes the terminal the agent lives
    // in — the tmux prefix starts competing with the agent's own shortcuts —
    // and that is a change to opt into, not to discover. Sessions that predate
    // the feature also kept working without it.
    await withTmux(true).spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24 });
    expect(spawned[0].args.join(' ')).not.toMatch(/tmux/);
  });

  it('runs the agent inside tmux when it is available AND asked for', async () => {
    await withTmux(true).spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24, persist: true });
    const [file, args] = [spawned[0].file, spawned[0].args];
    expect(file).toMatch(/sh$/);
    expect(args.join(' ')).toMatch(/tmux/);
    expect(args.join(' ')).toMatch(/attach-session/);
  });

  it('spawns the agent directly when asked but tmux is absent', async () => {
    // Degrades to a working terminal without persistence, rather than failing.
    await withTmux(false).spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24, persist: true });
    expect(spawned[0].args.join(' ')).not.toMatch(/tmux/);
  });

  it('reuses the same tmux session for the same card and agent', async () => {
    // The point of the whole thing: reopening must ATTACH to the session that
    // is still running, not start a second agent beside it.
    const reg = withTmux(true);
    await reg.spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24, persist: true });
    await reg.spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24, persist: true });
    const names = spawned.map(s => /=(agenfk-[A-Za-z0-9_-]+)/.exec(s.args.join(' '))?.[1]);
    expect(names[0]).toBe(names[1]);
  });

  it('gives a different card its own session', async () => {
    const reg = withTmux(true);
    await reg.spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24, persist: true });
    await reg.spawn({ itemId: 'i2', agentId: 'shell', windowId: 1, cols: 80, rows: 24, persist: true });
    const names = spawned.map(s => /=(agenfk-[A-Za-z0-9_-]+)/.exec(s.args.join(' '))?.[1]);
    expect(names[0]).not.toBe(names[1]);
  });

  it('still carries the auto-approve flag into the tmux session', async () => {
    // The flag has to reach the AGENT, which is now nested one level deeper.
    // Losing it here would silently re-enable prompts the user turned off.
    await withTmux(true).spawn({
      itemId: 'i1', agentId: 'claude-code', windowId: 1, cols: 80, rows: 24, autoApprove: true, persist: true,
    });
    expect(spawned[0].args.join(' ')).toMatch(/--dangerously-skip-permissions/);
  });
});

describe('ownership — a window may only touch its own sessions', () => {
  it('refuses a write from another window', async () => {
    const id = await open(registry, 1);
    expect(() => registry.write(id, 2, 'rm -rf /\\n')).toThrow(/unknown session/i);
    expect(spawned[0].pty.written).toEqual([]);
  });

  it('refuses a resize from another window', async () => {
    const id = await open(registry, 1);
    expect(() => registry.resize(id, 2, 10, 10)).toThrow(/unknown session/i);
    expect(spawned[0].pty.resizes).toEqual([]);
  });

  it('refuses a kill from another window', async () => {
    const id = await open(registry, 1);
    expect(() => registry.kill(id, 2)).toThrow(/unknown session/i);
    expect(spawned[0].pty.killed).toBe(false);
  });

  it('refuses an id that was never issued', async () => {
    await open(registry, 1);
    expect(() => registry.write('made-up', 1, 'x')).toThrow(/unknown session/i);
  });

  it('does not leak whether a session exists for a different window', async () => {
    // Same error either way: a probing renderer must not be able to enumerate
    // other windows' sessions by comparing messages.
    const id = await open(registry, 1);
    const other = (() => { try { registry.write(id, 2, 'x'); } catch (e) { return (e as Error).message; } })();
    const bogus = (() => { try { registry.write('nope', 2, 'x'); } catch (e) { return (e as Error).message; } })();
    expect(other).toBe(bogus);
  });

  it('lets the owning window write, resize and kill', async () => {
    const id = await open(registry, 1);
    registry.write(id, 1, 'ls\n');
    registry.resize(id, 1, 120, 40);
    registry.kill(id, 1);
    expect(spawned[0].pty.written).toEqual(['ls\n']);
    expect(spawned[0].pty.resizes).toEqual([[120, 40]]);
    expect(spawned[0].pty.killed).toBe(true);
  });
});

describe('reaping — no orphaned shells', () => {
  it('kills every session belonging to a window that closed', async () => {
    await open(registry, 1);
    await open(registry, 1);
    await open(registry, 2);
    registry.killAllForWindow(1);
    expect(spawned[0].pty.killed).toBe(true);
    expect(spawned[1].pty.killed).toBe(true);
    expect(spawned[2].pty.killed, 'another window’s session must survive').toBe(false);
  });

  it('kills everything on app quit', async () => {
    await open(registry, 1);
    await open(registry, 2);
    registry.killAll();
    expect(spawned.every(s => s.pty.killed)).toBe(true);
  });

  it('forgets a session once it is killed, so the registry cannot grow forever', async () => {
    const id = await open(registry, 1);
    registry.kill(id, 1);
    expect(registry.countForWindow(1)).toBe(0);
    expect(() => registry.write(id, 1, 'x')).toThrow(/unknown session/i);
  });

  it('forgets a session that exited on its own', async () => {
    // The user types `exit`. Without this the entry lingers and a later write
    // reaches a dead pty object.
    const id = await open(registry, 1);
    spawned[0].pty.emitExit!(0);
    expect(registry.countForWindow(1)).toBe(0);
    expect(() => registry.write(id, 1, 'x')).toThrow(/unknown session/i);
  });
});

describe('talking back to the renderer', () => {
  it('sends output only to the window that owns the session', async () => {
    const id = await open(registry, 1);
    await open(registry, 2);
    spawned[0].pty.emitData!('hello');
    const dataEvents = emitted.filter(e => e.channel === 'pty:data');
    expect(dataEvents).toHaveLength(1);
    expect(dataEvents[0].windowId).toBe(1);
    expect(dataEvents[0].payload).toEqual({ sessionId: id, data: 'hello' });
  });

  it('tells the window when a session ends, so the tab can say so', async () => {
    // Without this the terminal just stops responding and looks hung.
    const id = await open(registry, 1);
    spawned[0].pty.emitExit!(3);
    const exit = emitted.find(e => e.channel === 'pty:exit');
    expect(exit?.payload).toEqual({ sessionId: id, exitCode: 3 });
  });
});

/**
 * Conversations that survive the app.
 *
 * The registry is where the id is MINTED, because it is where the validation
 * lives and where argv is assembled. Generating it in the renderer would put
 * an untrusted value one step closer to a process argument for no benefit.
 */
const makeRegistry = () => new PtyRegistry({
  spawn: spawner as never,
  resolveCwd: async () => ({ cwd: '/tmp/wt/i1', branchName: 'feat/x' }),
  emit: () => {},
});

describe('conversation ids', () => {
  const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

  it('mints one for an agent that can be told its id, and reports it back', async () => {
    // Reported back because the caller has to STORE it. An id the app forgets
    // is an id that cannot resume anything.
    const reg = makeRegistry();
    const result = await reg.spawn({ itemId: 'i1', agentId: 'claude-code', windowId: 1, cols: 80, rows: 24 });
    expect(result.agentSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(spawned[0].args).toContain('--session-id');
  });

  it('mints nothing for an agent that cannot be told its id', async () => {
    // codex. Returning an id we never gave it would be a lie the caller then
    // stores and later tries to resume with.
    const reg = makeRegistry();
    const result = await reg.spawn({ itemId: 'i1', agentId: 'codex', windowId: 1, cols: 80, rows: 24 });
    expect(result.agentSessionId).toBeUndefined();
  });

  it('resumes with the id it is given rather than minting a new one', async () => {
    const reg = makeRegistry();
    const result = await reg.spawn({
      itemId: 'i1', agentId: 'claude-code', windowId: 1, cols: 80, rows: 24,
      agentSessionId: UUID, resume: true,
    });
    expect(result.agentSessionId).toBe(UUID);
    // claude resumes by DIRECTORY (`--continue`), because resuming by id fails
    // outright when the conversation was never persisted. The id is still
    // carried through — it is what the row remembers — but the argv does not
    // depend on it. See agents.ts.
    expect(spawned[0].args).toEqual(['--continue']);
  });

  it('still returns a pty handle, which is a different thing entirely', async () => {
    // Two ids, no relation: this one addresses a live process for write/resize
    // /kill and dies with it; the other addresses a conversation and is the
    // only reason a restored terminal is worth anything. Conflating them would
    // send a pty handle to `--resume` and silently start a fresh conversation.
    const reg = makeRegistry();
    const result = await reg.spawn({ itemId: 'i1', agentId: 'claude-code', windowId: 1, cols: 80, rows: 24 });
    expect(result.sessionId).toBeTruthy();
    expect(result.sessionId).not.toBe(result.agentSessionId);
  });
});

/**
 * A bound on how many agents one window can start.
 *
 * `countForWindow` existed with no production caller at all — a cap that was
 * written and never applied. Each `pty:spawn` is a real child process, the map
 * only shrinks on exit, kill or window close, and the module's own header
 * threat-models an XSS in the renderer. A loop on `pty:spawn` created processes
 * without limit.
 *
 * The number is not the interesting part; having one is. It sits far above any
 * real use — a person does not open thirty agents by hand — so it only ever
 * fires on a bug.
 */
describe('a limit on concurrent sessions', () => {
  it('refuses to start more than the cap for one window', async () => {
    const reg = makeRegistry();
    for (let n = 0; n < MAX_SESSIONS_PER_WINDOW; n += 1) {
      await reg.spawn({ itemId: `i${n}`, agentId: 'shell', windowId: 1, cols: 80, rows: 24 });
    }
    await expect(
      reg.spawn({ itemId: 'one-too-many', agentId: 'shell', windowId: 1, cols: 80, rows: 24 }),
    ).rejects.toThrow(/too many/i);
  });

  it('counts per window, not globally', async () => {
    // Two windows are two people's worth of work, not one runaway loop.
    const reg = makeRegistry();
    for (let n = 0; n < MAX_SESSIONS_PER_WINDOW; n += 1) {
      await reg.spawn({ itemId: `i${n}`, agentId: 'shell', windowId: 1, cols: 80, rows: 24 });
    }
    await expect(
      reg.spawn({ itemId: 'other-window', agentId: 'shell', windowId: 2, cols: 80, rows: 24 }),
    ).resolves.toBeTruthy();
  });

  it('lets a window start again after its sessions end', async () => {
    // The cap is about how many run AT ONCE. A window that opened and closed
    // terminals all day must not be locked out.
    const reg = makeRegistry();
    const ids: string[] = [];
    for (let n = 0; n < MAX_SESSIONS_PER_WINDOW; n += 1) {
      ids.push((await reg.spawn({ itemId: `i${n}`, agentId: 'shell', windowId: 1, cols: 80, rows: 24 })).sessionId);
    }
    reg.kill(ids[0], 1);
    await expect(
      reg.spawn({ itemId: 'after-a-close', agentId: 'shell', windowId: 1, cols: 80, rows: 24 }),
    ).resolves.toBeTruthy();
  });
});

/**
 * The last link in the auto-approve chain (CGLAB-180).
 *
 * Every other hop already had a test — the dialog, the strict `=== true`
 * coercion in the IPC layer, the flag construction in agents.ts. This one did
 * not: nothing asserted that what `resolveAgentCommand` built actually reached
 * the spawner's argv.
 *
 * It matters more than an average missing link because this flag turns off the
 * agent's own permission prompts. And the epic has already produced the exact
 * failure this guards against: `supportsAutoApprove` shipped dead, with
 * fixtures on both sides of the seam agreeing with each other and with nobody
 * else. A chain whose every piece is tested in isolation can still be broken in
 * the middle.
 */
describe('auto-approve reaching the process', () => {
  const spawnWith = async (agentId: string, autoApprove: boolean) => {
    spawned = [];
    await registry.spawn({ itemId: 'i1', agentId, windowId: 1, cols: 80, rows: 24, autoApprove } as never);
    return spawned[0];
  };

  it('puts the flag in the argv when it was asked for', async () => {
    const { args } = await spawnWith('claude-code', true);
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('leaves it out when it was not', async () => {
    // The direction that actually protects someone: a default that leaks the
    // flag in would disable prompts for every user who never opened Settings.
    const { args } = await spawnWith('claude-code', false);
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('leaves it out when nothing was said at all', async () => {
    spawned = [];
    await registry.spawn({ itemId: 'i1', agentId: 'claude-code', windowId: 1, cols: 80, rows: 24 });
    expect(spawned[0].args).not.toContain('--dangerously-skip-permissions');
  });

  it('carries every argument for an agent that needs more than one', async () => {
    // codex is the case that breaks any implementation assuming a single
    // flag: three settings, two of them as `-c key=value` pairs, and dropping
    // any one of them leaves the agent still prompting while the UI says it
    // will not.
    const { args } = await spawnWith('codex', true);
    expect(args).toEqual(expect.arrayContaining([
      '-c', 'approval_policy=never',
      '-c', 'sandbox_mode=danger-full-access',
      '--dangerously-bypass-hook-trust',
    ]));
  });

  it('does not invent a flag for an agent that has none', async () => {
    // `shell` is the fallback and is not an agent. Asking for auto-approve on
    // it must not produce argv it cannot parse.
    const { args } = await spawnWith('shell', true);
    expect(args).not.toContain('--dangerously-skip-permissions');
  });
});

/**
 * A terminal opened before the login PATH has arrived (CGLAB-181).
 *
 * The main process no longer awaits `captureLoginPath()` before showing the
 * window — it used to, which meant every launch sat at a blank screen for the
 * length of the user's rc chain, and `execFile` does not close the child's
 * stdin, so an rc file that reads input held it there until the 5s timeout.
 *
 * Not waiting is only safe because this callback may answer with a promise.
 * Handing the spawn a null PATH instead would be the degraded-PATH failure the
 * capture exists to prevent, just moved into the first second after launch.
 */
describe('the login PATH arriving late', () => {
  let spy: ReturnType<typeof makeSpawner>;
  const envOf = (call: number) =>
    (spy.mock.calls[call]?.[2] as unknown as { env: NodeJS.ProcessEnv }).env;

  it('hands the child the PATH that arrived, not a degraded one', async () => {
    /*
     * The assertion that actually matters, and the first version of this test
     * did not make it: it checked only that a spawn eventually happened, which
     * an implementation that awaited the promise and then threw the value away
     * would also satisfy.
     *
     * "It spawned nothing yet" was no better — `spawn` awaits `resolveCwd`
     * before it ever reaches the PATH, and that await already costs a tick, so
     * a single microtask cannot tell "holding for the PATH" apart from "still
     * resolving the worktree".
     */
    let release: (v: string) => void = () => {};
    const arriving = new Promise<string>(res => { release = res; });
    spy = makeSpawner();
    const late = new PtyRegistry({
      spawn: spy as never,
      resolveCwd: async () => ({ cwd: '/tmp/wt/i1', branchName: 'feat/x' }),
      loginPath: () => arriving,
      emit: () => {},
    });

    spawned = [];
    const opening = late.spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24 });
    release('/opt/homebrew/bin:/usr/bin');
    await opening;
    expect(envOf(0).PATH).toContain('/opt/homebrew/bin');
  });

  it('does not spawn while the PATH is still on its way', async () => {
    // Given enough turns for resolveCwd to settle several times over, so the
    // only thing that can still be holding the spawn is the PATH.
    let release: (v: string) => void = () => {};
    const arriving = new Promise<string>(res => { release = res; });
    spy = makeSpawner();
    const late = new PtyRegistry({
      spawn: spy as never,
      resolveCwd: async () => ({ cwd: '/tmp/wt/i1', branchName: 'feat/x' }),
      loginPath: () => arriving,
      emit: () => {},
    });

    spawned = [];
    const opening = late.spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24 });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(spawned, 'spawned before the login PATH was known').toHaveLength(0);

    release('/opt/homebrew/bin:/usr/bin');
    await opening;
    expect(spawned).toHaveLength(1);
  });
});

/**
 * A resume that finds nothing must not leave a dead tab (CGLAB-188).
 *
 * Reported with a screenshot: a restored terminal showing "Session exited (1)."
 * and, in red, "No conversation found to continue".
 *
 * `claude --continue` means "the most recent conversation IN THIS DIRECTORY",
 * and nothing can know whether one exists until it runs. A worktree created
 * moments ago has never had the agent in it; and the agent only persists a
 * conversation after an exchange, so opening a terminal, saying nothing and
 * closing it records a session row with no conversation behind it. Both are
 * ordinary.
 *
 * This was already swapped once — `--resume <id>` failed by ID for the same
 * underlying reason — so the lesson is that the flag is not the problem.
 * Resuming is a courtesy; starting fresh is correct when there is nothing to
 * resume, and the failure must not be terminal.
 */
describe('a resume that finds nothing to continue', () => {
  const openResumed = async (agentId = 'claude-code') => {
    spawned = [];
    const emitted: Array<{ channel: string; payload: any }> = [];
    const reg = new PtyRegistry({
      spawn: makeSpawner() as never,
      resolveCwd: async () => ({ cwd: '/tmp/wt/i1', branchName: 'feat/x' }),
      emit: (_w, channel, payload) => { emitted.push({ channel, payload }); },
    });
    const { sessionId } = await reg.spawn({
      itemId: 'i1', agentId, windowId: 1, cols: 80, rows: 24, resume: true,
    } as never);
    return { reg, emitted, sessionId };
  };

  it('starts a fresh session instead of dying', async () => {
    const { emitted } = await openResumed();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args, 'the first attempt should have been a resume').toContain('--continue');

    spawned[0].pty.emitExit!(1);
    expect(spawned, 'nothing was started after the failed resume').toHaveLength(2);
    expect(spawned[1].args).not.toContain('--continue');
    // And no exit was reported, because the tab is still alive.
    expect(emitted.some(e => e.channel === 'pty:exit')).toBe(false);
  });

  it('keeps the same session id, so the tab still addresses a live process', async () => {
    // The renderer is bound to the id it was given. A new one would leave the
    // tab talking to a process that does not exist.
    const { reg, sessionId } = await openResumed();
    spawned[0].pty.emitExit!(1);
    expect(() => reg.write(sessionId, 1, 'hello')).not.toThrow();
    expect(spawned[1].pty.written).toContain('hello');
  });

  it('says it started fresh, rather than swapping in silence', async () => {
    // Silently replacing a resumed session would leave the user believing they
    // still have the context.
    const { emitted } = await openResumed();
    spawned[0].pty.emitExit!(1);
    const said = emitted.filter(e => e.channel === 'pty:data').map(e => String(e.payload.data)).join('');
    expect(said).toMatch(/starting a new session/i);
  });

  it('does not do it twice, so a command that always fails is not a loop', async () => {
    await openResumed();
    spawned[0].pty.emitExit!(1);
    spawned[1].pty.emitExit!(1);
    expect(spawned).toHaveLength(2);
  });

  it('leaves a plain session alone when it exits', async () => {
    // A session that was never resuming exiting is just an exit.
    spawned = [];
    const emitted: Array<{ channel: string }> = [];
    const reg = new PtyRegistry({
      spawn: makeSpawner() as never,
      resolveCwd: async () => ({ cwd: '/tmp/wt/i1', branchName: null }),
      emit: (_w, channel) => { emitted.push({ channel }); },
    });
    await reg.spawn({ itemId: 'i1', agentId: 'claude-code', windowId: 1, cols: 80, rows: 24 });
    spawned[0].pty.emitExit!(1);
    expect(spawned).toHaveLength(1);
    expect(emitted.some(e => e.channel === 'pty:exit')).toBe(true);
  });

  it('leaves a resumed session alone when it exits cleanly', async () => {
    // Code 0 is the user typing `exit` on a session that resumed fine.
    const { emitted } = await openResumed();
    spawned[0].pty.emitExit!(0);
    expect(spawned).toHaveLength(1);
    expect(emitted.some(e => e.channel === 'pty:exit')).toBe(true);
  });
});

/**
 * Wiring the flow control to a real session.
 *
 * flowControl.ts decides WHEN to stop reading; these are about whether the
 * registry actually feeds it. A mutation that replaced `flow.sent(data.length)`
 * with `flow.sent(0)` left every other test in this file green, which is
 * exactly the shape of bug this describe block exists to catch: the accounting
 * is perfect and nothing is counted.
 */
describe('backpressure on a live session', () => {
  const flood = (pty: FakePty, bytes: number): void => {
    // Many small reads, like a real firehose, rather than one giant chunk.
    const chunk = 'x'.repeat(1_000);
    for (let i = 0; i < bytes / 1_000; i += 1) pty.emitData?.(chunk);
  };

  it('stops reading from a pty whose output is piling up undrawn', async () => {
    await open(registry, 1);
    const pty = spawned[0].pty;
    flood(pty, HIGH_WATERMARK + 4_000);
    expect(pty.pauses).toBe(1);
  });

  it('leaves an ordinary session alone', async () => {
    // The overwhelmingly common case. A prompt and a few lines of output must
    // never involve any of this.
    await open(registry, 1);
    spawned[0].pty.emitData?.('ready\r\n');
    expect(spawned[0].pty.pauses).toBe(0);
  });

  it('starts reading again once the renderer says it caught up', async () => {
    const id = await open(registry, 1);
    const pty = spawned[0].pty;
    flood(pty, HIGH_WATERMARK + 4_000);
    expect(pty.pauses).toBe(1);
    registry.ack(id, 1, HIGH_WATERMARK + 4_000);
    expect(pty.resumes).toBe(1);
  });

  it('will not let another window ack your session', async () => {
    /*
     * Same rule as write and kill, and it matters for the same reason: an ack
     * is the only thing that lifts a pause, so a window that could ack a
     * session it does not own could resume a producer the owner had stopped.
     * Silent, and it undoes the protection rather than raising an error.
     */
    const id = await open(registry, 1);
    const pty = spawned[0].pty;
    flood(pty, HIGH_WATERMARK + 4_000);
    registry.ack(id, 999, HIGH_WATERMARK + 4_000);
    expect(pty.resumes).toBe(0);
  });

  it('shrugs at an ack for a session that has gone', async () => {
    // Unlike write and kill, which throw. An ack is a report about the past,
    // and one arriving just after the session exited is ordinary — throwing
    // would turn a routine race into an error in the user's face.
    await open(registry, 1);
    expect(() => registry.ack('no-such-session', 1, 100)).not.toThrow();
  });
});

/**
 * A spawn that lands after its window is gone (CGLAB b17d2737).
 *
 * There are two awaits between entering `spawn()` and creating the pty:
 * resolving the worktree — which can run `git worktree add`, taking seconds —
 * and recovering the login PATH, which has an eight second deadline. Every
 * reaper walks the session map AS IT IS AT THAT INSTANT, so anything still in
 * flight registers itself afterwards, into a window that no longer exists.
 *
 * What that leaves behind is not a stray record. It is a real agent CLI
 * holding a real git worktree, with no tab, no window, and no route to kill
 * it — the same "two agents in one worktree editing the same files" failure
 * the reload path already documents having fixed for sessions it could see.
 *
 * The renderer has had this guard all along: a spawn that resolves after the
 * pane unmounted is explicitly killed. The asymmetry was the bug.
 */
describe('a spawn in flight when the window is reaped', () => {
  /** Holds `resolveCwd` open so a reaper can run while a spawn is mid-await. */
  const slowRegistry = () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const registry = new PtyRegistry({
      spawn: spawner as never,
      resolveCwd: async () => {
        await held;
        return { cwd: '/tmp/wt/i1', branchName: 'feat/x' };
      },
      emit: (windowId, channel, payload) => { emitted.push({ windowId, channel, payload }); },
    });
    return { registry, release };
  };

  it('never creates the process when that window was closed meanwhile', async () => {
    const { registry, release } = slowRegistry();
    const inFlight = registry.spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24 });

    // The window closes while the worktree is still being cut.
    registry.killAllForWindow(1);
    release();
    await inFlight.catch(() => undefined);

    // Nothing was spawned at all, which is the only outcome that leaves no
    // agent behind. Registering it and killing it afterwards would still have
    // run the agent in the worktree for as long as it took to notice.
    expect(spawned).toHaveLength(0);
  });

  it('never creates it when the app was quitting', async () => {
    /*
     * killAll has to invalidate a spawn for a window it has never heard of.
     * The session map is the only thing it can see, and an in-flight spawn is
     * by definition not in it yet — so a per-window counter alone would miss
     * exactly this case.
     */
    const { registry, release } = slowRegistry();
    const inFlight = registry.spawn({ itemId: 'i1', agentId: 'shell', windowId: 7, cols: 80, rows: 24 });
    registry.killAll();
    release();
    await inFlight.catch(() => undefined);
    expect(spawned).toHaveLength(0);
  });

  it('says so, instead of handing back a handle to nothing', async () => {
    /*
     * Replaces a weaker assertion that only checked the session count, which
     * a mutant moving the guard AFTER the spawn passed — it killed the pty
     * instead of never creating it, so the count was zero either way.
     *
     * What matters to the caller is different: returning quietly left a tab
     * holding a session id that addresses nothing, painting no output, no
     * error and no exit banner, while every keystroke rejected unhandled. The
     * refusal has to be audible.
     */
    const { registry, release } = slowRegistry();
    const inFlight = registry.spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24 });
    registry.killAllForWindow(1);
    release();
    await expect(inFlight).rejects.toThrow(/closed/i);
    expect(registry.countForWindow(1)).toBe(0);
  });

  it('still spawns when a DIFFERENT window was the one that closed', async () => {
    // The guard must be about this window, not about any reap anywhere. Two
    // windows are ordinary, and closing one must not cancel the other's work.
    const { registry, release } = slowRegistry();
    const inFlight = registry.spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24 });
    registry.killAllForWindow(2);
    release();
    await inFlight;
    expect(spawned).toHaveLength(1);
  });

  it('still spawns on the ordinary path, where nothing was reaped', async () => {
    // The guard must not be so eager that it breaks opening a terminal.
    const { registry, release } = slowRegistry();
    const inFlight = registry.spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24 });
    release();
    await inFlight;
    expect(spawned).toHaveLength(1);
  });

  it('allows a new terminal after the window has been reaped once', async () => {
    /*
     * The generation must gate the spawns it overlapped, not the window
     * forever. A reload reaps and then immediately restores, so if a bump were
     * permanent the restored tabs would silently never open.
     */
    const { registry, release } = slowRegistry();
    registry.killAllForWindow(1);
    const after = registry.spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24 });
    release();
    await after;
    expect(spawned).toHaveLength(1);
  });
});

/**
 * And the mirror image: a relaunch that lands after the session was killed.
 *
 * A resume that dies inside RESUME_FAILURE_MS is replaced by a fresh session
 * under the same id. If the user closed the window or quit inside that window,
 * both reapers have already walked a SNAPSHOT of the map — so a pty inserted
 * during the loop is never visited, and the replacement outlives the app.
 */
describe('the resume-failure relaunch', () => {
  it('does not resurrect a session that was killed first', async () => {
    const id = await (async () => {
      const r = await registry.spawn({
        itemId: 'i1', agentId: 'claude-code', windowId: 1, cols: 80, rows: 24,
        agentSessionId: '11111111-2222-3333-4444-555555555555', resume: true,
      });
      return r.sessionId;
    })();
    const before = spawned.length;

    registry.kill(id, 1);
    // The dying resume's exit arrives after the kill, which is the whole race.
    spawned[before - 1].pty.emitExit?.(1);

    expect(spawned).toHaveLength(before);
  });

  it('does not cancel an unrelated spawn when ONE session is killed', async () => {
    /*
     * The deliberate non-decision, which had no test at all: `kill` bumps
     * nothing. Adding a bump there would look tidy and would cancel every
     * spawn that happened to be in flight in the same window — a person
     * closing one tab would silently stop another from ever opening.
     *
     * Replaces a test that duplicated an existing, stronger one in "a resume
     * that finds nothing to continue", which already asserts the replacement
     * plus its argv plus the absence of an exit event.
     */
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const reg = new PtyRegistry({
      spawn: spawner as never,
      // Only the SECOND spawn waits, so the first can be opened and killed
      // while the second is still mid-await.
      resolveCwd: async () => {
        if (!first) await held;
        first = false;
        return { cwd: '/tmp/wt/i1', branchName: 'feat/x' };
      },
      emit: () => {},
    });
    const live = await reg.spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24 });
    const inFlight = reg.spawn({ itemId: 'i2', agentId: 'shell', windowId: 1, cols: 80, rows: 24 });

    reg.kill(live.sessionId, 1);
    release();
    await expect(inFlight).resolves.toBeTruthy();
    expect(reg.countForWindow(1)).toBe(1);
  });
});


/**
 * A pty that exits from inside its own kill (review follow-up).
 *
 * Nothing in `PtySpawner` — a public, injected interface — promises that exit
 * is delivered asynchronously. The shipped node-pty does, which is why none of
 * this is reachable on a real machine today; but the registry's correctness
 * should not rest on an invariant nobody wrote down, and the failure it allows
 * is the exact one this whole card is about.
 *
 * Every reaper now drops the session from the map BEFORE signalling, so a
 * synchronous exit can never find its own session still registered.
 */
describe('a pty that exits synchronously from kill', () => {
  /** Spawner whose `kill` fires `onExit` immediately, like a fake can. */
  const syncExitSpawner = () => vi.fn((file: string, args: readonly string[], opts: { cwd: string; cols: number; rows: number }) => {
    let dataCb: (d: string) => void = () => {};
    let exitCb: (e: { exitCode: number }) => void = () => {};
    const pty: FakePty = {
      pid: 2000 + spawned.length,
      written: [], resizes: [], killed: false, pauses: 0, resumes: 0,
      onData: cb => { dataCb = cb; },
      onExit: cb => { exitCb = cb; },
      write: d => { pty.written.push(d); },
      resize: (c, r) => { pty.resizes.push([c, r]); },
      pause: () => { pty.pauses += 1; },
      resume: () => { pty.resumes += 1; },
      // The whole point: the callback runs before kill() returns.
      kill: () => { pty.killed = true; exitCb({ exitCode: 1 }); },
    };
    pty.emitData = d => dataCb(d);
    pty.emitExit = code => exitCb({ exitCode: code });
    spawned.push({ file, args, cwd: opts.cwd, pty });
    return pty;
  });

  const syncRegistry = () => new PtyRegistry({
    spawn: syncExitSpawner() as never,
    resolveCwd: async () => ({ cwd: '/tmp/wt/i1', branchName: 'feat/x' }),
    emit: () => {},
  });

  const resuming = (reg: PtyRegistry) => reg.spawn({
    itemId: 'i1', agentId: 'claude-code', windowId: 1, cols: 80, rows: 24,
    agentSessionId: '11111111-2222-3333-4444-555555555555', resume: true,
  });

  it('leaves no live process behind when STOP is pressed', async () => {
    /*
     * The measured failure: two processes, one alive, zero map entries. The
     * dying resume relaunched from inside `kill`, registering a second pty
     * under the same id — which `kill`'s own delete then removed, leaving an
     * agent nobody can see or stop.
     */
    const reg = syncRegistry();
    const { sessionId } = await resuming(reg);
    reg.kill(sessionId, 1);
    expect(spawned.filter(s => !s.pty.killed)).toHaveLength(0);
  });

  it('leaves none behind when the window closes', async () => {
    const reg = syncRegistry();
    await resuming(reg);
    reg.killAllForWindow(1);
    expect(spawned.filter(s => !s.pty.killed)).toHaveLength(0);
  });

  it('leaves none behind when the app quits', async () => {
    const reg = syncRegistry();
    await resuming(reg);
    reg.killAll();
    expect(spawned.filter(s => !s.pty.killed)).toHaveLength(0);
  });
});
