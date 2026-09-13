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
import { PtyRegistry } from '../main/ptyRegistry';

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
    };
    pty.emitData = d => dataCb(d);
    pty.emitExit = code => exitCb({ exitCode: code });
    spawned.push({ file, args, cwd: opts.cwd, pty });
    return pty;
  });

const open = async (registry: PtyRegistry, windowId: number, itemId = 'i1') =>
  registry.spawn({ itemId, agentId: 'shell', windowId, cols: 80, rows: 24 });

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
