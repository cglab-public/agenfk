import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { recomputeRollups } from '../rollup';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-queries-test-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

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

describe('hub query endpoints', () => {
  let app: any;
  let ctx: any;
  let cookie: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookie = login.headers['set-cookie']?.[0] ?? '';

    // Seed a few events directly via the ingest endpoint.
    const token = await issueApiKey(ctx.db, 'org', 'test');
    const send = (events: any[]) =>
      supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });

    await send([
      sample({ eventId: 'a1', occurredAt: '2026-05-03T08:00:00Z', type: 'item.created',
        itemType: 'TASK', remoteUrl: 'git@github.com:acme/web.git',
        itemTitle: 'Refactor login flow', externalId: 'WEB-123' }),
      sample({ eventId: 'a2', occurredAt: '2026-05-03T09:00:00Z', type: 'step.transitioned',
        itemType: 'TASK', remoteUrl: 'git@github.com:acme/web.git',
        itemTitle: 'Refactor login flow', externalId: 'WEB-123',
        payload: { fromStatus: 'TEST', toStatus: 'DONE' } }),
      sample({ eventId: 'a3', occurredAt: '2026-05-03T10:00:00Z', type: 'validate.passed',
        itemType: 'BUG', remoteUrl: 'git@github.com:acme/web.git',
        itemTitle: 'Crash on signup' }),
      sample({ eventId: 'b1', occurredAt: '2026-05-04T10:00:00Z', type: 'tokens.logged',
        actor: { osUser: 'bob', gitName: 'B', gitEmail: 'bob@acme.com' },
        itemType: 'STORY', remoteUrl: 'git@github.com:acme/api.git',
        itemTitle: 'Pagination',
        payload: { tokenUsage: [{ input: 100, output: 50 }] } }),
    ]);
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  it('GET /v1/users requires session', async () => {
    const r = await supertest(app).get('/v1/users');
    expect(r.status).toBe(401);
  });

  it('GET /v1/users returns distinct user_keys with last_seen', async () => {
    const r = await supertest(app).get('/v1/users').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(2);
    expect(r.body.map((u: any) => u.user_key).sort()).toEqual(['alice@acme.com', 'bob@acme.com']);
  });

  it('GET /v1/timeline filters by user and type', async () => {
    const r = await supertest(app).get('/v1/timeline?users=alice@acme.com&types=item.created').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBe(1);
    expect(r.body.events[0].type).toBe('item.created');
  });

  it('GET /v1/timeline filters by date range', async () => {
    const r = await supertest(app).get('/v1/timeline?from=2026-05-04T00:00:00Z').set('Cookie', cookie);
    expect(r.body.events.length).toBe(1);
    expect(r.body.events[0].user_key).toBe('bob@acme.com');
  });

  it('rollup recomputes daily aggregates', async () => {
    const r = await recomputeRollups(ctx.db);
    expect(r.days).toBeGreaterThan(0);
    const rows = await ctx.db.all<any>('SELECT * FROM rollups_daily ORDER BY day ASC, user_key ASC');
    const day3 = rows.find((x) => x.day === '2026-05-03' && x.user_key === 'alice@acme.com');
    expect(day3?.events_count).toBe(3);
    expect(day3?.items_closed).toBe(1);
    expect(day3?.validate_passes).toBe(1);
    const day4 = rows.find((x) => x.day === '2026-05-04' && x.user_key === 'bob@acme.com');
    expect(day4?.tokens_in).toBe(100);
    expect(day4?.tokens_out).toBe(50);
  });

  it('GET /v1/metrics returns rollup series', async () => {
    const r = await supertest(app).get('/v1/metrics').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.bucket).toBe('day');
    expect(r.body.series.length).toBeGreaterThan(0);
  });

  it('GET /v1/histogram requires session', async () => {
    const r = await supertest(app).get('/v1/histogram');
    expect(r.status).toBe(401);
  });

  it('GET /v1/histogram defaults to day bucket and aggregates by type', async () => {
    const r = await supertest(app).get('/v1/histogram').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.bucket).toBe('day');
    expect(Array.isArray(r.body.buckets)).toBe(true);
    const may3 = r.body.buckets.find((b: any) => b.time === '2026-05-03');
    const may4 = r.body.buckets.find((b: any) => b.time === '2026-05-04');
    expect(may3.total).toBe(3);
    expect(may3.by_type['item.created']).toBe(1);
    expect(may3.by_type['step.transitioned']).toBe(1);
    expect(may3.by_type['validate.passed']).toBe(1);
    expect(may4.total).toBe(1);
    expect(may4.by_type['tokens.logged']).toBe(1);
  });

  it('GET /v1/histogram filters by user and type', async () => {
    const r = await supertest(app)
      .get('/v1/histogram?users=alice@acme.com&types=item.created')
      .set('Cookie', cookie);
    expect(r.status).toBe(200);
    const total = r.body.buckets.reduce((a: number, b: any) => a + b.total, 0);
    expect(total).toBe(1);
    expect(r.body.buckets[0].by_type['item.created']).toBe(1);
  });

  it('GET /v1/histogram applies tzOffsetMin so buckets match the caller local calendar', async () => {
    // Seeded a1/a2/a3 occurred on 2026-05-03 UTC; b1 on 2026-05-04 UTC.
    // With tzOffsetMin=-1440 (1-day shift back) every event must land in a
    // bucket one day earlier than its UTC date.
    const noShift = await supertest(app).get('/v1/histogram?tzOffsetMin=0').set('Cookie', cookie);
    expect(noShift.body.buckets.find((b: any) => b.time === '2026-05-03')?.total).toBe(3);

    const r = await supertest(app).get('/v1/histogram?tzOffsetMin=-1440').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.buckets.find((b: any) => b.time === '2026-05-02')?.total).toBe(3);
    expect(r.body.buckets.find((b: any) => b.time === '2026-05-03')?.total).toBe(1); // b1 shifted from 05-04
  });

  it('GET /v1/histogram supports hour bucket', async () => {
    const r = await supertest(app).get('/v1/histogram?bucket=hour').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.bucket).toBe('hour');
    const slot = r.body.buckets.find((b: any) => b.time === '2026-05-03T08:00');
    expect(slot.total).toBe(1);
    expect(slot.by_type['item.created']).toBe(1);
  });

  it('GET /v1/histogram filters by date range', async () => {
    const r = await supertest(app)
      .get('/v1/histogram?from=2026-05-04T00:00:00Z')
      .set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.buckets.length).toBe(1);
    expect(r.body.buckets[0].time).toBe('2026-05-04');
    expect(r.body.buckets[0].total).toBe(1);
  });

  it('GET /v1/histogram rejects invalid bucket value', async () => {
    const r = await supertest(app).get('/v1/histogram?bucket=year').set('Cookie', cookie);
    expect(r.status).toBe(400);
  });

  it('GET /v1/event-types requires session', async () => {
    const r = await supertest(app).get('/v1/event-types');
    expect(r.status).toBe(401);
  });

  it('GET /v1/event-types returns distinct types observed in the org', async () => {
    const r = await supertest(app).get('/v1/event-types').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.types)).toBe(true);
    // Seeded events: item.created, step.transitioned, validate.passed, tokens.logged
    expect(r.body.types).toEqual(
      ['item.created', 'step.transitioned', 'tokens.logged', 'validate.passed'].sort(),
    );
  });

  it('GET /v1/projects returns distinct remoteUrls observed in the org', async () => {
    const r = await supertest(app).get('/v1/projects').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.projects).toEqual([
      'git@github.com:acme/api.git',
      'git@github.com:acme/web.git',
    ]);
  });

  it('GET /v1/projects requires session', async () => {
    const r = await supertest(app).get('/v1/projects');
    expect(r.status).toBe(401);
  });

  it('GET /v1/item-types returns distinct EPIC/STORY/TASK/BUG values', async () => {
    const r = await supertest(app).get('/v1/item-types').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.itemTypes).toEqual(['BUG', 'STORY', 'TASK']);
  });

  it('GET /v1/item-types returns counts respecting current filters', async () => {
    // No filters: org-wide totals.
    const all = await supertest(app).get('/v1/item-types').set('Cookie', cookie);
    expect(all.status).toBe(200);
    // Seeded events: 2 TASK (a1,a2), 1 BUG (a3), 1 STORY (b1)
    expect(all.body.counts).toEqual({ TASK: 2, BUG: 1, STORY: 1 });

    // Project filter narrows to web.git → only TASK and BUG remain visible.
    const byProject = await supertest(app)
      .get('/v1/item-types?projects=git@github.com:acme/web.git')
      .set('Cookie', cookie);
    expect(byProject.status).toBe(200);
    expect(byProject.body.counts).toEqual({ TASK: 2, BUG: 1 });
    // The list of all known itemTypes stays org-wide so chips remain selectable.
    expect(byProject.body.itemTypes).toEqual(['BUG', 'STORY', 'TASK']);

    // Event-type filter: only validate.passed → BUG=1.
    const byType = await supertest(app)
      .get('/v1/item-types?types=validate.passed')
      .set('Cookie', cookie);
    expect(byType.status).toBe(200);
    expect(byType.body.counts).toEqual({ BUG: 1 });

    // The current itemTypes filter must NOT constrain its own counts —
    // chips still show the totals you would get if you toggled them on.
    const ignoresOwnFilter = await supertest(app)
      .get('/v1/item-types?itemTypes=BUG')
      .set('Cookie', cookie);
    expect(ignoresOwnFilter.status).toBe(200);
    expect(ignoresOwnFilter.body.counts).toEqual({ TASK: 2, BUG: 1, STORY: 1 });
  });

  it('GET /v1/timeline filters by remoteUrl (projects=)', async () => {
    const r = await supertest(app)
      .get('/v1/timeline?projects=git@github.com:acme/api.git')
      .set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBe(1);
    expect(r.body.events[0].event_id).toBe('b1');
  });

  it('GET /v1/timeline filters by itemType (itemTypes=)', async () => {
    const r = await supertest(app)
      .get('/v1/timeline?itemTypes=BUG')
      .set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBe(1);
    expect(r.body.events[0].event_id).toBe('a3');
  });

  it('GET /v1/timeline rows expose item_type and remote_url', async () => {
    const r = await supertest(app).get('/v1/timeline').set('Cookie', cookie);
    expect(r.status).toBe(200);
    const a1 = r.body.events.find((e: any) => e.event_id === 'a1');
    expect(a1.item_type).toBe('TASK');
    expect(a1.remote_url).toBe('git@github.com:acme/web.git');
  });

  it('GET /v1/timeline rows expose item_title and external_id (Jira key)', async () => {
    const r = await supertest(app).get('/v1/timeline').set('Cookie', cookie);
    expect(r.status).toBe(200);
    const a1 = r.body.events.find((e: any) => e.event_id === 'a1');
    expect(a1.item_title).toBe('Refactor login flow');
    expect(a1.external_id).toBe('WEB-123');
    const a3 = r.body.events.find((e: any) => e.event_id === 'a3');
    expect(a3.item_title).toBe('Crash on signup');
    expect(a3.external_id).toBeNull();
  });

  it('GET /v1/histogram filters by projects+itemTypes', async () => {
    const r = await supertest(app)
      .get('/v1/histogram?projects=git@github.com:acme/web.git&itemTypes=TASK')
      .set('Cookie', cookie);
    expect(r.status).toBe(200);
    const total = r.body.buckets.reduce((a: number, b: any) => a + b.total, 0);
    expect(total).toBe(2); // a1 + a2
  });

  it('GET /v1/users filters by remoteUrl', async () => {
    const r = await supertest(app)
      .get('/v1/users?projects=git@github.com:acme/api.git')
      .set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(1);
    expect(r.body[0].user_key).toBe('bob@acme.com');
  });
});
