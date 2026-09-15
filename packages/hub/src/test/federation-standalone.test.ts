// The standalone guarantee (CGLAB-185, task 1).
//
// This is the promise the whole federation design rests on: joining a group
// must NEVER make a hub depend on its parent to serve its own people. A parent
// that is down, slow, misconfigured, hostile, or gone must be invisible to a
// developer of the child hub.
//
// So this suite is deliberately written as a trap rather than a description.
// The transport throws on every call — the worst-case parent — and every local
// route is then exercised. If someone later makes an ingest path, a query, or
// an admin route await the parent, these go red.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';
import {
  writeParentBinding, readParentBinding, clearParentBinding,
} from '../services/federation/parentBinding';
import { federationTick, outboxDepth } from '../services/federation/federationSync';

const SECRET = 'a'.repeat(64);
const ORG = 'org';
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-standalone-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

/** A parent that is simply not there, on every call it could receive. */
const deadParent = () => ({
  async ping() { throw new Error('ECONNREFUSED'); },
  async directives() { throw new Error('ECONNREFUSED'); },
  async deliver() { throw new Error('ECONNREFUSED'); },
});

/** A parent that answers, but with a refusal. Worse than absent: it replies. */
const hostileParent = () => {
  const boom = () => {
    const err: any = new Error('go away');
    err.response = { status: 500, data: { error: 'go away' } };
    throw err;
  };
  return { async ping() { boom(); }, async directives() { boom(); }, async deliver(): Promise<any> { boom(); } };
};

