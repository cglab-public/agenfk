// The child hub's sync worker (CGLAB-181, task 3).
//
// One tick: heartbeat, poll for directives, drain the outbox. The guarantee
// that matters more than any of them is that a child hub keeps serving its own
// users when the parent is unreachable — so the worker is built to fail
// quietly and retry, never to throw into the request path.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb } from '../db';
import type { HubDb } from '../db/types';
import { writeParentBinding, readParentBinding } from '../services/federation/parentBinding';
import {
  federationTick, enqueueOutbox, outboxDepth, backoffMsFor,
  MAX_FEDERATION_BACKOFF_MS, FEDERATION_TICK_MS,
} from '../services/federation/federationSync';

const SECRET = 'a'.repeat(64);
const binding = { parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1' };

/** Minimal transport double: records calls, returns whatever is queued. */
function transport(handlers: Partial<{
  ping: () => Promise<any>;
  directives: () => Promise<any>;
  deliver: (rows: any[]) => Promise<any>;
}> = {}) {
  const calls = { ping: 0, directives: 0, deliver: 0, delivered: [] as any[], headers: [] as any[] };
  return {
    calls,
    async ping(args: any) { calls.ping++; calls.headers.push(args); return handlers.ping ? handlers.ping() : { ok: true }; },
    async directives() { calls.directives++; return handlers.directives ? handlers.directives() : null; },
    async deliver(rows: any[]) { calls.deliver++; calls.delivered.push(...rows); return handlers.deliver ? handlers.deliver(rows) : { accepted: rows.length }; },
  };
}

let db: HubDb;
beforeEach(async () => { db = await openDb(':memory:'); });

describe('federationSync: no binding', () => {
  it('does nothing at all when the hub has no parent', async () => {
    const t = transport();
    const out = await federationTick({ db, secretKey: SECRET, transport: t as any });
    expect(out.skipped).toBe('no-binding');
    expect(t.calls.ping).toBe(0);
    expect(t.calls.directives).toBe(0);
  });
});

describe('federationSync: heartbeat', () => {
  it('pings the parent with its version and polls for directives', async () => {
    await writeParentBinding(db, SECRET, binding);
    const t = transport();
    const out = await federationTick({ db, secretKey: SECRET, transport: t as any, hubVersion: '1.2.3' });
    expect(t.calls.ping).toBe(1);
    expect(t.calls.directives).toBe(1);
    expect(t.calls.headers[0]).toMatchObject({ parentUrl: binding.parentUrl, token: binding.token, hubVersion: '1.2.3' });
    expect(out.ok).toBe(true);
    expect(out.skipped).toBeUndefined();
  });

  it('a directive kind it does not understand is ignored, not fatal', async () => {
    // Flow dispatch (CGLAB-182) and upgrades (CGLAB-183) add kinds later; a
    // child on an older build must not wedge when a newer parent sends one.
    await writeParentBinding(db, SECRET, binding);
    const t = transport({ directives: async () => ({ kind: 'from-the-future', id: 'd1' }) });
    const out = await federationTick({ db, secretKey: SECRET, transport: t as any });
    expect(out.ok).toBe(true);
    expect(out.unknownDirectiveKind).toBe('from-the-future');
  });
});

describe('federationSync: the parent being down is not the child going down', () => {
  it('reports failure without throwing', async () => {
    await writeParentBinding(db, SECRET, binding);
    const t = transport({ ping: async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); } });
    const out = await federationTick({ db, secretKey: SECRET, transport: t as any });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/ECONNREFUSED/);
  });

  it('keeps the binding so it resumes when the parent returns', async () => {
    await writeParentBinding(db, SECRET, binding);
    const down = transport({ ping: async () => { throw new Error('nope'); } });
    await federationTick({ db, secretKey: SECRET, transport: down as any });
    expect((await readParentBinding(db, SECRET))!.state).toBe('active');
    const up = transport();
    expect((await federationTick({ db, secretKey: SECRET, transport: up as any })).ok).toBe(true);
  });

  it('a 401 after detach stops the worker and records why, without deleting the binding', async () => {
    await writeParentBinding(db, SECRET, binding);
    const t = transport({ ping: async () => { throw Object.assign(new Error('unauthorised'), { response: { status: 401 } }); } });
    const out = await federationTick({ db, secretKey: SECRET, transport: t as any });
    expect(out.ok).toBe(false);
    expect(out.revoked).toBe(true);
    const b = await readParentBinding(db, SECRET);
    expect(b).not.toBeNull();
    expect(b!.state).toBe('revoked');
  });

  it('a revoked binding stops talking to the parent entirely', async () => {
    await writeParentBinding(db, SECRET, binding);
    const t = transport({ ping: async () => { throw Object.assign(new Error('gone'), { response: { status: 401 } }); } });
    await federationTick({ db, secretKey: SECRET, transport: t as any });
    const t2 = transport();
    const out = await federationTick({ db, secretKey: SECRET, transport: t2 as any });
    expect(out.skipped).toBe('revoked');
    expect(t2.calls.ping).toBe(0);
  });
});

