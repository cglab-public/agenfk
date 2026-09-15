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
  MAX_FEDERATION_BACKOFF_MS, FEDERATION_TICK_MS, MAX_ROW_REJECTIONS, MAX_OUTBOX_ROWS,
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

  it('adopts the identity policy the parent hands back, and keeps it between ticks', async () => {
    await writeParentBinding(db, SECRET, binding);
    expect((await readParentBinding(db, SECRET))!.identityPolicy).toBe('keep');

    const told = (policy: unknown) => transport({ ping: async () => ({ ok: true, identityPolicy: policy }) });
    await federationTick({ db, secretKey: SECRET, transport: told('pseudonymize') as any });
    expect((await readParentBinding(db, SECRET))!.identityPolicy).toBe('pseudonymize');

    // a parent that says nothing must not silently reset it
    await federationTick({ db, secretKey: SECRET, transport: transport() as any });
    expect((await readParentBinding(db, SECRET))!.identityPolicy).toBe('pseudonymize');

    // nor must a value we do not recognise
    await federationTick({ db, secretKey: SECRET, transport: told('anonymous-ish') as any });
    expect((await readParentBinding(db, SECRET))!.identityPolicy).toBe('pseudonymize');

    // and it switches back when the parent says so
    await federationTick({ db, secretKey: SECRET, transport: told('keep') as any });
    expect((await readParentBinding(db, SECRET))!.identityPolicy).toBe('keep');
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

  it('discards a refused row only after repeated individual refusals', async () => {
    // A 400 means these bytes will never be accepted, but discarding on the
    // first refusal lets a parent that answers 400 to everything empty the
    // queue in one tick. Three refusals of the row ON ITS OWN is the bar.
    await writeParentBinding(db, SECRET, binding);
    await enqueueOutbox(db, 'event', { bad: true });
    const reject = () => transport({ deliver: async () => { throw Object.assign(new Error('malformed'), { response: { status: 400 } }); } });

    for (let i = 0; i < MAX_ROW_REJECTIONS - 1; i++) {
      const out = await federationTick({ db, secretKey: SECRET, transport: reject() as any });
      expect(out.dropped).toBeFalsy();
      expect(await outboxDepth(db)).toBe(1);
      await db.run("UPDATE federation_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z'");
    }
    const final = await federationTick({ db, secretKey: SECRET, transport: reject() as any });
    expect(final.dropped).toBe(1);
    expect(await outboxDepth(db)).toBe(0);
  });

  it('isolates the refused row instead of taking the whole batch with it', async () => {
    // The batch used to be deleted wholesale, so one bad row destroyed up to
    // 499 good ones.
    await writeParentBinding(db, SECRET, binding);
    for (const n of [1, 2, 3, 4, 5, 6]) await enqueueOutbox(db, 'event', { n });
    const t = transport({
      deliver: async (rows: any[]) => {
        if (rows.some((r: any) => r.payload.n === 4)) throw Object.assign(new Error('bad'), { response: { status: 400 } });
        return { accepted: rows.length };
      },
    });
    const out = await federationTick({ db, secretKey: SECRET, transport: t as any });
    // the five innocent rows went through; the sixth is still queued, counted
    expect(out.delivered).toBe(5);
    expect(await outboxDepth(db)).toBe(1);
    const left = await db.get<any>('SELECT payload, rejections FROM federation_outbox');
    expect(JSON.parse(left.payload).n).toBe(4);
    expect(Number(left.rejections)).toBe(1);
  });

  it('a 401 on delivery revokes the binding rather than discarding the outbox', async () => {
    // Falling through to the discard path here deleted a child's queued data
    // against a parent that had already detached it.
    await writeParentBinding(db, SECRET, binding);
    await enqueueOutbox(db, 'event', { a: 1 });
    const t = transport({ deliver: async () => { throw Object.assign(new Error('gone'), { response: { status: 401 } }); } });
    const out = await federationTick({ db, secretKey: SECRET, transport: t as any });
    expect(out.revoked).toBe(true);
    expect(out.dropped).toBeFalsy();
    expect(await outboxDepth(db)).toBe(1);
    expect((await readParentBinding(db, SECRET))!.state).toBe('revoked');
  });

  it('a 403 is treated as revocation too', async () => {
    await writeParentBinding(db, SECRET, binding);
    const t = transport({ ping: async () => { throw Object.assign(new Error('forbidden'), { response: { status: 403 } }); } });
    const out = await federationTick({ db, secretKey: SECRET, transport: t as any });
    expect(out.revoked).toBe(true);
    expect((await readParentBinding(db, SECRET))!.state).toBe('revoked');
  });

  it('a 401 while polling directives revokes rather than failing silently', async () => {
    await writeParentBinding(db, SECRET, binding);
    const t = transport({ directives: async () => { throw Object.assign(new Error('gone'), { response: { status: 401 } }); } });
    const out = await federationTick({ db, secretKey: SECRET, transport: t as any });
    expect(out.revoked).toBe(true);
    expect((await readParentBinding(db, SECRET))!.state).toBe('revoked');
  });

  it('stops queueing once the binding is revoked, so the table cannot grow forever', async () => {
    await writeParentBinding(db, SECRET, binding);
    await federationTick({
      db, secretKey: SECRET,
      transport: transport({ ping: async () => { throw Object.assign(new Error('gone'), { response: { status: 401 } }); } }) as any,
    });
    expect(await enqueueOutbox(db, 'event', { a: 1 })).toBe(false);
    expect(await outboxDepth(db)).toBe(0);
  });

  it('never throws out of the request path on a payload it cannot serialise', async () => {
    await writeParentBinding(db, SECRET, binding);
    const circular: any = {}; circular.self = circular;
    await expect(enqueueOutbox(db, 'event', circular)).resolves.toBe(false);
    await expect(enqueueOutbox(db, 'event', { big: 1n } as any)).resolves.toBe(false);
    await expect(enqueueOutbox(db, 'event', undefined)).resolves.toBe(false);
    expect(await outboxDepth(db)).toBe(0);
    // and a good payload still queues, so the guard is not refusing everything
    expect(await enqueueOutbox(db, 'event', { fine: true })).toBe(true);
  });

  it('schedules the first retry one tick out, not two', async () => {
    await writeParentBinding(db, SECRET, binding);
    await enqueueOutbox(db, 'event', { a: 1 });
    const before = Date.now();
    await federationTick({ db, secretKey: SECRET, transport: transport({ deliver: async () => { throw new Error('502'); } }) as any });
    const row = await db.get<any>('SELECT attempts, next_attempt_at FROM federation_outbox');
    expect(Number(row.attempts)).toBe(1);
    const waited = new Date(row.next_attempt_at).getTime() - before;
    // backoffMsFor(0), not backoffMsFor(1)
    expect(waited).toBeGreaterThanOrEqual(FEDERATION_TICK_MS - 1000);
    expect(waited).toBeLessThan(FEDERATION_TICK_MS * 2);
  });

  it('retries rather than drops on 408, 425 and 429', async () => {
    for (const status of [408, 425, 429]) {
      const fresh = await openDb(':memory:');
      await writeParentBinding(fresh, SECRET, binding);
      await enqueueOutbox(fresh, 'event', { a: 1 });
      const t = transport({ deliver: async () => { throw Object.assign(new Error('later'), { response: { status } }); } });
      const out = await federationTick({ db: fresh, secretKey: SECRET, transport: t as any });
      expect(out.dropped).toBeUndefined();
      expect(await outboxDepth(fresh)).toBe(1);
      await fresh.close();
    }
  });

  it('a 5xx retries, since the parent may simply be having a bad day', async () => {
    await writeParentBinding(db, SECRET, binding);
    await enqueueOutbox(db, 'event', { a: 1 });
    const t = transport({ deliver: async () => { throw Object.assign(new Error('bang'), { response: { status: 503 } }); } });
    const out = await federationTick({ db, secretKey: SECRET, transport: t as any });
    expect(out.dropped).toBeUndefined();
    expect(await outboxDepth(db)).toBe(1);
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
    expect(backoffMsFor(2)).toBe(FEDERATION_TICK_MS * 4);
    // 2^3 would be 8 minutes, so the cap is what answers here
    expect(backoffMsFor(3)).toBe(MAX_FEDERATION_BACKOFF_MS);
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
