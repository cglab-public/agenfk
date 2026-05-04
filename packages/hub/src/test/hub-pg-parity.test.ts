// Dual-backend parity: re-runs the most important user-facing scenarios from
// the SQLite test files against the pg-mem backend so the dialect translator
// gets full coverage of the SQL the hub actually emits at runtime.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openPgMemDb } from '../db/postgres';
import { issueApiKey } from '../auth/apiKey';
import { createPasswordUser } from '../auth/password';
import { recomputeRollups } from '../rollup';
import type { HubDb } from '../db/types';

const SECRET = 'a'.repeat(64);

interface Fixture {
  app: any;
  db: HubDb;
  cookie: string;
  token: string;
}

async function bootHubOnPg(): Promise<Fixture> {
  const db = await openPgMemDb();
  const out = await createHubApp({
    dbPath: '/tmp/unused-pg-parity.sqlite',
    secretKey: SECRET,
    sessionSecret: 'sess-secret',
    defaultOrgId: 'org',
    db,
  });
  await createPasswordUser(db, 'org', 'admin@x', 'longenough1', 'admin');
  const login = await supertest(out.app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
  const cookie = login.headers['set-cookie']?.[0] ?? '';
  const token = await issueApiKey(db, 'org', 'parity');
  return { app: out.app, db, cookie, token };
}

const sample = (overrides: any = {}) => ({
  eventId: 'e-' + Math.random().toString(36).slice(2),
  installationId: 'inst-1',
  orgId: 'org',
  occurredAt: '2026-05-03T10:00:00Z',
  actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
  type: 'item.created',
  projectId: 'p1',
  itemId: 'i1',
  payload: {},
  ...overrides,
});

describe('PG parity: auth + setup', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await bootHubOnPg(); });
  afterEach(async () => { try { await fx.db.close(); } catch { /* */ } });

  it('GET /auth/providers reflects requiresSetup=false after admin seeded', async () => {
    const r = await supertest(fx.app).get('/auth/providers');
    expect(r.status).toBe(200);
    expect(r.body.password).toBe(true);
    expect(r.body.requiresSetup).toBe(false);
  });

  it('GET /auth/me requires session', async () => {
    const r = await supertest(fx.app).get('/auth/me');
    expect(r.status).toBe(401);
    const r2 = await supertest(fx.app).get('/auth/me').set('Cookie', fx.cookie);
    expect(r2.status).toBe(200);
    expect(r2.body.role).toBe('admin');
  });
});

describe('PG parity: admin endpoints', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await bootHubOnPg(); });
  afterEach(async () => { try { await fx.db.close(); } catch { /* */ } });

  it('PUT /v1/admin/auth-config persists settings', async () => {
    const r = await supertest(fx.app).put('/v1/admin/auth-config').set('Cookie', fx.cookie).send({
      googleEnabled: true,
      google: { clientId: 'gid', clientSecret: 'gsecret' },
      emailAllowlist: ['acme.com'],
    });
    expect(r.status).toBe(200);
    expect(r.body.googleEnabled).toBe(true);
    expect(r.body.google.clientSecretSet).toBe(true);
    expect(r.body.emailAllowlist).toEqual(['acme.com']);
  });

  it('issues + lists + revokes api keys', async () => {
    const made = await supertest(fx.app).post('/v1/admin/api-keys').set('Cookie', fx.cookie).send({ label: 'l' });
    expect(made.status).toBe(201);
    expect(made.body.token.startsWith('agk_')).toBe(true);
    const listed = await supertest(fx.app).get('/v1/admin/api-keys').set('Cookie', fx.cookie);
    expect(listed.body.length).toBeGreaterThanOrEqual(1);
    const preview = listed.body.find((k: any) => k.label === 'l').tokenHashPreview;
    const revoked = await supertest(fx.app).delete(`/v1/admin/api-keys/${preview}`).set('Cookie', fx.cookie);
    expect(revoked.body.revoked).toBe(1);
  });

  it('invites users and prevents duplicates', async () => {
    const r = await supertest(fx.app).post('/v1/admin/users/invite').set('Cookie', fx.cookie)
      .send({ email: 'new@x', password: 'longenough1', role: 'viewer' });
    expect(r.status).toBe(201);
    const dup = await supertest(fx.app).post('/v1/admin/users/invite').set('Cookie', fx.cookie)
      .send({ email: 'new@x', password: 'longenough1', role: 'viewer' });
    expect(dup.status).toBe(409);
  });
});

describe('PG parity: connect (device + invite)', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await bootHubOnPg(); });
  afterEach(async () => { try { await fx.db.close(); } catch { /* */ } });

  it('device-code: start → approve → poll returns the token once', async () => {
    const start = await supertest(fx.app).post('/hub/device/start').send({});
    expect(start.status).toBe(200);
    const approve = await supertest(fx.app).post('/hub/device/approve').set('Cookie', fx.cookie)
      .send({ userCode: start.body.userCode });
    expect(approve.status).toBe(200);
    const poll = await supertest(fx.app).post('/hub/device/poll').send({ deviceCode: start.body.deviceCode });
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe('approved');
    expect(typeof poll.body.token).toBe('string');
  });

  it('invite create + redeem (single-use)', async () => {
    const created = await supertest(fx.app).post('/hub/invite/create').set('Cookie', fx.cookie).send({});
    expect(created.status).toBe(200);
    const first = await supertest(fx.app).post('/hub/invite/redeem').send({ inviteToken: created.body.inviteToken });
    expect(first.status).toBe(200);
    const second = await supertest(fx.app).post('/hub/invite/redeem').send({ inviteToken: created.body.inviteToken });
    expect(second.status).toBe(400);
  });
});

