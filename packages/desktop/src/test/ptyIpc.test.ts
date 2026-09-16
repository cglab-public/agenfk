/**
 * @vitest-environment node
 *
 * CGLAB-169: the IPC border.
 *
 * `ipcMain.handle` delivers whatever the renderer serialised — objects where
 * strings were expected, `undefined`, numbers, nothing at all. Every handler
 * has to treat its arguments as hostile input, because in the case this border
 * exists for (an XSS in the renderer bundle) they are.
 *
 * The load-bearing assertion in this file is that the window id comes from the
 * EVENT and never from the payload. Ownership in PtyRegistry is worthless if a
 * caller can simply claim to be a different window.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerPtyIpc, senderWindowId } from '../main/ptyIpc';
import { PtyRegistry } from '../main/ptyRegistry';
import { HIGH_WATERMARK } from '../main/flowControl';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

let handlers: Record<string, Handler>;
let prefsDir: string;
let registry: PtyRegistry;
let spawnCalls: Array<Record<string, unknown>>;

const fakeEvent = (windowId: number) => ({ sender: { id: windowId } });

beforeEach(() => {
  handlers = {};
  spawnCalls = [];
  // A real directory: prefs are a file on disk, and a fake would let a bug in
  // the read/write path pass unnoticed here and fail in the app.
  prefsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-ipc-prefs-'));
  registry = {
    spawn: vi.fn(async (req: Record<string, unknown>) => { spawnCalls.push(req); return 'session-1'; }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    ack: vi.fn(),
  } as unknown as PtyRegistry;
  registerPtyIpc(registry, {
    handle: (channel, listener) => {
      // Electron's own ipcMain.handle turns a synchronous throw inside a
      // handler into a rejected invoke on the renderer side. Mimic that, or
      // the tests would be asserting against a harness that behaves
      // differently from production for exactly the inputs they care about.
      handlers[channel] = (event, ...args) => Promise.resolve().then(() => (listener as Handler)(event, ...args));
    },
  }, () => ({ available: false }), () => prefsDir);
});

describe('the window id is taken from the sender, never the payload', () => {
  it('attributes a spawn to the window that sent it', async () => {
    await handlers['pty:spawn'](fakeEvent(7), { itemId: 'i1', agentId: 'claude-code', cols: 80, rows: 24 });
    expect(spawnCalls[0].windowId).toBe(7);
  });

  it('ignores a windowId the renderer puts in the payload', async () => {
    // The attack ownership exists to stop: claim to be window 1 and write into
    // its shell. The payload value must be inert.
    await handlers['pty:spawn'](fakeEvent(7), { itemId: 'i1', agentId: 'claude-code', cols: 80, rows: 24, windowId: 1 });
    expect(spawnCalls[0].windowId).toBe(7);
  });

  it('passes the sender window to write, resize and kill', async () => {
    await handlers['pty:write'](fakeEvent(9), { sessionId: 's', data: 'x', windowId: 1 });
    await handlers['pty:resize'](fakeEvent(9), { sessionId: 's', cols: 80, rows: 24, windowId: 1 });
    await handlers['pty:kill'](fakeEvent(9), { sessionId: 's', windowId: 1 });
    expect(registry.write).toHaveBeenCalledWith('s', 9, 'x');
    expect(registry.resize).toHaveBeenCalledWith('s', 9, 80, 24);
    expect(registry.kill).toHaveBeenCalledWith('s', 9);
  });

  it('reads the id straight off the event sender', () => {
    expect(senderWindowId({ sender: { id: 42 } })).toBe(42);
  });
});

describe('arguments are validated before anything is done with them', () => {
  const spawn = (payload: unknown) => handlers['pty:spawn'](fakeEvent(1), payload);

  it('rejects a missing payload entirely', async () => {
    await expect(spawn(undefined)).rejects.toThrow();
    expect(registry.spawn).not.toHaveBeenCalled();
  });

  it('rejects a non-string itemId', async () => {
    await expect(spawn({ itemId: { toString: () => 'x' }, agentId: 'claude-code', cols: 80, rows: 24 })).rejects.toThrow(/itemId/);
    await expect(spawn({ itemId: 42, agentId: 'claude-code', cols: 80, rows: 24 })).rejects.toThrow(/itemId/);
    await expect(spawn({ itemId: '', agentId: 'claude-code', cols: 80, rows: 24 })).rejects.toThrow(/itemId/);
  });

  it('rejects a missing agentId rather than picking a default', async () => {
    // Silently defaulting would launch an agent the user did not choose.
    await expect(spawn({ itemId: 'i1', cols: 80, rows: 24 })).rejects.toThrow(/agentId/);
  });

  it('ignores auto-approve in the payload, whatever shape it arrives in', async () => {
    // This used to assert that only a literal `true` counted, which guarded the
    // TYPE of a value whose SOURCE was the problem. The payload is not
    // consulted at all now: the stored preference in the main process decides,
    // so no value a renderer can put here changes what the agent is allowed to
    // do. See the "auto-approve is decided by main" block below.
    for (const asked of ['yes', 1, {}, true, false]) {
      spawnCalls.length = 0;
      await spawn({ itemId: 'i1', agentId: 'claude-code', cols: 80, rows: 24, autoApprove: asked });
      expect(spawnCalls[0].autoApprove).toBe(false);
    }
  });

  it('defaults auto-approve to off when it is not mentioned', async () => {
    await spawn({ itemId: 'i1', agentId: 'claude-code', cols: 80, rows: 24 });
    expect(spawnCalls[0].autoApprove).toBe(false);
  });

  it('rejects sizes that are not sane terminal dimensions', async () => {
    // These reach ioctl. Negative, zero, fractional and absurd values are at
    // best a broken terminal.
    for (const bad of [0, -1, 1.5, 99999, '80', null, undefined]) {
      await expect(spawn({ itemId: 'i1', agentId: 'claude-code', cols: bad, rows: 24 })).rejects.toThrow(/cols/);
    }
    await expect(spawn({ itemId: 'i1', agentId: 'claude-code', cols: 80, rows: -3 })).rejects.toThrow(/rows/);
  });

  it('never lets a bad argument reach the registry', async () => {
    await expect(spawn({ itemId: 'i1', agentId: 'claude-code', cols: -1, rows: 24 })).rejects.toThrow();
    await expect(handlers['pty:write'](fakeEvent(1), { sessionId: 's' })).rejects.toThrow(/data/);
    expect(registry.spawn).not.toHaveBeenCalled();
    expect(registry.write).not.toHaveBeenCalled();
  });
});

describe('the channels that exist', () => {
  it('exposes exactly the terminal and agent channels, and nothing generic', () => {
    // The failure this guards: a `pty:exec` or a pass-through `invoke` added
    // later "for convenience" would hand the renderer arbitrary execution.
    expect(Object.keys(handlers).sort()).toEqual([
      'agents:list',
      'agents:refresh',
      // Read-only, takes no renderer input: whether sessions survive quitting,
      // and why not when they do not.
      'sessions:persistence',
      // The renderer reporting what it has drawn. It is the return path of the
      // flow control in flowControl.ts, and it carries a NUMBER rather than
      // anything that becomes a command — see the clamp in the handler.
      'pty:ack',
      'pty:kill',
      'pty:resize',
      'pty:spawn',
      'pty:write',
      // Desktop-owned preferences, closed key list. Here rather than on the
      // server's /settings because that route is unauthenticated and this one
      // carries autoApprove, which changes the argv of every agent spawned
      // afterwards.
      'prefs:get',
      'prefs:set',
      // Opening a worktree in an editor. The renderer names a CARD and an
      // editor ID, never a path and never a URL.
      'editors:list',
      'editors:open',
      /*
       * The notification sound. Note that not one of these takes a path:
       * `choose` opens the OS picker in this process and the other three act on
       * whatever it stored, so there is nothing for a renderer to supply and
       * nothing for it to point at. The same rule `pty:spawn` follows about
       * directories and commands.
       */
      'sounds:choose',
      'sounds:clear',
      'sounds:current',
      'sounds:read',
      // Asking for an OS banner. The renderer asks; this process decides,
      // because only it can see whether the window is actually in front.
      'notifications:attention',
    ].sort());
  });
});

