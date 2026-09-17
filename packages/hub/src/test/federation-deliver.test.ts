// Parent-side ingest of forwarded events (CGLAB-184, task 2).
//
// federationSync documents delivery as at-least-once — rows leave the child's
// outbox only after the parent accepts them, and two replicas share no lease —
// so the idempotency here is not a nicety, it is the other half of that
// contract. A redelivered batch must count once.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { recomputeRollups } from '../rollup';
import { drainApp } from './helpers/drainApp';

const DB = path.join(os.tmpdir(), `agenfk-hub-deliver-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };

const row = (id: string, childHubId: string, over: Record<string, unknown> = {}) => ({
  id: `outbox-${id}`,
  kind: 'event',
  payload: {
    childHubId,
    identityPolicy: 'keep',
    event: {
      eventId: id, orgId: 'org', installationId: 'i1', userKey: 'alice@acme.com',
      occurredAt: '2026-09-14T10:00:00.000Z', type: 'item.closed',
      itemId: `item-${id}`, itemType: 'TASK', payload: {}, ...over,
    },
  },
});

describe('POST /v1/federation/deliver', () => {
  let app: any; let ctx: any; let adminCookie: string;

  async function enroll(name: string) {
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', adminCookie).send({});
    const r = await supertest(app).post('/v1/federation/enroll').send({ inviteToken: inv.body.inviteToken, childHub: { name } });
    expect(r.status).toBe(200);
    return r.body as { token: string; childHubId: string };
  }
  const deliver = (token: string, rows: unknown[]) =>
    supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${token}`).send({ rows });

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    adminCookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => { ctx.stopWorkers?.(); await drainApp(app); await ctx.db.close(); cleanup(); });

  it('stores forwarded events against the child hub that sent them', async () => {
    const a = await enroll('alpha');
    const r = await deliver(a.token, [row('e1', a.childHubId), row('e2', a.childHubId)]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ accepted: 2 });
    const rows = await ctx.db.all<any>('SELECT event_id, child_hub_id, org_id, user_key FROM events ORDER BY event_id');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ child_hub_id: a.childHubId, org_id: 'org', user_key: 'alice@acme.com' });
    // stored under an id namespaced by child hub, since event_id is the PK
    expect(rows[0].event_id).toBe(`ch:${a.childHubId}:e1`);
  });

  it('counts a redelivered batch once — the delivery contract is at-least-once', async () => {
    const a = await enroll('alpha');
    await deliver(a.token, [row('e1', a.childHubId), row('e2', a.childHubId)]);
    const again = await deliver(a.token, [row('e1', a.childHubId), row('e2', a.childHubId)]);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ accepted: 0, duplicates: 2 });
    const n = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events');
    expect(Number(n.n)).toBe(2);
  });

  it('attributes rows to the CALLING child, whatever the payload claims', async () => {
    const a = await enroll('alpha');
    const b = await enroll('beta');
    // alpha's token, but the row says it belongs to beta
    await deliver(a.token, [row('e1', b.childHubId)]);
    const stored = await ctx.db.get<any>('SELECT child_hub_id FROM events WHERE event_id = ?', [`ch:${a.childHubId}:e1`]);
    expect(stored.child_hub_id).toBe(a.childHubId);
    // and nothing landed under beta's namespace
    expect(await ctx.db.get<any>('SELECT 1 AS x FROM events WHERE event_id = ?', [`ch:${b.childHubId}:e1`])).toBeFalsy();
  });

  it('stores rows in the CREDENTIAL\'s org, whatever the payload claims', async () => {
    // Every fixture used the same org as the credential, so the org half of
    // "attribution comes from the credential" was never actually tested.
    const a = await enroll('alpha');
    await ctx.db.run("INSERT INTO orgs (id, name) VALUES ('other','other')");
    await deliver(a.token, [row('e1', a.childHubId, { orgId: 'other' } as any)]);
    const stored = await ctx.db.get<any>('SELECT org_id FROM events WHERE event_id = ?', [`ch:${a.childHubId}:e1`]);
    expect(stored.org_id).toBe('org');
    expect(Number((await ctx.db.get<any>("SELECT COUNT(*) AS n FROM events WHERE org_id = 'other'")).n)).toBe(0);
  });

  it('keeps two children\'s identical event ids apart', async () => {
    const a = await enroll('alpha');
    const b = await enroll('beta');
    await deliver(a.token, [row('shared', a.childHubId)]);
    await deliver(b.token, [row('shared', b.childHubId)]);
    const rows = await ctx.db.all<any>('SELECT child_hub_id FROM events ORDER BY child_hub_id');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r: any) => r.child_hub_id)).size).toBe(2);
  });

  it('needs a federation key — an installation key and an admin session are both refused', async () => {
    const a = await enroll('alpha');
    expect((await supertest(app).post('/v1/federation/deliver').send({ rows: [] })).status).toBe(401);
    const inst = await issueApiKey(ctx.db, 'org', 'i');
    expect((await supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${inst}`).send({ rows: [] })).status).toBe(401);
    expect((await supertest(app).post('/v1/federation/deliver').set('Cookie', adminCookie).send({ rows: [] })).status).toBe(401);
    expect(Number((await ctx.db.get<any>('SELECT COUNT(*) AS n FROM events')).n)).toBe(0);
    expect(a.childHubId).toBeTruthy();
  });

  it('refuses a detached child', async () => {
    const a = await enroll('alpha');
    await supertest(app).post(`/v1/admin/child-hubs/${a.childHubId}/detach`).set('Cookie', adminCookie).send({});
    expect((await deliver(a.token, [row('e1', a.childHubId)])).status).toBe(401);
  });

  it('bounds the batch, like /v1/events does', async () => {
    const a = await enroll('alpha');
    const huge = Array.from({ length: 501 }, (_, i) => row(`e${i}`, a.childHubId));
    const r = await deliver(a.token, huge);
    expect(r.status).toBe(413);
    expect(Number((await ctx.db.get<any>('SELECT COUNT(*) AS n FROM events')).n)).toBe(0);
  });

  it('reports rejected rows instead of dropping them silently', async () => {
    const a = await enroll('alpha');
    const r = await deliver(a.token, [row('good', a.childHubId), { id: 'x', kind: 'event', payload: { event: { nope: true } } }]);
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(1);
    expect(r.body.rejected).toBe(1);
    // The name says "reports"; an empty array is also an array.
    expect(r.body.rejections).toEqual([{ id: 'x', reason: 'invalid_event' }]);
  });

  it('rejects an event missing any of the three fields it is keyed and dated by', async () => {
    const a = await enroll('alpha');
    const bad = (over: Record<string, unknown>) => ({
      id: 'x', kind: 'event',
      payload: { event: { eventId: 'z', type: 'item.closed', occurredAt: '2026-09-14T10:00:00.000Z', ...over } },
    });
    const r = await deliver(a.token, [
      bad({ eventId: undefined }), bad({ type: undefined }), bad({ occurredAt: undefined }),
      row('good', a.childHubId),
    ]);
    expect(r.body).toMatchObject({ accepted: 1, rejected: 3 });
  });

  it('survives a row whose optional fields are the wrong type, instead of wedging the child forever', async () => {
    // These bind straight into the driver. An object or a boolean throws,
    // which rolls the batch back and 500s — and the child's outbox does not
    // delete on a non-2xx, so it would redeliver the same poison batch for
    // good, blocking everything queued behind it.
    const a = await enroll('alpha');
    const r = await deliver(a.token, [
      row('weird', a.childHubId, {
        projectId: { nested: true }, itemId: [1, 2], itemType: true,
        itemTitle: { nested: true }, remoteUrl: false, externalId: [],
      } as any),
      row('good', a.childHubId),
    ]);
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(2);
  });

  it('drops a hidden person\'s forwarded events, as local ingest does', async () => {
    const a = await enroll('alpha');
    await ctx.db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', ['org', 'alice@acme.com']);
    const r = await deliver(a.token, [
      row('hidden', a.childHubId),
      row('visible', a.childHubId, { userKey: 'bob@acme.com' }),
    ]);
    expect(r.body).toMatchObject({ accepted: 1, hiddenDropped: 1 });
    const rows = await ctx.db.all<any>('SELECT user_key FROM events');
    expect(rows.map((x: any) => x.user_key)).toEqual(['bob@acme.com']);
  });

  it('canonicalises a forwarded remote url, so one repo is one chip', async () => {
    const a = await enroll('alpha');
    await deliver(a.token, [row('e1', a.childHubId, { remoteUrl: 'HTTPS://GitHub.com/Acme/App.git ' })]);
    const stored = await ctx.db.get<any>('SELECT remote_url FROM events WHERE event_id = ?', [`ch:${a.childHubId}:e1`]);
    expect(stored.remote_url).toBe(stored.remote_url.trim().toLowerCase());
    expect(stored.remote_url).not.toContain(' ');
  });

  it('stamps its own receipt time, not the child\'s clock', async () => {
    const a = await enroll('alpha');
    await deliver(a.token, [row('e1', a.childHubId, { occurredAt: '2020-01-01T00:00:00.000Z' })]);
    const stored = await ctx.db.get<any>('SELECT occurred_at, received_at FROM events WHERE event_id = ?', [`ch:${a.childHubId}:e1`]);
    expect(stored.occurred_at).toBe('2020-01-01T00:00:00.000Z');
    expect(new Date(stored.received_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('returns one row per person and day, not one per child hub', async () => {
    // rollups_daily's PRIMARY KEY used to guarantee this; child_hub_id joining
    // the key removed the guarantee, so the endpoint has to collapse
    // explicitly or the same person appears once per hub.
    const a = await enroll('alpha');
    const b = await enroll('beta');
    const local = await issueApiKey(ctx.db, 'org', 'local');
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${local}`).send({
      events: [{
        eventId: 'l1', orgId: 'org', installationId: 'i-local',
        occurredAt: '2026-09-14T09:00:00.000Z', type: 'item.closed',
        actor: { osUser: 'alice', gitName: null, gitEmail: 'alice@acme.com' }, payload: {},
      }],
    });
    await deliver(a.token, [row('a1', a.childHubId)]);
    await deliver(b.token, [row('b1', b.childHubId)]);
    await recomputeRollups(ctx.db, { full: true });

    const cookie = adminCookie;
    const r = await supertest(app).get('/v1/metrics?from=2026-09-01&to=2026-09-30').set('Cookie', cookie);
    expect(r.status).toBe(200);
    const alice = r.body.series.filter((x: any) => x.user_key === 'alice@acme.com' && x.day === '2026-09-14');
    expect(alice).toHaveLength(1);
    // and the one row is the sum across the local hub and both children
    expect(Number(alice[0].events_count)).toBe(3);
  });

  it('rolls up a backlog dated before anything already rolled up', async () => {
    // recomputeRollups anchors forward-only on MAX(day). A child offline for a
    // week delivers events dated days ago; without an explicit since they
    // would never appear in /v1/metrics at all.
    const a = await enroll('alpha');
    await deliver(a.token, [row('recent', a.childHubId, { occurredAt: '2026-09-14T10:00:00.000Z' })]);
    await deliver(a.token, [row('backlog', a.childHubId, { occurredAt: '2026-09-07T10:00:00.000Z' })]);
    const days = await ctx.db.all<any>("SELECT day FROM rollups_daily WHERE child_hub_id <> '' ORDER BY day ASC");
    expect(days.map((d: any) => d.day)).toEqual(['2026-09-07', '2026-09-14']);
  });

  it('ignores a kind it does not understand rather than failing the batch', async () => {
    const a = await enroll('alpha');
    const r = await deliver(a.token, [row('good', a.childHubId), { id: 'y', kind: 'from-the-future', payload: {} }]);
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(1);
    expect(r.body.ignored).toBe(1);
  });

  it('rolls forwarded events up per child hub, keeping two children apart', async () => {
    const a = await enroll('alpha');
    const b = await enroll('beta');
    await deliver(a.token, [row('a1', a.childHubId), row('a2', a.childHubId)]);
    await deliver(b.token, [row('b1', b.childHubId)]);
    await recomputeRollups(ctx.db, { full: true });
    const rows = await ctx.db.all<any>(
      'SELECT child_hub_id, events_count FROM rollups_daily WHERE child_hub_id <> \'\' ORDER BY events_count DESC',
    );
    expect(rows).toHaveLength(2);
    expect(Number(rows[0].events_count)).toBe(2);
    expect(Number(rows[1].events_count)).toBe(1);
  });

  it('keeps the parent\'s own events separate from any child\'s', async () => {
    const a = await enroll('alpha');
    const token = await issueApiKey(ctx.db, 'org', 'local');
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({
      events: [{
        eventId: 'local-1', orgId: 'org', installationId: 'i-local',
        occurredAt: '2026-09-14T10:00:00.000Z', type: 'item.closed',
        actor: { osUser: 'local', gitName: null, gitEmail: 'local@acme.com' }, payload: {},
      }],
    });
    await deliver(a.token, [row('e1', a.childHubId)]);
    const local = await ctx.db.get<any>('SELECT child_hub_id FROM events WHERE event_id = ?', ['local-1']);
    // The parent's own data is not attributed to any child hub.
    expect(local.child_hub_id === null || local.child_hub_id === '').toBe(true);
    const child = await ctx.db.get<any>('SELECT child_hub_id FROM events WHERE event_id = ?', [`ch:${a.childHubId}:e1`]);
    expect(child.child_hub_id).toBe(a.childHubId);

    // And the rollup keeps them apart: the local row's child_hub_id is NULL on
    // events, which only COALESCE turns into the '' the column requires.
    await recomputeRollups(ctx.db, { full: true });
    const rolled = await ctx.db.all<any>('SELECT child_hub_id FROM rollups_daily ORDER BY child_hub_id ASC');
    expect(rolled.map((r: any) => r.child_hub_id)).toEqual(['', a.childHubId]);
  });
});
