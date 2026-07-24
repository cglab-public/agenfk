// Dual-backend parity: re-runs the most important user-facing scenarios from
// the SQLite test files against the pg-mem backend so the dialect translator
// gets full coverage of the SQL the hub actually emits at runtime.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openPgMemDb, backfillPrEventRemoteUrls } from '../db/postgres';
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

  it('hidden-users: hide lists, revokes installation api_keys, unhide reverses (CGLAB-31)', async () => {
    await fx.db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_email)
       VALUES (?, ?, now(), now(), ?, ?)`,
      ['inst-gone', 'org', 'gone', 'departed@acme.com'],
    );
    await fx.db.run(
      `INSERT INTO api_keys (token_hash, org_id, label, installation_id) VALUES (?, ?, ?, ?)`,
      ['hash-gone', 'org', 'k', 'inst-gone'],
    );

    const hide = await supertest(fx.app).post('/v1/admin/hidden-users').set('Cookie', fx.cookie)
      .send({ userKey: 'Departed@Acme.com' });
    expect(hide.status).toBe(201);
    expect(hide.body.userKey).toBe('departed@acme.com');
    expect(hide.body.revokedApiKeys).toBe(1);

    const list = await supertest(fx.app).get('/v1/admin/hidden-users').set('Cookie', fx.cookie);
    expect(list.body.map((u: any) => u.userKey)).toEqual(['departed@acme.com']);

    const key = await fx.db.get<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM api_keys WHERE token_hash = ?', ['hash-gone'],
    );
    expect(key?.revoked_at).toBeTruthy();

    const unhide = await supertest(fx.app).delete('/v1/admin/hidden-users/departed%40acme.com').set('Cookie', fx.cookie);
    expect(unhide.body.unhidden).toBe(true);
    const after = await supertest(fx.app).get('/v1/admin/hidden-users').set('Cookie', fx.cookie);
    expect(after.body).toHaveLength(0);
  });

  it('events ingest drops hidden people before the installations upsert on PG (CGLAB-31)', async () => {
    await fx.db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', ['org', 'alice@acme.com']);
    const r = await supertest(fx.app).post('/v1/events')
      .set('Authorization', `Bearer ${fx.token}`)
      .send({ events: [
        sample({ eventId: 'h1', actor: { osUser: 'alice', gitName: 'A', gitEmail: 'Alice@Acme.com' } }),
        sample({ eventId: 'v1', installationId: 'inst-2', actor: { osUser: 'bob', gitName: 'B', gitEmail: 'bob@acme.com' } }),
      ] });
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(1);
    expect(r.body.hiddenDropped).toBe(1);
    const evts = await fx.db.all<{ event_id: string }>('SELECT event_id FROM events');
    expect(evts.map(e => e.event_id)).toEqual(['v1']);
    expect(await fx.db.get('SELECT id FROM installations WHERE id = ?', ['inst-1'])).toBeUndefined();
    expect(await fx.db.get('SELECT id FROM installations WHERE id = ?', ['inst-2'])).toBeTruthy();
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

  it('invite redeem binds installation identity onto api_key (parity)', async () => {
    const created = await supertest(fx.app).post('/hub/invite/create').set('Cookie', fx.cookie).send({});
    const r = await supertest(fx.app).post('/hub/invite/redeem').send({
      inviteToken: created.body.inviteToken,
      installation: { installationId: 'inst-pg-1', osUser: 'bob', gitName: 'B', gitEmail: 'bob@acme.com' },
    });
    expect(r.status).toBe(200);
    const list = await supertest(fx.app).get('/v1/admin/api-keys').set('Cookie', fx.cookie);
    const inviteRow = (list.body as any[]).find(k => (k.label ?? '').startsWith('invite'));
    expect(inviteRow.installationId).toBe('inst-pg-1');
    expect(inviteRow.osUser).toBe('bob');
    expect(inviteRow.gitEmail).toBe('bob@acme.com');
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
      sample({ eventId: 'b1', occurredAt: '2026-05-04T10:00:00Z', type: 'pr.opened',
        actor: { osUser: 'bob', gitName: 'B', gitEmail: 'bob@acme.com' },
        itemType: 'STORY', remoteUrl: 'git@x:api.git',
        payload: { prNumber: 7, repo: 'x/api' } }),
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
      ['item.created', 'pr.opened', 'step.transitioned', 'validate.passed'].sort()
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
    // Bug 307a9fbe: under Postgres, COUNT(*) comes back as a bigint string and
    // `entry.total += r.n` concatenates instead of summing. Assert NUMBER type
    // (not just numerically-equal value) so the tooltip in the UI receives a
    // real number and renders correctly without client-side coercion.
    expect(typeof may3.total).toBe('number');
    expect(may3.total).toBe(3);
    expect(typeof may3.by_type['item.created']).toBe('number');
    expect(may3.by_type['item.created']).toBe(1);
    expect(typeof may4.total).toBe('number');
    expect(may4.total).toBe(1);
  });

  it('GET /v1/histogram supports tzOffsetMin shift', async () => {
    const r = await supertest(fx.app).get('/v1/histogram?tzOffsetMin=-1440').set('Cookie', fx.cookie);
    expect(r.status).toBe(200);
    const may2 = r.body.buckets.find((b: any) => b.time === '2026-05-02');
    expect(typeof may2.total).toBe('number');
    expect(may2.total).toBe(3);
  });

  it('GET /v1/histogram filters by projects + itemTypes', async () => {
    const r = await supertest(fx.app)
      .get('/v1/histogram?projects=git@x:web.git&itemTypes=TASK')
      .set('Cookie', fx.cookie);
    expect(r.status).toBe(200);
    // Sum WITHOUT Number() coercion — if total is a string this collapses to
    // concatenation (the user-visible bug).
    const total = r.body.buckets.reduce((a: number, b: any) => a + b.total, 0);
    expect(typeof total).toBe('number');
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

  it('rollups_daily computes items_closed and leaves token consumption at zero on PG', async () => {
    await recomputeRollups(fx.db);
    const rows = await fx.db.all<any>('SELECT * FROM rollups_daily ORDER BY day, user_key');
    const day3alice = rows.find((x) => x.day === '2026-05-03' && x.user_key === 'alice@acme.com');
    expect(Number(day3alice?.events_count)).toBe(3);
    expect(Number(day3alice?.items_closed)).toBe(1);
    expect(Number(day3alice?.validate_passes)).toBe(1);
    const day4bob = rows.find((x) => x.day === '2026-05-04' && x.user_key === 'bob@acme.com');
    expect(Number(day4bob?.tokens_in)).toBe(0);
    expect(Number(day4bob?.tokens_out)).toBe(0);
  });
});

// BUG 418ee7bd — the boot-time backfill that derives remote_url from a PR
// event's payload.repo is hand-mirrored across the SQLite and Postgres
// bootstraps. The SQLite copy is covered in pr-event-remote-url.test.ts; this
// locks down the PG copy so the two can't silently diverge. We seed a legacy
// row then invoke the exported backfill helper (the same one bootstrap() runs)
// against the pg-mem adapter — re-running full bootstrap isn't reentrant on
// pg-mem (its CREATE TABLE IF NOT EXISTS AST check rejects the second pass).
describe('PG parity: PR-event remote_url backfill', () => {
  let db: HubDb;
  afterEach(async () => { try { await db.close(); } catch { /* */ } });

  it('derives remote_url from payload.repo for historical null PR rows', async () => {
    db = await openPgMemDb();
    // payload column stores the WHOLE event, so repo lives at $.payload.repo.
    const legacyPayload = JSON.stringify({
      eventId: 'legacy-pr', type: 'pr.opened',
      payload: { prNumber: 99, repo: 'carsales-PRIVATE/dataservice' },
    });
    await db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, remote_url, payload)
       VALUES ('legacy-pr', 'org', 'inst-1', 'tester', ?, ?, 'pr.opened', NULL, ?)`,
      ['2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', legacyPayload],
    );

    await backfillPrEventRemoteUrls(db);

    const row = await db.get<{ remote_url: string }>(
      "SELECT remote_url FROM events WHERE event_id = 'legacy-pr'",
    );
    expect(row?.remote_url).toBe('git@github.com:carsales-private/dataservice.git');
  });

  it('leaves a non-PR null-remote row untouched (backfill is type-scoped)', async () => {
    db = await openPgMemDb();
    const payload = JSON.stringify({
      eventId: 'legacy-item', type: 'item.created',
      payload: { repo: 'carsales-PRIVATE/dataservice' },
    });
    await db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, remote_url, payload)
       VALUES ('legacy-item', 'org', 'inst-1', 'tester', ?, ?, 'item.created', NULL, ?)`,
      ['2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', payload],
    );

    await backfillPrEventRemoteUrls(db);

    const row = await db.get<{ remote_url: string | null }>(
      "SELECT remote_url FROM events WHERE event_id = 'legacy-item'",
    );
    expect(row?.remote_url ?? null).toBeNull();
  });
});

describe('PG parity: flow availability', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await bootHubOnPg(); });
  afterEach(async () => { try { await fx.db.close(); } catch { /* */ } });

  const def = (name: string) => ({
    name, description: '',
    steps: [
      { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true },
      { id: 's1', name: 'work', label: 'Work', order: 1 },
      { id: 's2', name: 'done', label: 'Done', order: 2, isAnchor: true },
    ],
  });

  it('PUT /flows/:id/availability toggles org_available on Postgres', async () => {
    const f = (await supertest(fx.app).post('/v1/admin/flows').set('Cookie', fx.cookie).send({ definition: def('PgFlow') })).body;

    let list = await supertest(fx.app).get('/v1/admin/flows').set('Cookie', fx.cookie);
    expect(list.body.find((x: any) => x.id === f.id).orgAvailable).toBe(false);

    const on = await supertest(fx.app).put(`/v1/admin/flows/${f.id}/availability`).set('Cookie', fx.cookie).send({ available: true });
    expect(on.status).toBe(200);
    list = await supertest(fx.app).get('/v1/admin/flows').set('Cookie', fx.cookie);
    expect(list.body.find((x: any) => x.id === f.id).orgAvailable).toBe(true);

    const off = await supertest(fx.app).put(`/v1/admin/flows/${f.id}/availability`).set('Cookie', fx.cookie).send({ available: false });
    expect(off.status).toBe(200);
    list = await supertest(fx.app).get('/v1/admin/flows').set('Cookie', fx.cookie);
    expect(list.body.find((x: any) => x.id === f.id).orgAvailable).toBe(false);
  });

  it('setting a flow as org default cascades to org_available on Postgres', async () => {
    const f = (await supertest(fx.app).post('/v1/admin/flows').set('Cookie', fx.cookie).send({ definition: def('PgDefault') })).body;
    const assign = await supertest(fx.app).put('/v1/admin/flow-assignments').set('Cookie', fx.cookie).send({ scope: 'org', flowId: f.id });
    expect(assign.status).toBe(200);
    const list = await supertest(fx.app).get('/v1/admin/flows').set('Cookie', fx.cookie);
    expect(list.body.find((x: any) => x.id === f.id).orgAvailable).toBe(true);
  });
});

describe('PG parity: flows available + selection', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await bootHubOnPg(); });
  afterEach(async () => { try { await fx.db.close(); } catch { /* */ } });

  const def = (name: string) => ({
    name, description: '',
    steps: [
      { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true },
      { id: 's1', name: 'work', label: 'Work', order: 1 },
      { id: 's2', name: 'done', label: 'Done', order: 2, isAnchor: true },
    ],
  });

  it('available lists org-available flows and selection writes a project assignment on PG', async () => {
    const f = (await supertest(fx.app).post('/v1/admin/flows').set('Cookie', fx.cookie).send({ definition: def('PgF') })).body;
    await supertest(fx.app).put(`/v1/admin/flows/${f.id}/availability`).set('Cookie', fx.cookie).send({ available: true });

    // installation-bound key for selection
    await fx.db.run("INSERT INTO installations (id, org_id, first_seen, last_seen) VALUES ('inst-pg','org', now(), now())");
    const instToken = await issueApiKey(fx.db, 'org', 'pg-client', { installationId: 'inst-pg' });

    const avail = await supertest(fx.app).get('/v1/flows/available').set('Authorization', `Bearer ${instToken}`);
    expect(avail.status).toBe(200);
    expect(avail.body.flows.map((x: any) => x.id)).toContain(f.id);

    const sel = await supertest(fx.app).put('/v1/flows/selection').set('Authorization', `Bearer ${instToken}`)
      .send({ projectId: 'pg-proj', flowId: f.id });
    expect(sel.status).toBe(200);
    const active = await supertest(fx.app).get('/v1/flows/active?projectId=pg-proj').set('Authorization', `Bearer ${instToken}`);
    expect(active.body.flow.id).toBe(f.id);
    expect(active.body.scope).toBe('project');
  });
});
