// A child reports what actually happened to a dispatched flow (CGLAB-182,
// task 4). Serving a directive is NOT the flow landing: the parent leaves a
// target `pending` until the child says otherwise, because showing what really
// happened per hub is the entire point of the target table.
//
// Delivery is at-least-once (the outbox has no lease), so the report must be
// idempotent per (dispatch, child hub) and must never regress a terminal
// state.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';
import { openDb } from '../db';
import type { HubDb } from '../db/types';
import { writeParentBinding } from '../services/federation/parentBinding';
import { federationTick } from '../services/federation/federationSync';

const SECRET = 'a'.repeat(64);
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-fdreport-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const def = (name: string) => ({
  name,
  steps: [{ id: 's0', name: 'TODO', order: 0 }, { id: 's1', name: 'DONE', order: 1 }],
});

// ── The child half ────────────────────────────────────────────────────────

describe('the child reports the outcome of a dispatch upstream', () => {
  let db: HubDb;
  const binding = { parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1' };

  const dispatch = (over: Record<string, unknown> = {}) => ({
    kind: 'flow.dispatch',
    dispatchId: 'd-1',
    flowVersion: 1,
    flow: { id: 'flow-1', name: 'Group TDD', version: 1, definition: def('Group TDD') },
    ...over,
  });

  const transport = (directive: unknown) => ({
    async ping() { return { ok: true }; },
    async directives() { return directive; },
    async deliver(rows: any[]) { return { accepted: rows.length }; },
  });

  const queued = () => db.all<any>('SELECT kind, payload FROM federation_outbox ORDER BY seq');
  const reports = async () =>
    (await queued())
      .map(r => JSON.parse(r.payload)?.event)
      .filter((e: any) => e?.type?.startsWith('fleet:flow-dispatch:'));

  beforeEach(async () => {
    db = await openDb(':memory:');
    await writeParentBinding(db, SECRET, binding);
  });

  it('queues an installed report naming the dispatch it answers', async () => {
    await federationTick({ db, secretKey: SECRET, transport: transport(dispatch()), orgId: 'org' } as any);
    const [r] = await reports();
    expect(r).toBeTruthy();
    expect(r.type).toBe('fleet:flow-dispatch:installed');
    expect(r.payload.dispatchId).toBe('d-1');
  });

  it('reports failed, with the reason, when the directive cannot be installed', async () => {
    // A directive missing its definition is refused by installDispatchedFlow.
    // The parent must learn THAT, not silently keep showing pending forever.
    await federationTick({
      db, secretKey: SECRET, orgId: 'org',
      transport: transport(dispatch({ flow: { id: 'flow-1', name: 'Group TDD', version: 1 } })),
    } as any);
    const [r] = await reports();
    expect(r).toBeTruthy();
    expect(r.type).toBe('fleet:flow-dispatch:failed');
    expect(r.payload.dispatchId).toBe('d-1');
    expect(typeof r.payload.detail).toBe('string');
    expect(r.payload.detail.length).toBeGreaterThan(0);
  });

  it('gives the report a stable id, so an at-least-once redelivery is one report', async () => {
    // The outbox has no lease and the parent dedups on the event id. A random
    // id per attempt would make every retry a NEW report.
    await federationTick({ db, secretKey: SECRET, transport: transport(dispatch()), orgId: 'org' } as any);
    const first = (await reports())[0].eventId;

    await db.run('DELETE FROM federation_outbox');
    await federationTick({ db, secretKey: SECRET, transport: transport(dispatch()), orgId: 'org' } as any);
    expect((await reports())[0].eventId).toBe(first);
  });

  it('says nothing about a directive kind it does not understand', async () => {
    // An older child under a newer parent records the unknown kind and carries
    // on; inventing a flow-dispatch report for it would be a lie.
    await federationTick({
      db, secretKey: SECRET, orgId: 'org',
      transport: transport({ kind: 'upgrade.dispatch', dispatchId: 'd-9' }),
    } as any);
    expect(await reports()).toHaveLength(0);
  });

  it('does not report when there was no directive at all', async () => {
    await federationTick({ db, secretKey: SECRET, transport: transport(null), orgId: 'org' } as any);
    expect(await reports()).toHaveLength(0);
  });
});

// ── The parent half ───────────────────────────────────────────────────────

describe('the parent moves a dispatch target only on the child\'s report', () => {
  let app: any;
  let ctx: any;
  let adminCookie: string;

  async function enroll(name: string) {
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', adminCookie).send({});
    const r = await supertest(app).post('/v1/federation/enroll')
      .send({ inviteToken: inv.body.inviteToken, childHub: { name } });
    expect(r.status).toBe(200);
    return r.body as { token: string; childHubId: string };
  }

  const report = (token: string, over: Record<string, unknown> = {}, eventOver: Record<string, unknown> = {}) =>
    supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${token}`).send({
      rows: [{
        id: 'ob-1',
        kind: 'event',
        payload: {
          event: {
            eventId: 'flow-dispatch:d-1:installed',
            type: 'fleet:flow-dispatch:installed',
            occurredAt: new Date().toISOString(),
            userKey: 'system',
            payload: { dispatchId: 'd-1', ...over },
            ...eventOver,
          },
        },
      }],
    });

  const target = (childHubId: string) =>
    ctx.db.get<any>(
      'SELECT state, detail FROM flow_dispatch_targets WHERE dispatch_id = ? AND child_hub_id = ?',
      ['d-1', childHubId],
    );

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    adminCookie = (await supertest(app).post('/auth/login')
      .send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    await ctx.db.run(
      `INSERT INTO flows (id, org_id, name, definition_json, source, version)
       VALUES (?, ?, ?, ?, 'hub', 1)`,
      ['flow-1', 'org', 'Group TDD', JSON.stringify(def('Group TDD'))],
    );
    await ctx.db.run(
      `INSERT INTO flow_dispatches (id, org_id, flow_id, flow_version, scope_type, created_at)
       VALUES (?, ?, ?, 1, 'all', ?)`,
      ['d-1', 'org', 'flow-1', new Date().toISOString()],
    );
  });

  afterEach(async () => {
    ctx.stopWorkers?.();
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  it('marks the target installed for the hub that reported it', async () => {
    const a = await enroll('alpha');
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${a.token}`);
    expect((await target(a.childHubId)).state).toBe('pending');

    expect((await report(a.token)).status).toBe(200);
    expect((await target(a.childHubId)).state).toBe('installed');
  });

  it('records a failure with the reason the child gave', async () => {
    const a = await enroll('alpha');
    const r = await supertest(app).post('/v1/federation/deliver')
      .set('Authorization', `Bearer ${a.token}`).send({
        rows: [{
          id: 'ob-1', kind: 'event',
          payload: {
            event: {
              eventId: 'flow-dispatch:d-1:failed',
              type: 'fleet:flow-dispatch:failed',
              occurredAt: new Date().toISOString(),
              userKey: 'system',
              payload: { dispatchId: 'd-1', detail: 'definition missing steps' },
            },
          },
        }],
      });
    expect(r.status).toBe(200);
    const t = await target(a.childHubId);
    expect(t.state).toBe('failed');
    expect(t.detail).toBe('definition missing steps');
  });

  it('counts a redelivered report once and does not regress the state', async () => {
    const a = await enroll('alpha');
    await report(a.token);
    expect((await target(a.childHubId)).state).toBe('installed');

    const again = await report(a.token);
    expect(again.status).toBe(200);
    expect(again.body.duplicates).toBe(1);
    expect((await target(a.childHubId)).state).toBe('installed');
  });

  it('a late failed report cannot overwrite an installed target', async () => {
    const a = await enroll('alpha');
    await report(a.token);
    await supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${a.token}`).send({
      rows: [{
        id: 'ob-2', kind: 'event',
        payload: {
          event: {
            eventId: 'flow-dispatch:d-1:failed',
            type: 'fleet:flow-dispatch:failed',
            occurredAt: new Date().toISOString(),
            userKey: 'system',
            payload: { dispatchId: 'd-1', detail: 'stale' },
          },
        },
      }],
    });
    expect((await target(a.childHubId)).state).toBe('installed');
  });

  it('attributes the report to the CREDENTIAL, not the payload', async () => {
    // Otherwise one child could mark a dispatch installed for every sibling
    // and an admin would read a broken rollout as complete.
    const a = await enroll('alpha');
    const b = await enroll('beta');
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${b.token}`);

    await report(a.token, { childHubId: b.childHubId });

    expect((await target(a.childHubId)).state).toBe('installed');
    expect((await target(b.childHubId)).state).toBe('pending');
  });

  it('leaves a hub that was served but never reported showing pending to the admin', async () => {
    const a = await enroll('alpha');
    const b = await enroll('beta');
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${a.token}`);
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${b.token}`);
    await report(a.token);

    const list = await supertest(app).get('/v1/admin/flow-dispatches').set('Cookie', adminCookie);
    expect(list.status).toBe(200);
    const targets = list.body.dispatches.find((d: any) => d.id === 'd-1').targets;
    const byId = Object.fromEntries(targets.map((t: any) => [t.childHubId, t]));
    expect(byId[a.childHubId].state).toBe('installed');
    expect(byId[b.childHubId].state).toBe('pending');
  });

  it('ignores a report for a dispatch belonging to another org', async () => {
    const a = await enroll('alpha');
    await ctx.db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', ['org-b', 'org-b']);
    await ctx.db.run(
      `INSERT INTO flow_dispatches (id, org_id, flow_id, flow_version, scope_type, created_at)
       VALUES (?, ?, ?, 1, 'all', ?)`,
      ['d-other', 'org-b', 'flow-1', new Date().toISOString()],
    );
    await supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${a.token}`).send({
      rows: [{
        id: 'ob-3', kind: 'event',
        payload: {
          event: {
            eventId: 'flow-dispatch:d-other:installed',
            type: 'fleet:flow-dispatch:installed',
            occurredAt: new Date().toISOString(),
            userKey: 'system',
            payload: { dispatchId: 'd-other' },
          },
        },
      }],
    });
    const t = await ctx.db.get<any>(
      'SELECT state FROM flow_dispatch_targets WHERE dispatch_id = ?', ['d-other'],
    );
    expect(t).toBeFalsy();
  });

  it('a report with no dispatchId is stored as an event but moves nothing', async () => {
    const a = await enroll('alpha');
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${a.token}`);
    const r = await supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${a.token}`).send({
      rows: [{
        id: 'ob-4', kind: 'event',
        payload: {
          event: {
            eventId: 'flow-dispatch:nothing',
            type: 'fleet:flow-dispatch:installed',
            occurredAt: new Date().toISOString(),
            userKey: 'system',
            payload: {},
          },
        },
      }],
    });
    expect(r.body.accepted).toBe(1);
    expect((await target(a.childHubId)).state).toBe('pending');
  });
});
