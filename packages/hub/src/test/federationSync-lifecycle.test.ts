// Worker lifecycle (CGLAB-181, task 3). The guarantee under test is that a
// hub's own request handling is never hostage to its parent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDb } from '../db';
import type { HubDb } from '../db/types';
import { writeParentBinding } from '../services/federation/parentBinding';
import { startFederationSync, FEDERATION_TICK_MS } from '../services/federation/federationSync';

const SECRET = 'a'.repeat(64);
const binding = { parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1' };

let db: HubDb;
beforeEach(async () => { db = await openDb(':memory:'); vi.useFakeTimers(); });
afterEach(async () => { vi.useRealTimers(); await db.close(); });

const idleTransport = (impl: Partial<any> = {}) => ({
  ping: impl.ping ?? (async () => ({ ok: true })),
  directives: impl.directives ?? (async () => null),
  deliver: impl.deliver ?? (async () => ({})),
});

describe('startFederationSync', () => {
  it('stops ticking once stopped', async () => {
    await writeParentBinding(db, SECRET, binding);
    let pings = 0;
    const stop = startFederationSync({
      db, secretKey: SECRET, transport: idleTransport({ ping: async () => { pings++; return {}; } }) as any,
    });
    await vi.advanceTimersByTimeAsync(FEDERATION_TICK_MS);
    expect(pings).toBe(1);
    stop();
    await vi.advanceTimersByTimeAsync(FEDERATION_TICK_MS * 3);
    expect(pings).toBe(1);
  });

  it('does not let ticks overlap when the parent is slow', async () => {
    await writeParentBinding(db, SECRET, binding);
    let started = 0;
    let release: (() => void) | null = null;
    const stop = startFederationSync({
      db, secretKey: SECRET,
      transport: idleTransport({
        ping: async () => { started++; await new Promise<void>(r => { release = r; }); return {}; },
      }) as any,
    });
    await vi.advanceTimersByTimeAsync(FEDERATION_TICK_MS * 4);
    // four intervals elapsed, but the first call never returned
    expect(started).toBe(1);
    release?.();
    stop();
  });

  it('a throwing transport does not escape the worker', async () => {
    await writeParentBinding(db, SECRET, binding);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = startFederationSync({
      db, secretKey: SECRET,
      transport: idleTransport({ ping: async () => { throw new Error('parent on fire'); } }) as any,
    });
    await expect(vi.advanceTimersByTimeAsync(FEDERATION_TICK_MS * 2)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    stop();
  });

  it('is a no-op on a hub with no parent, so a standalone hub needs no opt-out', async () => {
    let touched = 0;
    const stop = startFederationSync({
      db, secretKey: SECRET,
      transport: idleTransport({ ping: async () => { touched++; return {}; } }) as any,
    });
    await vi.advanceTimersByTimeAsync(FEDERATION_TICK_MS * 3);
    expect(touched).toBe(0);
    stop();
  });
});
