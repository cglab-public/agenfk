/**
 * Story 2: hub admin POST /v1/admin/orgs/rename + companion banner endpoints
 * + boot-time env-var guard.
 *
 * Why: when migrating a hub DB across deployments (e.g. staging→prod) the
 * org_id baked across ~9 tables is misleading or wrong. Renaming via SQL is
 * error-prone and per-tenant; this lets a logged-in admin do it from the UI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-rename-test-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const loginAs = async (app: any, email: string, password: string) => {
  const r = await supertest(app).post('/auth/login').send({ email, password });
  return r.headers['set-cookie']?.[0] ?? '';
};

describe('admin POST /v1/admin/orgs/rename', () => {
  let app: any;
  let ctx: any;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'staging',
    });
    app = out.app;
    ctx = out.ctx;
    // Seed second org for collision tests.
    await ctx.db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', ['other', 'other']);
    await ctx.db.run('INSERT OR IGNORE INTO auth_config (org_id, password_enabled) VALUES (?, 1)', ['other']);
    await createPasswordUser(ctx.db, 'staging', 'admin@x',  'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'staging', 'viewer@x', 'longenough1', 'viewer');
    await createPasswordUser(ctx.db, 'other',   'admin2@x', 'longenough1', 'admin');
    // Issue an api key to prove it gets repointed.
    await issueApiKey(ctx.db, 'staging', 'fleet-runner');
    // Plant rows in a couple more tables that carry org_id, to ensure they're repointed too.
    await ctx.db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen) VALUES (?, ?, datetime('now'), datetime('now'))`,
      ['inst-1', 'staging'],
    );
    await ctx.db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 'test', '{}')`,
      ['evt-1', 'staging', 'inst-1', 'u@x'],
    );
  });

  afterEach(async () => {
    // Drain in-flight responses before closing the DB — see helpers/drainApp.ts
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  it('rejects non-admin sessions', async () => {
    const cookie = await loginAs(app, 'viewer@x', 'longenough1');
    const r = await supertest(app).post('/v1/admin/orgs/rename')
      .set('Cookie', cookie).send({ from: 'staging', to: 'cglab' });
    expect(r.status).toBe(403);
  });

  it('rejects when from !== session.orgId', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(app).post('/v1/admin/orgs/rename')
      .set('Cookie', cookie).send({ from: 'someone-else', to: 'cglab' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/from.*current org|session/i);
  });

  it('rejects an invalid `to` (regex)', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    for (const bad of ['', 'UPPER', 'has space', '-leading', 'has_underscore', 'a'.repeat(80)]) {
      const r = await supertest(app).post('/v1/admin/orgs/rename')
        .set('Cookie', cookie).send({ from: 'staging', to: bad });
      expect(r.status, `should reject "${bad}"`).toBe(400);
    }
  });

  it('rejects when `to` collides with an existing org id', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(app).post('/v1/admin/orgs/rename')
      .set('Cookie', cookie).send({ from: 'staging', to: 'other' });
    expect(r.status).toBe(409);
  });

  it('rejects when from === to', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(app).post('/v1/admin/orgs/rename')
      .set('Cookie', cookie).send({ from: 'staging', to: 'staging' });
    expect(r.status).toBe(400);
  });

  it('happy path: repoints all org_id-bearing rows, mutates ctx.config, re-issues session, raises pending banner', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');

    const r = await supertest(app).post('/v1/admin/orgs/rename')
      .set('Cookie', cookie).send({ from: 'staging', to: 'cglab' });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      orgId: 'cglab',
      requiresEnvUpdate: true,
      envVar: 'AGENFK_HUB_ORG_ID',
    });

    // orgs row swapped.
    const orgs = await ctx.db.all<{ id: string }>('SELECT id FROM orgs ORDER BY id');
    const ids = orgs.map((o: any) => o.id);
    expect(ids).toContain('cglab');
    expect(ids).toContain('other');
    expect(ids).not.toContain('staging');

    // Child tables repointed.
    for (const tbl of ['users', 'api_keys', 'installations', 'events', 'auth_config', 'flow_assignments']) {
      const stale = await ctx.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${tbl} WHERE org_id = 'staging'`);
      expect(stale?.c, `table ${tbl} should have no rows still tied to 'staging'`).toBe(0);
    }
    // Specifically — what we seeded should now be tied to 'cglab'.
    const u = await ctx.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE org_id = 'cglab' AND email = 'admin@x'");
    expect(u?.c).toBe(1);
    const e = await ctx.db.get<{ org_id: string }>("SELECT org_id FROM events WHERE event_id = 'evt-1'");
    expect(e?.org_id).toBe('cglab');
    const i = await ctx.db.get<{ org_id: string }>("SELECT org_id FROM installations WHERE id = 'inst-1'");
    expect(i?.org_id).toBe('cglab');

    // Other org untouched.
    const otherUser = await ctx.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE org_id = 'other' AND email = 'admin2@x'");
    expect(otherUser?.c).toBe(1);

    // ctx.config mutated for the live process.
    expect(ctx.config.defaultOrgId).toBe('cglab');

    // Pending banner row recorded.
    const sysRow = await ctx.db.get<{ value: string }>("SELECT value FROM system_state WHERE key = 'pending_env_orgid'");
    expect(sysRow?.value).toBe('cglab');

    // Session cookie re-issued in response (supertest exposes set-cookie header).
    const setCookie = r.headers['set-cookie'];
    expect(setCookie).toBeTruthy();
    expect(String(setCookie)).toMatch(/agenfk_hub_session=/);

    // The new cookie carries orgId=cglab — re-fetch /v1/admin/auth-config and confirm we're scoped to the new org.
    const newCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const followup = await supertest(app).get('/v1/admin/auth-config').set('Cookie', String(newCookie));
    expect(followup.status).toBe(200);
  });
});

describe('admin GET /v1/admin/system/pending + POST /v1/admin/system/pending/ack', () => {
  let app: any;
  let ctx: any;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'cglab',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'cglab', 'admin@x', 'longenough1', 'admin');
  });

  afterEach(async () => {
    // Drain in-flight responses before closing the DB — see helpers/drainApp.ts
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  it('returns null when nothing is pending', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(app).get('/v1/admin/system/pending').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ pendingEnvOrgId: null });
  });

  it('returns the pending org id when system_state has one', async () => {
    await ctx.db.run(
      "INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      ['pending_env_orgid', 'cglab'],
    );
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(app).get('/v1/admin/system/pending').set('Cookie', cookie);
    expect(r.body).toEqual({ pendingEnvOrgId: 'cglab' });
  });

  it('ack clears the pending row', async () => {
    await ctx.db.run(
      "INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      ['pending_env_orgid', 'cglab'],
    );
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(app).post('/v1/admin/system/pending/ack').set('Cookie', cookie).send({});
    expect(r.status).toBe(200);
    const row = await ctx.db.get('SELECT value FROM system_state WHERE key = ?', ['pending_env_orgid']);
    expect(row).toBeFalsy();
  });
});

describe('boot-time mismatch → maintenance-mode app', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  // When AGENFK_HUB_ORG_ID disagrees with what the DB carries, we don't
  // crash (logs in cloud envs are a pain to read) and we don't silently
  // resurrect a phantom org row — instead the app boots a minimal
  // "maintenance" surface that surfaces the misconfiguration directly to
  // anyone hitting the URL.
  it('boots a maintenance app when AGENFK_HUB_ORG_ID disagrees with the DB', async () => {
    const first = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'cglab',
    });
    await first.ctx.db.close();

    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'staging',
    });

    try {
      // /healthz is honest about being unhealthy so external probes see it.
      const health = await supertest(out.app).get('/healthz');
      expect(health.status).toBe(503);
      expect(health.body).toMatchObject({
        ok: false,
        service: 'agenfk-hub',
        mismatch: true,
        envOrgId: 'staging',
      });
      expect(Array.isArray(health.body.dbOrgIds)).toBe(true);
      expect(health.body.dbOrgIds).toContain('cglab');

      // A browser hit on the SPA shell shows the mismatch page (HTML).
      const html = await supertest(out.app).get('/').set('Accept', 'text/html');
      expect(html.status).toBe(503);
      expect(html.headers['content-type']).toMatch(/html/);
      expect(html.text).toMatch(/AGENFK_HUB_ORG_ID/);
      expect(html.text).toMatch(/staging/);
      expect(html.text).toMatch(/cglab/);

      // Real APIs are NOT served — every API route returns the same
      // maintenance error so admins can't accidentally drive the broken
      // process.
      for (const route of ['/v1/admin/auth-config', '/v1/admin/orgs/rename', '/auth/login', '/v1/timeline']) {
        const r = await supertest(out.app).post(route).send({});
        const r2 = await supertest(out.app).get(route);
        for (const resp of [r, r2]) {
          expect(resp.status).toBe(503);
          expect(resp.body?.error || resp.text).toMatch(/AGENFK_HUB_ORG_ID|mismatch/i);
        }
      }
    } finally {
      await out.ctx.db.close();
    }
  });

  it('boots normally when AGENFK_HUB_ORG_ID matches the DB', async () => {
    const first = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'cglab',
    });
    await first.ctx.db.close();

    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'cglab',
    });
    try {
      const health = await supertest(out.app).get('/healthz');
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ ok: true, service: 'agenfk-hub' });
      expect(health.body.mismatch).toBeUndefined();
    } finally {
      await out.ctx.db.close();
    }
  });

  it('boots normally on a brand-new DB (no orgs yet) — bootstrap creates the seed row', async () => {
    // No prior boot. The check should not trip on an empty `orgs` table —
    // bootstrap will populate the row immediately afterward.
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'fresh',
    });
    try {
      const health = await supertest(out.app).get('/healthz');
      expect(health.status).toBe(200);
      expect(health.body.ok).toBe(true);
    } finally {
      await out.ctx.db.close();
    }
  });
});

describe('schema covers all org_id-bearing tables (regression pin)', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('the hardcoded ORG_ID_CHILD_TABLES list matches what sqlite_master+pragma_table_info report', async () => {
    const { ctx } = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'cglab',
    });
    try {
      // Expectation: the rename module exports its hardcoded list. If anyone
      // adds a new org_id column without updating the list, this test fails.
      const mod = await import('../routes/orgRename');
      const hardcoded = (mod as any).ORG_ID_CHILD_TABLES as string[];
      expect(Array.isArray(hardcoded)).toBe(true);

      const tables = await ctx.db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'orgs'"
      );
      const introspected: string[] = [];
      for (const t of tables) {
        const cols = await ctx.db.all<{ name: string }>(`PRAGMA table_info(${t.name})`);
        if (cols.some((c: any) => c.name === 'org_id')) introspected.push(t.name);
      }
      expect([...hardcoded].sort()).toEqual(introspected.sort());
    } finally {
      await ctx.db.close();
    }
  });
});