afterEach(() => { fs.rmSync(prefsDir, { recursive: true, force: true }); });

describe('prefs over IPC', () => {
  it('refuses a key outside the closed list', async () => {
    // A "save this object" surface into a file the main process trusts is the
    // shape this deliberately is not.
    await expect(handlers['prefs:set']({} as never, { key: 'somethingElse', value: true }))
      .rejects.toThrow(/unknown preference/i);
  });

  it('treats anything that is not exactly true as false', async () => {
    // Same rule as pty:spawn's autoApprove: this switch takes an agent's
    // safety prompts away, so a truthy string must not be enough.
    for (const truthy of ['true', 1, {}, []]) {
      const result = await handlers['prefs:set']({} as never, { key: 'autoApprove', value: truthy });
      expect(result.autoApprove).toBe(false);
    }
  });

  it('round-trips a real boolean', async () => {
    await handlers['prefs:set']({} as never, { key: 'autoApprove', value: true });
    expect((await handlers['prefs:get']({} as never, undefined)).autoApprove).toBe(true);
  });
});

/**
 * Where auto-approve actually comes from.
 *
 * The preference was moved into the main process on the argument that the
 * server's settings route is unauthenticated and this value changes the argv of
 * every agent spawned afterwards. An adversarial review then pointed out the
 * obvious hole: the spawn handler still took `autoApprove` from the RENDERER's
 * payload and never read the stored preference at all. The border was drawn and
 * then not used, which is worse than not drawing it — the code reads as
 * protected.
 */
