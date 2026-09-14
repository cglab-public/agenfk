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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerPtyIpc, senderWindowId } from '../main/ptyIpc';
import { PtyRegistry } from '../main/ptyRegistry';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

let handlers: Record<string, Handler>;
let registry: PtyRegistry;
let spawnCalls: Array<Record<string, unknown>>;

const fakeEvent = (windowId: number) => ({ sender: { id: windowId } });

beforeEach(() => {
  handlers = {};
  spawnCalls = [];
  registry = {
    spawn: vi.fn(async (req: Record<string, unknown>) => { spawnCalls.push(req); return 'session-1'; }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  } as unknown as PtyRegistry;
  registerPtyIpc(registry, {
    handle: (channel, listener) => {
      // Electron's own ipcMain.handle turns a synchronous throw inside a
      // handler into a rejected invoke on the renderer side. Mimic that, or
      // the tests would be asserting against a harness that behaves
      // differently from production for exactly the inputs they care about.
      handlers[channel] = (event, ...args) => Promise.resolve().then(() => (listener as Handler)(event, ...args));
    },
  });
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

  it('treats auto-approve as strictly boolean true', async () => {
    // It disables the agent's own safety prompts. A stray truthy value from a
    // renderer bug — a string, a 1, an object — must not be enough to turn the
    // rails off.
    await spawn({ itemId: 'i1', agentId: 'claude-code', cols: 80, rows: 24, autoApprove: 'yes' });
    expect(spawnCalls[0].autoApprove).toBe(false);
    await spawn({ itemId: 'i1', agentId: 'claude-code', cols: 80, rows: 24, autoApprove: 1 });
    expect(spawnCalls[1].autoApprove).toBe(false);
    await spawn({ itemId: 'i1', agentId: 'claude-code', cols: 80, rows: 24, autoApprove: true });
    expect(spawnCalls[2].autoApprove).toBe(true);
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
      'pty:kill',
      'pty:resize',
      'pty:spawn',
      'pty:write',
    ].sort());
  });
});
