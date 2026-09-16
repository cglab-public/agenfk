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
  it('never holds the process open', async () => {
    // A background sync must not be the reason a hub refuses to exit.
    const timers: any[] = [];
    const realSet = global.setInterval;
    (global as any).setInterval = ((...a: any[]) => { const t = (realSet as any)(...a); timers.push(t); return t; }) as any;
    const stop = startFederationSync({ db, secretKey: SECRET, transport: idleTransport() as any });
    (global as any).setInterval = realSet;
    expect(timers).toHaveLength(1);
    expect(timers[0].hasRef()).toBe(false);
    stop();
  });

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

describe('the hub app owns its workers', () => {
  it('stops ticking once stopWorkers is called, and ticks on without it', async () => {
    const { createHubApp } = await import('../server');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Contrast case first: workers left running after the DB closes DO complain,
    // which is exactly the noise (and the dead-handle access) the handle prevents.
    // A fake transport, because the worker refuses to build a real one under a
    // test runner. What is under test is the worker's LIFECYCLE, not its
    // transport, and an injected fake still ticks — so the guarantee is
    // unchanged: a tick against a closed DB must complain.
    const leaky = await createHubApp({
      dbPath: ':memory:', secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org',
      federationTransport: idleTransport(),
    } as any);
    await writeParentBinding(leaky.ctx.db, SECRET, binding);
    await leaky.ctx.db.close();
    await vi.advanceTimersByTimeAsync(FEDERATION_TICK_MS * 2);
    // Count only OUR warnings: createHubApp also warns when hub-ui/dist is
    // absent, which made this pass without federation ticking at all and made
    // the clean case below fail on a tree that had not built the SPA.
    const fedWarnings = (spy: typeof warn) =>
      spy.mock.calls.filter(c => String(c[0] ?? '').includes('[FEDERATION]')).length;
    expect(fedWarnings(warn)).toBeGreaterThan(0);
    leaky.ctx.stopWorkers!();

    warn.mockClear();
    const clean = await createHubApp({
      dbPath: ':memory:', secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org',
      federationTransport: idleTransport(),
    } as any);
    expect(typeof clean.ctx.stopWorkers).toBe('function');
    await writeParentBinding(clean.ctx.db, SECRET, binding);
    clean.ctx.stopWorkers!();
    await clean.ctx.db.close();
    await vi.advanceTimersByTimeAsync(FEDERATION_TICK_MS * 2);
    expect(fedWarnings(warn)).toBe(0);

    warn.mockRestore();
  });

  it('stops the rollup timer too, not just the federation worker', async () => {
    // "workers", plural. A handle that stopped only one of them still passed
    // the test above, because the rollup timer logs via console.error on a
    // five-minute cadence the test never reached.
    const { createHubApp } = await import('../server');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await createHubApp({
      dbPath: ':memory:', secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org',
    });
    app.ctx.stopWorkers!();
    await app.ctx.db.close();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(err.mock.calls.filter(c => String(c[0] ?? '').includes('[ROLLUP]'))).toHaveLength(0);
    err.mockRestore();
  });
});