describe('auto-approve is decided by main, not by the caller', () => {
  it('ignores an autoApprove the renderer asks for', async () => {
    // The whole point. An XSS in the renderer, or any bug that puts `true` in
    // this payload, must not be able to take an agent's safety prompts away.
    await handlers['pty:spawn']({ sender: { id: 1 } } as never, {
      itemId: 'i1', agentId: 'shell', cols: 80, rows: 24, autoApprove: true,
    });
    expect(spawnCalls[0].autoApprove).toBe(false);
  });

  it('uses the stored preference when it is on', async () => {
    await handlers['prefs:set']({} as never, { key: 'autoApprove', value: true });
    await handlers['pty:spawn']({ sender: { id: 1 } } as never, {
      itemId: 'i1', agentId: 'shell', cols: 80, rows: 24,
    });
    expect(spawnCalls[0].autoApprove).toBe(true);
  });

  it('uses the stored preference even when the renderer asks for the opposite', async () => {
    // Symmetry matters: if the renderer could turn it OFF, a compromised one
    // could hide that it is on. Main is the only authority either way.
    await handlers['prefs:set']({} as never, { key: 'autoApprove', value: true });
    await handlers['pty:spawn']({ sender: { id: 1 } } as never, {
      itemId: 'i1', agentId: 'shell', cols: 80, rows: 24, autoApprove: false,
    });
    expect(spawnCalls[0].autoApprove).toBe(true);
  });
});

/**
 * The ack is renderer input like any other (review follow-up).
 *
 * It carries a number rather than anything that becomes a command, which is
 * why it is allowed to exist at all — but the number decides whether
 * backpressure keeps working. This module's own header threat-models an XSS in
 * the renderer bundle, and under that threat an unbounded ack is a one-call
 * switch for turning the 50 MB ceiling back on.
 */
describe('the ack from the renderer', () => {
  const ack = (bytes: unknown) => handlers['pty:ack'](fakeEvent(1), { sessionId: 's1', bytes });

  it('refuses an enormous count', async () => {
    // The gap the guard's own comment claimed to cover and did not. Main stops
    // reading past the high mark, so nothing larger can ever be honest.
    await ack(1e15);
    const [, , bytes] = vi.mocked(registry.ack).mock.calls.at(-1)!;
    expect(bytes).toBeLessThanOrEqual(HIGH_WATERMARK * 2);
  });

  it('refuses a negative count', async () => {
    await ack(-5_000);
    expect(vi.mocked(registry.ack).mock.calls.at(-1)![2]).toBe(0);
  });

  it('treats a non-number as nothing drawn', async () => {
    for (const junk of ['1000', null, undefined, NaN, Infinity, {}]) {
      await ack(junk);
      expect(vi.mocked(registry.ack).mock.calls.at(-1)![2], String(junk)).toBe(0);
    }
  });

  it('passes an ordinary count straight through', async () => {
    // The guard must not be so keen that it breaks the feature.
    await ack(4_096);
    expect(vi.mocked(registry.ack).mock.calls.at(-1)![2]).toBe(4_096);
  });
});
