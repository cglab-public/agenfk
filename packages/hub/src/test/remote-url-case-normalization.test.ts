/**
 * Regression for the duplicate-pill bug: two events for the same GitHub repo
 * but different remote-URL casings (e.g. cglab-PRIVATE vs cglab-private)
 * should collapse to a single distinct project. The fix is hub-side
 * lowercase normalisation at ingest plus a boot-time backfill of historical
 * rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-remote-case-${process.pid}.sqlite`);
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
  orgId: 'org-a',
  occurredAt: '2026-05-03T10:00:00Z',
  actor: { osUser: 'tester' },
  type: 'item.created',
  payload: {},
  ...overrides,
});

// hookTimeout bumped: under full-repo parallel runs the sqlite/express boot in
// beforeEach occasionally exceeds the default 10s.
describe('Hub /v1/projects collapses casings of the same git remote', { hookTimeout: 30_000 }, () => {
  let app: any;
  let ctx: any;
  let cookieAdmin: string;
  let token: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookieAdmin = login.headers['set-cookie']?.[0] ?? '';
    token = await issueApiKey(ctx.db, 'org-a', 'inst-1');
  });
  afterEach(async () => { await ctx.db.close(); cleanup(); });

  it('lowercases remote_url at ingest', async () => {
    await supertest(app)
      .post('/v1/events').set('Authorization', `Bearer ${token}`)
      .send({ events: [sample({ remoteUrl: 'git@github.com:cglab-PRIVATE/horizon-lab.git' })] });
    const row = await ctx.db.get<{ remote_url: string }>('SELECT remote_url FROM events LIMIT 1');
    expect(row.remote_url).toBe('git@github.com:cglab-private/horizon-lab.git');
  });

  it('strips whitespace and control chars at ingest', async () => {
    await supertest(app)
      .post('/v1/events').set('Authorization', `Bearer ${token}`)
      .send({ events: [sample({
        remoteUrl: '  git@github.com:cglab-public/agenfk.git\n\t',
      })] });
    const row = await ctx.db.get<{ remote_url: string }>('SELECT remote_url FROM events LIMIT 1');
    expect(row.remote_url).toBe('git@github.com:cglab-public/agenfk.git');
  });

  it('GET /v1/projects returns one entry when two events differ only by case', async () => {
    await supertest(app)
      .post('/v1/events').set('Authorization', `Bearer ${token}`)
      .send({ events: [sample({ eventId: 'a', remoteUrl: 'git@github.com:cglab-PRIVATE/horizon-lab.git' })] });
    await supertest(app)
      .post('/v1/events').set('Authorization', `Bearer ${token}`)
      .send({ events: [sample({ eventId: 'b', remoteUrl: 'git@github.com:cglab-private/horizon-lab.git' })] });

    const r = await supertest(app).get('/v1/projects').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(r.body.projects).toEqual(['git@github.com:cglab-private/horizon-lab.git']);
  });

  it('boot-time backfill normalises pre-existing mixed-case rows', async () => {
    // Simulate the pre-fix world: insert an event row directly with the
    // original casing (bypassing the route's normalisation).
    await ctx.db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, remote_url, payload)
       VALUES ('legacy-1', 'org-a', 'inst-1', 'tester', ?, ?, 'item.created', ?, '{}')`,
      ['2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', 'git@github.com:cglab-PRIVATE/horizon-lab.git'],
    );
    await ctx.db.close();

    // Re-open the hub — the migration on boot should normalise the row.
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a',
    });
    ctx = out.ctx;
    const row = await ctx.db.get<{ remote_url: string }>(
      "SELECT remote_url FROM events WHERE event_id = 'legacy-1'",
    );
    expect(row.remote_url).toBe('git@github.com:cglab-private/horizon-lab.git');
  });

  it('filter parameter (?projects=...) matches case-insensitively', async () => {
    await supertest(app)
      .post('/v1/events').set('Authorization', `Bearer ${token}`)
      .send({ events: [sample({ remoteUrl: 'git@github.com:cglab-PRIVATE/horizon-lab.git' })] });
    // Filter using the upper-case form the user might still have selected;
    // events should still match (defense-in-depth).
    const r = await supertest(app)
      .get('/v1/timeline?projects=git@github.com:cglab-PRIVATE/horizon-lab.git')
      .set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Canonical-form collapse: https / ssh / no-.git variants of the same repo
  // must merge into a single project chip.
  // -------------------------------------------------------------------------

  it('collapses https vs ssh vs trailing-.git variants of the same repo at ingest', async () => {
    const variants = [
      'git@github.com:cglab-private/horizon-lab.git',
      'https://github.com/cglab-private/horizon-lab.git',
      'https://github.com/cglab-private/horizon-lab',
      'ssh://git@github.com/cglab-private/horizon-lab.git',
    ];
    for (const [i, url] of variants.entries()) {
      await supertest(app)
        .post('/v1/events').set('Authorization', `Bearer ${token}`)
        .send({ events: [sample({ eventId: `v-${i}`, remoteUrl: url })] });
    }
    const r = await supertest(app).get('/v1/projects').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(r.body.projects).toEqual(['git@github.com:cglab-private/horizon-lab.git']);
  });

  it('boot-time backfill collapses pre-existing distinct-form rows into one canonical value', async () => {
    // Insert legacy rows with three different forms of the same repo, bypassing
    // the route's normaliser.
    const legacy = [
      ['legacy-a', 'https://github.com/cglab-private/horizon-lab.git'],
      ['legacy-b', 'https://github.com/cglab-private/horizon-lab'],
      ['legacy-c', 'git@github.com:cglab-private/horizon-lab.git'],
    ];
    for (const [id, url] of legacy) {
      await ctx.db.run(
        `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, remote_url, payload)
         VALUES (?, 'org-a', 'inst-1', 'tester', ?, ?, 'item.created', ?, '{}')`,
        [id, '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', url],
      );
    }
    await ctx.db.close();

    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a',
    });
    ctx = out.ctx;
    const rows = await ctx.db.all<{ remote_url: string }>(
      "SELECT DISTINCT remote_url FROM events WHERE event_id LIKE 'legacy-%'",
    );
    expect(rows.map((r: { remote_url: string }) => r.remote_url)).toEqual([
      'git@github.com:cglab-private/horizon-lab.git',
    ]);
  });

  it('preserves non-parseable remote_url values unchanged (apart from existing whitespace+lowercase rules)', async () => {
    await supertest(app)
      .post('/v1/events').set('Authorization', `Bearer ${token}`)
      .send({ events: [sample({ remoteUrl: '  Some-Weird-String  ' })] });
    const row = await ctx.db.get<{ remote_url: string }>('SELECT remote_url FROM events LIMIT 1');
    expect(row.remote_url).toBe('some-weird-string');
  });

  it('?projects filter accepts any variant form of the canonical URL', async () => {
    await supertest(app)
      .post('/v1/events').set('Authorization', `Bearer ${token}`)
      .send({ events: [sample({ remoteUrl: 'git@github.com:cglab-private/horizon-lab.git' })] });
    // User's saved selection might be the https form — should still match the
    // canonical row stored in the DB.
    const r = await supertest(app)
      .get('/v1/timeline?projects=https://github.com/cglab-private/horizon-lab')
      .set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBe(1);
  });
});