describe('PG parity: queries + rollup', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await bootHubOnPg();
    const events = [
      sample({ eventId: 'a1', occurredAt: '2026-05-03T08:00:00Z', type: 'item.created',
        itemType: 'TASK', remoteUrl: 'git@x:web.git', itemTitle: 'Refactor', externalId: 'WEB-1' }),
      sample({ eventId: 'a2', occurredAt: '2026-05-03T09:00:00Z', type: 'step.transitioned',
        itemType: 'TASK', remoteUrl: 'git@x:web.git', itemTitle: 'Refactor', externalId: 'WEB-1',
        payload: { fromStatus: 'TEST', toStatus: 'DONE' } }),
      sample({ eventId: 'a3', occurredAt: '2026-05-03T10:00:00Z', type: 'validate.passed',
        itemType: 'BUG', remoteUrl: 'git@x:web.git' }),
      sample({ eventId: 'b1', occurredAt: '2026-05-04T10:00:00Z', type: 'tokens.logged',
        actor: { osUser: 'bob', gitName: 'B', gitEmail: 'bob@acme.com' },
        itemType: 'STORY', remoteUrl: 'git@x:api.git',
        payload: { tokenUsage: [{ input: 100, output: 50 }] } }),
    ];
    await supertest(fx.app).post('/v1/events')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({ events });
  });
  afterEach(async () => { try { await fx.db.close(); } catch { /* */ } });

  it('GET /v1/users returns distinct user_keys', async () => {
    const r = await supertest(fx.app).get('/v1/users').set('Cookie', fx.cookie);
    expect(r.status).toBe(200);
    expect(r.body.map((u: any) => u.user_key).sort()).toEqual(['alice@acme.com', 'bob@acme.com']);
  });

  it('GET /v1/timeline filters by user + type', async () => {
    const r = await supertest(fx.app)
      .get('/v1/timeline?users=alice@acme.com&types=item.created')
      .set('Cookie', fx.cookie);
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBe(1);
    expect(r.body.events[0].type).toBe('item.created');
  });

  it('GET /v1/timeline filters by remote_url + item_type', async () => {
    const r = await supertest(fx.app)
      .get('/v1/timeline?projects=git@x:api.git&itemTypes=STORY')
      .set('Cookie', fx.cookie);
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBe(1);
    expect(r.body.events[0].event_id).toBe('b1');
  });

  it('GET /v1/event-types / /v1/projects / /v1/item-types', async () => {
    const types = await supertest(fx.app).get('/v1/event-types').set('Cookie', fx.cookie);
    expect(types.body.types.sort()).toEqual(
      ['item.created', 'step.transitioned', 'tokens.logged', 'validate.passed'].sort()
    );
    const projects = await supertest(fx.app).get('/v1/projects').set('Cookie', fx.cookie);
    expect(projects.body.projects.sort()).toEqual(['git@x:api.git', 'git@x:web.git']);
    const itypes = await supertest(fx.app).get('/v1/item-types').set('Cookie', fx.cookie);
    expect(itypes.body.itemTypes.sort()).toEqual(['BUG', 'STORY', 'TASK']);
    expect(itypes.body.counts).toEqual({ TASK: 2, BUG: 1, STORY: 1 });
  });

  it('GET /v1/histogram day-bucket aggregates by type', async () => {
    const r = await supertest(fx.app).get('/v1/histogram').set('Cookie', fx.cookie);
    expect(r.status).toBe(200);
    expect(r.body.bucket).toBe('day');
    const may3 = r.body.buckets.find((b: any) => b.time === '2026-05-03');
    const may4 = r.body.buckets.find((b: any) => b.time === '2026-05-04');
    expect(Number(may3.total)).toBe(3);
    expect(Number(may4.total)).toBe(1);
  });

  it('GET /v1/histogram supports tzOffsetMin shift', async () => {
    const r = await supertest(fx.app).get('/v1/histogram?tzOffsetMin=-1440').set('Cookie', fx.cookie);
    expect(r.status).toBe(200);
    const may2 = r.body.buckets.find((b: any) => b.time === '2026-05-02');
    expect(Number(may2.total)).toBe(3);
  });

  it('GET /v1/histogram filters by projects + itemTypes', async () => {
    const r = await supertest(fx.app)
      .get('/v1/histogram?projects=git@x:web.git&itemTypes=TASK')
      .set('Cookie', fx.cookie);
    expect(r.status).toBe(200);
    const total = r.body.buckets.reduce((a: number, b: any) => a + Number(b.total), 0);
    expect(total).toBe(2);
  });

  it('recomputeRollups + GET /v1/metrics returns daily series', async () => {
    const r = await recomputeRollups(fx.db);
    expect(r.days).toBeGreaterThan(0);
    const m = await supertest(fx.app).get('/v1/metrics').set('Cookie', fx.cookie);
    expect(m.status).toBe(200);
    expect(m.body.bucket).toBe('day');
    expect(m.body.series.length).toBeGreaterThan(0);
  });

  it('rollups_daily computes items_closed and tokens correctly on PG', async () => {
    await recomputeRollups(fx.db);
    const rows = await fx.db.all<any>('SELECT * FROM rollups_daily ORDER BY day, user_key');
    const day3alice = rows.find((x) => x.day === '2026-05-03' && x.user_key === 'alice@acme.com');
    expect(Number(day3alice?.events_count)).toBe(3);
    expect(Number(day3alice?.items_closed)).toBe(1);
    expect(Number(day3alice?.validate_passes)).toBe(1);
    const day4bob = rows.find((x) => x.day === '2026-05-04' && x.user_key === 'bob@acme.com');
    expect(Number(day4bob?.tokens_in)).toBe(100);
    expect(Number(day4bob?.tokens_out)).toBe(50);
  });
});
