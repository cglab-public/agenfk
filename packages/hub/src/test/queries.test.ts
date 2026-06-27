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
      sample({ eventId: 'b1', occurredAt: '2026-05-04T10:00:00Z', type: 'pr.opened',
        actor: { osUser: 'bob', gitName: 'B', gitEmail: 'bob@acme.com' },
        itemType: 'STORY', remoteUrl: 'git@github.com:acme/api.git',
        itemTitle: 'Pagination',
        payload: { prNumber: 7, repo: 'acme/api' } }),
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
    expect(day4?.tokens_in).toBe(0);
    expect(day4?.tokens_out).toBe(0);
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
    expect(may4.by_type['pr.opened']).toBe(1);
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
    // Seeded events: item.created, step.transitioned, validate.passed, pr.opened
    expect(r.body.types).toEqual(
      ['item.created', 'pr.opened', 'step.transitioned', 'validate.passed'].sort(),
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

  it('rollup counts pr.opened events in prs_opened', async () => {
    const token = await issueApiKey(ctx.db, 'org', 'test2');
    await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ events: [
        sample({ eventId: 'pr1', occurredAt: '2026-05-03T11:00:00Z', type: 'pr.opened',
          payload: { prNumber: 10, repo: 'acme/web' } }),
        sample({ eventId: 'pr2', occurredAt: '2026-05-03T12:00:00Z', type: 'pr.opened',
          payload: { prNumber: 11, repo: 'acme/web' } }),
      ]});
    await recomputeRollups(ctx.db);
    const rows = await ctx.db.all<any>('SELECT * FROM rollups_daily WHERE day = ? AND user_key = ?',
      ['2026-05-03', 'alice@acme.com']);
    expect(rows[0]?.prs_opened).toBe(2);
  });

  it('GET /v1/metrics includes prs_opened in each series row', async () => {
    const token = await issueApiKey(ctx.db, 'org', 'test3');
    await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ events: [
        sample({ eventId: 'pr3', occurredAt: '2026-05-03T11:30:00Z', type: 'pr.opened',
          payload: { prNumber: 20, repo: 'acme/web' } }),
      ]});
    const r = await supertest(app).get('/v1/metrics').set('Cookie', cookie);
    expect(r.status).toBe(200);
    const row = r.body.series.find((s: any) => s.day === '2026-05-03' && s.user_key === 'alice@acme.com');
    expect(row).toBeDefined();
    expect(typeof row.prs_opened).toBe('number');
    expect(row.prs_opened).toBeGreaterThanOrEqual(1);
  });

  it('GET /v1/metrics filters by user (used by UserDetail page)', async () => {
    const r = await supertest(app).get('/v1/metrics?users=bob@acme.com').set('Cookie', cookie);
    expect(r.status).toBe(200);
    const keys = r.body.series.map((s: any) => s.user_key);
    expect(keys.every((k: string) => k === 'bob@acme.com')).toBe(true);
    expect(keys.length).toBeGreaterThan(0);
  });

  it('GET /v1/metrics with projects= filter reports zero token consumption', async () => {
    const r = await supertest(app)
      .get('/v1/metrics?projects=git@github.com:acme/api.git')
      .set('Cookie', cookie);
    expect(r.status).toBe(200);
    const row = r.body.series.find((s: any) => s.day === '2026-05-04' && s.user_key === 'bob@acme.com');
    expect(row).toBeDefined();
    expect(row.tokens_in).toBe(0);
    expect(row.tokens_out).toBe(0);
  });

  it('rollup ignores tokens.logged events', async () => {
    const token = await issueApiKey(ctx.db, 'org', 'cached-test');
    const ingest = await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ events: [
        sample({ eventId: 'c1', occurredAt: '2026-05-05T10:00:00Z', type: 'tokens.logged',
          actor: { osUser: 'carol', gitName: 'C', gitEmail: 'carol@acme.com' },
          payload: { input: 200, cachedInput: 5000, output: 80, model: 'claude-sonnet-4-6', client: 'claude-code' } }),
      ]});
    expect(ingest.body).toEqual(expect.objectContaining({ ingested: 0, skipped: 1, rejected: 0 }));
    await recomputeRollups(ctx.db);
    const row = await ctx.db.get<any>(
      'SELECT tokens_in, tokens_out FROM rollups_daily WHERE day = ? AND user_key = ?',
      ['2026-05-05', 'carol@acme.com'],
    );
    expect(row).toBeUndefined();
  });

  it('GET /v1/metrics with projects= ignores tokens.logged events in the direct query path', async () => {
    const token = await issueApiKey(ctx.db, 'org', 'cached-test2');
    const ingest = await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ events: [
        sample({ eventId: 'd1', occurredAt: '2026-05-06T10:00:00Z', type: 'tokens.logged',
          actor: { osUser: 'dave', gitName: 'D', gitEmail: 'dave@acme.com' },
          remoteUrl: 'git@github.com:acme/api.git',
          payload: { input: 300, cachedInput: 7000, output: 120, model: 'claude-sonnet-4-6', client: 'claude-code' } }),
      ]});
    expect(ingest.body).toEqual(expect.objectContaining({ ingested: 0, skipped: 1, rejected: 0 }));
    const r = await supertest(app)
      .get('/v1/metrics?projects=git@github.com:acme/api.git&users=dave@acme.com')
      .set('Cookie', cookie);
    expect(r.status).toBe(200);
    const row = r.body.series.find((s: any) => s.day === '2026-05-06' && s.user_key === 'dave@acme.com');
    expect(row).toBeUndefined();
  });

  it('recomputeRollups re-processes all days so stale rows are overwritten', async () => {
    // First compute with current data: token consumption columns are retained
    // for schema compatibility but always recomputed to zero.
    await recomputeRollups(ctx.db);
    const before = await ctx.db.all<any>('SELECT * FROM rollups_daily WHERE day = ? AND user_key = ?',
      ['2026-05-04', 'bob@acme.com']);
    expect(before[0]?.tokens_in).toBe(0);

    // Manually corrupt the rollup row to simulate stale data from an old format.
    await ctx.db.run(
      'UPDATE rollups_daily SET tokens_in = 9999 WHERE day = ? AND user_key = ?',
      ['2026-05-04', 'bob@acme.com'],
    );
    const corrupted = await ctx.db.all<any>('SELECT tokens_in FROM rollups_daily WHERE day = ? AND user_key = ?',
      ['2026-05-04', 'bob@acme.com']);
    expect(corrupted[0]?.tokens_in).toBe(9999);

    // recomputeRollups must overwrite the corrupted row with zero
    // because it re-processes ALL days (not just days >= MAX(day)).
    await recomputeRollups(ctx.db);
    const after = await ctx.db.all<any>('SELECT tokens_in FROM rollups_daily WHERE day = ? AND user_key = ?',
      ['2026-05-04', 'bob@acme.com']);
    expect(after[0]?.tokens_in).toBe(0);
  });
});

