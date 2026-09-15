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
    expect(rows[0]).toMatchObject({ event_id: 'e1', child_hub_id: a.childHubId, org_id: 'org', user_key: 'alice@acme.com' });
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
    const stored = await ctx.db.get<any>('SELECT child_hub_id FROM events WHERE event_id = ?', ['e1']);
    expect(stored.child_hub_id).toBe(a.childHubId);
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
    expect(Array.isArray(r.body.rejections)).toBe(true);
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
    const child = await ctx.db.get<any>('SELECT child_hub_id FROM events WHERE event_id = ?', ['e1']);
    expect(child.child_hub_id).toBe(a.childHubId);
  });
});