describe('federationSync: outbox', () => {
  it('drains queued rows and removes only what the parent accepted', async () => {
    await writeParentBinding(db, SECRET, binding);
    await enqueueOutbox(db, 'event', { a: 1 });
    await enqueueOutbox(db, 'event', { a: 2 });
    expect(await outboxDepth(db)).toBe(2);
    const t = transport();
    const out = await federationTick({ db, secretKey: SECRET, transport: t as any });
    expect(out.delivered).toBe(2);
    expect(await outboxDepth(db)).toBe(0);
    expect(t.calls.delivered.map((r: any) => r.payload.a)).toEqual([1, 2]);
  });

  it('keeps rows and schedules a retry when delivery fails', async () => {
    await writeParentBinding(db, SECRET, binding);
    await enqueueOutbox(db, 'event', { a: 1 });
    const t = transport({ deliver: async () => { throw new Error('502'); } });
    const out = await federationTick({ db, secretKey: SECRET, transport: t as any });
    expect(out.ok).toBe(false);
    expect(await outboxDepth(db)).toBe(1);
    const row = await db.get<any>('SELECT attempts, next_attempt_at FROM federation_outbox LIMIT 1');
    expect(Number(row.attempts)).toBe(1);
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('does not re-send a row before its retry time', async () => {
    await writeParentBinding(db, SECRET, binding);
    await enqueueOutbox(db, 'event', { a: 1 });
    await federationTick({ db, secretKey: SECRET, transport: transport({ deliver: async () => { throw new Error('502'); } }) as any });
    const t = transport();
    const out = await federationTick({ db, secretKey: SECRET, transport: t as any });
    expect(t.calls.deliver).toBe(0);
    expect(out.delivered).toBe(0);
    expect(await outboxDepth(db)).toBe(1);
  });

  it('delivers in the order the rows were queued', async () => {
    await writeParentBinding(db, SECRET, binding);
    for (const n of [1, 2, 3, 4]) await enqueueOutbox(db, 'event', { n });
    const t = transport();
    await federationTick({ db, secretKey: SECRET, transport: t as any });
    expect(t.calls.delivered.map((r: any) => r.payload.n)).toEqual([1, 2, 3, 4]);
  });

  it('caps a single tick so a long outage cannot produce an unbounded request', async () => {
    await writeParentBinding(db, SECRET, binding);
    for (let i = 0; i < 600; i++) await enqueueOutbox(db, 'event', { i });
    const t = transport();
    const out = await federationTick({ db, secretKey: SECRET, transport: t as any, batchSize: 500 });
    expect(out.delivered).toBe(500);
    expect(await outboxDepth(db)).toBe(100);
  });

  it('queues while the parent is unreachable and drains once it returns', async () => {
    await writeParentBinding(db, SECRET, binding);
    await enqueueOutbox(db, 'event', { a: 1 });
    await federationTick({ db, secretKey: SECRET, transport: transport({ deliver: async () => { throw new Error('down'); } }) as any });
    await enqueueOutbox(db, 'event', { a: 2 });
    expect(await outboxDepth(db)).toBe(2);
    // past the retry window
    await db.run("UPDATE federation_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z'");
    const t = transport();
    const out = await federationTick({ db, secretKey: SECRET, transport: t as any });
    expect(out.delivered).toBe(2);
    expect(await outboxDepth(db)).toBe(0);
  });

  it('nothing is queued at all when the hub has no parent', async () => {
    await enqueueOutbox(db, 'event', { a: 1 });
    expect(await outboxDepth(db)).toBe(0);
  });
});

describe('federationSync: backoff', () => {
  it('grows exponentially from the tick interval and is capped', () => {
    expect(backoffMsFor(0)).toBe(FEDERATION_TICK_MS);
    expect(backoffMsFor(1)).toBe(FEDERATION_TICK_MS * 2);
    expect(backoffMsFor(3)).toBe(FEDERATION_TICK_MS * 8);
    expect(backoffMsFor(99)).toBe(MAX_FEDERATION_BACKOFF_MS);
    expect(backoffMsFor(99)).toBeLessThanOrEqual(MAX_FEDERATION_BACKOFF_MS);
  });

  it('treats 408, 425 and 429 as come-back-later rather than as a revocation', async () => {
    for (const status of [408, 425, 429]) {
      const fresh = await openDb(':memory:');
      await writeParentBinding(fresh, SECRET, binding);
      const t = transport({ ping: async () => { throw Object.assign(new Error('later'), { response: { status } }); } });
      const out = await federationTick({ db: fresh, secretKey: SECRET, transport: t as any });
      expect(out.ok).toBe(false);
      expect(out.revoked).toBeFalsy();
      expect((await readParentBinding(fresh, SECRET))!.state).toBe('active');
      await fresh.close();
    }
  });
});