describe('a child hub whose parent is unreachable', () => {
  let app: any;
  let ctx: any;
  let cookie: string;
  let key: string;

  const event = (id: string) => ({
    events: [{
      eventId: id,
      orgId: ORG,
      installationId: 'inst-1',
      type: 'item.closed',
      occurredAt: new Date().toISOString(),
      userKey: 'dev@acme.com',
      actor: { osUser: 'dev', gitEmail: 'dev@acme.com' },
      itemId: `item-${id}`,
      itemType: 'TASK',
      payload: {},
    }],
  });

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: ORG,
      releaseExists: async () => true,
    } as any);
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, ORG, 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login')
      .send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    key = await issueApiKey(ctx.db, ORG, 'local');
    // Bound to a parent that will never answer.
    await writeParentBinding(ctx.db, SECRET, {
      parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1',
    });
  });

  afterEach(async () => {
    ctx.stopWorkers?.();
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  it('still accepts its own developers\' events', async () => {
    const r = await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${key}`).send(event('e1'));
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(1);
  });

  it('still answers every query the board reads', async () => {
    for (const id of ['e1', 'e2']) {
      expect((await supertest(app).post('/v1/events')
        .set('Authorization', `Bearer ${key}`).send(event(id))).body.ingested).toBe(1);
    }
    for (const route of [
      '/v1/users', '/v1/timeline', '/v1/metrics', '/v1/event-types',
      '/v1/projects', '/v1/item-types', '/v1/histogram', '/v1/prs/overview',
      '/v1/child-hubs', '/v1/admin/federation',
    ]) {
      const r = await supertest(app).get(route).set('Cookie', cookie);
      expect(r.status, route).toBe(200);
    }

    // Status codes alone are near-unconditional here: none of these routes
    // talks to a parent, so they answer 200 whatever the federation state is.
    // The regression that would actually hurt is a QUERY change that drops
    // this hub's own rows — an inner join onto a federation table, say — and
    // that returns 200 with nothing in it. So assert the data.
    const users = await supertest(app).get('/v1/users').set('Cookie', cookie);
    expect(users.body).toHaveLength(1);
    expect(Number(users.body[0].events_count)).toBe(2);

    const timeline = await supertest(app).get('/v1/timeline').set('Cookie', cookie);
    expect(timeline.body.events.map((e: any) => e.event_id).sort()).toEqual(['e1', 'e2']);

    const types = await supertest(app).get('/v1/event-types').set('Cookie', cookie);
    expect(JSON.stringify(types.body)).toContain('item.closed');
  });

  it('still serves its own admin surface', async () => {
    for (const route of [
      '/v1/admin/installations', '/v1/admin/api-keys', '/v1/admin/users',
      '/v1/admin/flows', '/v1/admin/flow-assignments', '/v1/admin/upgrade',
      '/v1/admin/flow-dispatches', '/v1/admin/upgrade-dispatches',
      // The only admin route on this list that reads the parent binding at
      // all, and therefore the only one that could couple the admin surface
      // to the group relationship.
      '/v1/admin/federation',
    ]) {
      const r = await supertest(app).get(route).set('Cookie', cookie);
      expect(r.status, route).toBe(200);
    }
  });

  it('still lets an admin create and assign a flow of its own', async () => {
    const created = await supertest(app).post('/v1/admin/flows').set('Cookie', cookie).send({
      definition: { name: 'Ours', steps: [{ id: 's0', name: 'TODO', order: 0 }] },
    });
    expect(created.status).toBe(201);
    const assigned = await supertest(app).put('/v1/admin/flow-assignments')
      .set('Cookie', cookie).send({ scope: 'org', flowId: created.body.id });
    expect(assigned.status).toBe(200);
  });

  it('still lets an admin upgrade its own fleet', async () => {
    const now = new Date().toISOString();
    await ctx.db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, git_email, agenfk_version)
       VALUES ('i1', ?, ?, ?, 'i1@acme.com', '1.0.0')`, [ORG, now, now],
    );
    const r = await supertest(app).post('/v1/admin/upgrade')
      .set('Cookie', cookie).send({ targetVersion: '1.2.3', scope: { type: 'all' } });
    expect(r.status).toBe(201);
  });

  it('reports the parent as unreachable rather than throwing', async () => {
    // The tick must report failure as a VALUE. A throw here would take the
    // worker — and every boot that starts it — down with it.
    const out = await federationTick({
      db: ctx.db, secretKey: SECRET, orgId: ORG, transport: deadParent(),
    } as any);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/ECONNREFUSED/);
  });

  it('is equally unbothered by a parent that answers with a refusal', async () => {
    const out = await federationTick({
      db: ctx.db, secretKey: SECRET, orgId: ORG, transport: hostileParent(),
    } as any);
    expect(out.ok).toBe(false);
    // A 500 is NOT a revocation: the binding survives, because a broken parent
    // must not be able to eject its children by being broken.
    expect(out.revoked).toBeFalsy();
    expect((await readParentBinding(ctx.db, SECRET))!.state).toBe('active');
  });

  it('keeps what it could not send, and loses none of it', async () => {
    for (const id of ['e1', 'e2', 'e3']) {
      expect((await supertest(app).post('/v1/events')
        .set('Authorization', `Bearer ${key}`).send(event(id))).body.ingested).toBe(1);
    }
    // Exactly three, not merely "some": a baseline of toBeGreaterThan(0) would
    // survive ingest silently dropping two of them.
    expect(await outboxDepth(ctx.db)).toBe(3);

    // A parent that is unreachable at the PING never reaches the outbox at
    // all — the tick gives up first — so this pins the cheap half of the
    // property. The half that could actually lose rows is the delivery
    // refusal below.
    for (let i = 0; i < 3; i++) {
      await federationTick({ db: ctx.db, secretKey: SECRET, orgId: ORG, transport: deadParent() } as any);
    }
    expect(await outboxDepth(ctx.db)).toBe(3);
  });

  it('drains everything it kept once the parent comes back', async () => {
    for (const id of ['e1', 'e2', 'e3']) {
      await supertest(app).post('/v1/events').set('Authorization', `Bearer ${key}`).send(event(id));
    }
    const queued = await outboxDepth(ctx.db);
    expect(queued).toBe(3);
    await federationTick({ db: ctx.db, secretKey: SECRET, orgId: ORG, transport: deadParent() } as any);

    const sent: any[] = [];
    const revived = {
      async ping() { return { ok: true }; },
      async directives() { return null; },
      async deliver(rows: any[]) { sent.push(...rows); return { accepted: rows.length }; },
    };
    // The backoff a failed pass set must not hold the queue hostage once the
    // parent is answering again, so this drains on demand.
    await ctx.db.run('UPDATE federation_outbox SET next_attempt_at = ?', [new Date(0).toISOString()]);
    const out = await federationTick({ db: ctx.db, secretKey: SECRET, orgId: ORG, transport: revived } as any);

    expect(out.ok).toBe(true);
    expect(sent.length).toBe(queued);
    expect(await outboxDepth(ctx.db)).toBe(0);
  });

  it('keeps rows a parent ACCEPTED the connection for but then refused to take', async () => {
    // The dead-parent case never reaches delivery at all: the tick gives up at
    // the ping. Delivery failure is a different path, and it is the one where
    // rows could actually be dropped — so it needs a parent that answers the
    // ping and then fails the handover.
    for (const id of ['d1', 'd2']) {
      await supertest(app).post('/v1/events').set('Authorization', `Bearer ${key}`).send(event(id));
    }
    const queued = await outboxDepth(ctx.db);
    expect(queued).toBe(2);

    const refusesDelivery = {
      async ping() { return { ok: true }; },
      async directives() { return null; },
      async deliver(): Promise<any> { throw new Error('502 from the load balancer'); },
    };
    for (let i = 0; i < 3; i++) {
      await ctx.db.run('UPDATE federation_outbox SET next_attempt_at = ?', [new Date(0).toISOString()]);
      const out = await federationTick({
        db: ctx.db, secretKey: SECRET, orgId: ORG, transport: refusesDelivery,
      } as any);
      expect(out.ok).toBe(false);
    }
    // Nothing discarded: a parent that cannot take them is not permission to
    // throw a developer's telemetry away.
    expect(await outboxDepth(ctx.db)).toBe(queued);
  });

  it('keeps working when its own binding cannot be read at all', async () => {
    // A rotated AGENFK_HUB_SECRET_KEY leaves a binding this hub can no longer
    // decrypt. It must stop forwarding, not stop working — the failure belongs
    // to the group relationship, not to the people using this hub.
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: 'b'.repeat(64), sessionSecret: 'sess', defaultOrgId: ORG,
    } as any);
    try {
      const k2 = await issueApiKey(out.ctx.db, ORG, 'after-rotation');
      const r = await supertest(out.app).post('/v1/events')
        .set('Authorization', `Bearer ${k2}`).send(event('rot-1'));
      expect(r.status).toBe(200);
      expect(r.body.ingested).toBe(1);
      // Unreadable is NOT the same as absent, and the difference is the whole
      // point: a hub that quietly discarded a binding it could not decrypt
      // would stop reporting with nothing to explain it. The row must still be
      // there, and nothing new may be queued under it.
      expect(await outboxDepth(out.ctx.db)).toBe(0);
      const row = await out.ctx.db.get<any>(
        'SELECT value FROM system_state WHERE key = ?', ['federation.parent'],
      );
      expect(row?.value).toBeTruthy();
    } finally {
      out.ctx.stopWorkers?.();
      await drainApp(out.app);
      // The first app's handle is closed by afterEach, which then unlinks the
      // file; leaving this one open leaks a better-sqlite3 handle for the rest
      // of the worker process, which the serial project shares across files.
      await out.ctx.db.close();
    }
  });

  it('does not attempt delivery on the ingest path — only queues', async () => {
    // The structural half of "a slow parent is never the child's latency":
    // ingest hands rows to the outbox and stops. A row that had been through a
    // delivery attempt would carry attempts > 0.
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${key}`).send(event('q1'));
    const rows = await ctx.db.all<any>('SELECT attempts FROM federation_outbox');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => Number(r.attempts) === 0)).toBe(true);
  });

  it('serves its own people at full speed while a tick hangs on a SLOW parent', async () => {
    // The headline property, and the one a wall-clock bound against an
    // unreachable parent never actually exercised: a parent that refuses
    // fails instantly, so nothing was ever slow. This boots a hub whose
    // federation WORKER is mid-tick against a parent that never answers, and
    // then uses the hub normally.
    let release!: () => void;
    const hung = new Promise<void>(r => { release = r; });
    let pinged = 0;
    const slowParent = {
      async ping() { pinged++; await hung; return { ok: true }; },
      async directives() { return null; },
      async deliver(rows: any[]) { return { accepted: rows.length }; },
    };

    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: ORG,
      federationTransport: slowParent,
      federationIntervalMs: 10,
    } as any);
    try {
      const k2 = await issueApiKey(out.ctx.db, ORG, 'slow');
      const c2 = (await supertest(out.app).post('/auth/login')
        .send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';

      // Wait until a tick is genuinely stuck inside the parent call.
      const deadline = Date.now() + 2_000;
      while (pinged === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
      expect(pinged).toBeGreaterThan(0);

      const started = Date.now();
      expect((await supertest(out.app).post('/v1/events')
        .set('Authorization', `Bearer ${k2}`).send(event('hung-1'))).body.ingested).toBe(1);
      expect((await supertest(out.app).get('/v1/metrics').set('Cookie', c2)).status).toBe(200);
      // Tight on purpose: the hung parent is still hung. Anything that awaited
      // it would sit here until the federation HTTP timeout.
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      release();
      out.ctx.stopWorkers?.();
      await drainApp(out.app);
      await out.ctx.db.close();
    }
  });

  it('a worker tick that throws is swallowed, not left as an unhandled rejection', async () => {
    // The worker's own catch is what keeps a bug in federation code from
    // taking down the process that serves everyone's telemetry. Asserting
    // "the hub still responds" cannot see this: the tick runs in a detached
    // async IIFE, so under a test harness a throw is merely an unhandled
    // rejection and the hub keeps serving either way. In production that
    // rejection is fatal by default. So the observable thing to pin is the
    // rejection itself.
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRejection);

    const exploding = {
      async ping(): Promise<any> { throw new Error('boom'); },
      async directives(): Promise<any> { throw new Error('boom'); },
      async deliver(): Promise<any> { throw new Error('boom'); },
    };
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: ORG,
      federationTransport: exploding,
      federationIntervalMs: 5,
    } as any);
    try {
      // Several ticks' worth, then let the microtask queue settle so any
      // rejection has actually been reported.
      await new Promise(r => setTimeout(r, 80));
      await new Promise(r => setImmediate(r));

      expect(rejections).toEqual([]);

      const k2 = await issueApiKey(out.ctx.db, ORG, 'boom');
      expect((await supertest(out.app).post('/v1/events')
        .set('Authorization', `Bearer ${k2}`).send(event('boom-1'))).body.ingested).toBe(1);
    } finally {
      process.off('unhandledRejection', onRejection);
      out.ctx.stopWorkers?.();
      await drainApp(out.app);
      await out.ctx.db.close();
    }
  });
});

describe('a hub that has left its group', () => {
  let app: any;
  let ctx: any;
  let cookie: string;
  let key: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: ORG,
    } as any);
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, ORG, 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login')
      .send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    key = await issueApiKey(ctx.db, ORG, 'local');
  });

  afterEach(async () => {
    ctx.stopWorkers?.();
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  it('keeps the flows its parent sent, and can now edit them', async () => {
    await ctx.db.run(
      `INSERT INTO flows (id, org_id, name, definition_json, source, version, org_available)
       VALUES ('from-parent', ?, 'Group TDD', ?, 'parent', 2, 1)`,
      [ORG, JSON.stringify({ name: 'Group TDD', steps: [{ id: 's0', name: 'TODO', order: 0 }] })],
    );
    await writeParentBinding(ctx.db, SECRET, {
      parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64),
      childHubId: 'ch-1', state: 'revoked',
    });

    expect((await supertest(app).delete('/v1/admin/federation').set('Cookie', cookie)).status).toBe(200);

    // Nothing a team was working under disappears...
    const flow = await ctx.db.get<any>('SELECT source, name FROM flows WHERE id = ?', ['from-parent']);
    expect(flow).toBeTruthy();
    expect(flow.source).toBe('hub');
    // ...and it is ours now.
    expect((await supertest(app).put('/v1/admin/flows/from-parent').set('Cookie', cookie).send({
      definition: { name: 'Ours Now', steps: [{ id: 's0', name: 'TODO', order: 0 }] },
    })).status).toBe(200);
  });

  it('stops syncing rather than retrying a parent it no longer has', async () => {
    await clearParentBinding(ctx.db);
    const out = await federationTick({
      db: ctx.db, secretKey: SECRET, orgId: ORG, transport: deadParent(),
    } as any);
    expect(out.ok).toBe(true);
    expect(out.skipped).toBe('no-binding');
  });

  it('stops queueing for a parent that has released it, instead of growing forever', async () => {
    await writeParentBinding(ctx.db, SECRET, {
      parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64),
      childHubId: 'ch-1', state: 'revoked',
    });
    const r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${key}`).send({
      events: [{ eventId: 'x1', orgId: ORG, installationId: 'inst-1', type: 'item.closed', occurredAt: new Date().toISOString(), userKey: 'd@acme.com', actor: { osUser: 'd' }, payload: {} }],
    });
    // Asserted, or an outbox of 0 could simply mean the event was rejected and
    // this would be green while testing nothing.
    expect(r.body.ingested).toBe(1);
    expect(await outboxDepth(ctx.db)).toBe(0);
  });

  it('serves its own people exactly as before', async () => {
    await clearParentBinding(ctx.db);
    expect((await supertest(app).post('/v1/events').set('Authorization', `Bearer ${key}`).send({
      events: [{ eventId: 'y1', orgId: ORG, installationId: 'inst-1', type: 'item.closed', occurredAt: new Date().toISOString(), userKey: 'd@acme.com', actor: { osUser: 'd' }, payload: {} }],
    })).status).toBe(200);
    expect((await supertest(app).get('/v1/metrics').set('Cookie', cookie)).status).toBe(200);
  });
});