describe('GET /v1/prs/overview', () => {
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

    const token = await issueApiKey(ctx.db, 'org', 'test');
    const send = (events: any[]) =>
      supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });

    const pr = (over: any) => sample({
      type: 'pr.opened',
      remoteUrl: 'git@github.com:acme/api.git',
      ...over,
      payload: { prNumber: over.prNumber, repo: 'acme/api', model: over.model, harness: 'claude-code',
        sizing: over.sizing, sizingShadow: over.sizing, leafStory: over.leafStory ?? 0 },
    });

    await send([
      // alice: PR#1 opened small (1 task → 2pts → xs)
      pr({ eventId: 'p1', occurredAt: '2026-05-03T10:00:00Z',
        actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
        prNumber: 1, model: 'claude-opus-4-8', sizing: { epic: 0, story: 0, task: 1, bug: 0 } }),
      // alice: PR#2 opened then resized bigger (leafStory 1 + task 4 → 12pts → m)
      pr({ eventId: 'p2a', occurredAt: '2026-05-03T11:00:00Z',
        actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
        prNumber: 2, model: 'claude-opus-4-8', sizing: { epic: 0, story: 1, task: 1, bug: 0 }, leafStory: 1 }),
      pr({ eventId: 'p2b', type: 'pr.updated', occurredAt: '2026-05-04T09:00:00Z',
        actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
        prNumber: 2, model: 'claude-opus-4-8', sizing: { epic: 0, story: 1, task: 4, bug: 0 }, leafStory: 1 }),
      // bob: PR#3 (2 tasks → 4pts → s) via a different model
      pr({ eventId: 'p3', occurredAt: '2026-05-04T10:00:00Z',
        actor: { osUser: 'bob', gitName: 'B', gitEmail: 'bob@acme.com' },
        prNumber: 3, model: 'claude-sonnet-4-6', sizing: { epic: 0, story: 0, task: 2, bug: 0 } }),
    ]);
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  it('requires a session', async () => {
    const r = await supertest(app).get('/v1/prs/overview');
    expect(r.status).toBe(401);
  });

  it('returns totals, per-developer, per-model, daily and resize breakdowns', async () => {
    const r = await supertest(app).get('/v1/prs/overview').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.buckets).toEqual(['xs', 's', 'm', 'l', 'xl']);
    // 3 distinct PRs (the pr.updated must NOT add a 4th)
    expect(r.body.totals.prs).toBe(3);
    expect(r.body.totals.developers).toBe(2);
    expect(r.body.resized).toEqual({ count: 1, grew: 1, shrank: 0 });

    const alice = r.body.byDeveloper.find((d: any) => d.user_key === 'alice@acme.com');
    expect(alice.prs).toBe(2);
    expect(alice.sizes).toEqual({ xs: 1, s: 0, m: 1, l: 0, xl: 0 }); // PR#2 counted at its LATEST (m) size

    const opus = r.body.byModel.find((m: any) => m.model === 'claude-opus-4-8');
    expect(opus.prs).toBe(2);
  });

  it('filters by model', async () => {
    const r = await supertest(app).get('/v1/prs/overview?model=claude-sonnet-4-6').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.totals.prs).toBe(1);
    expect(r.body.byModel).toHaveLength(1);
    expect(r.body.byModel[0].model).toBe('claude-sonnet-4-6');
  });

  it('filters by date range', async () => {
    const r = await supertest(app).get('/v1/prs/overview?from=2026-05-04T00:00:00Z').set('Cookie', cookie);
    expect(r.status).toBe(200);
    // Only bob's PR#3 was opened on 05-04 (alice's PRs opened 05-03)
    expect(r.body.totals.prs).toBe(1);
    expect(r.body.byDeveloper[0].user_key).toBe('bob@acme.com');
  });
});
