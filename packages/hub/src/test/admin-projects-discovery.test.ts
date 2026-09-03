import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-projects-discovery-${process.pid}.sqlite`);
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

// remoteUrl is stored already-sanitized on real ingest; tests insert the
// canonical form directly. Discovery is repo-centric: it groups by remote_url.
async function seedEvent(
  db: any,
  orgId: string,
  projectId: string,
  occurredAt: string,
  remoteUrl: string | null = null,
) {
  await db.run(
    `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, project_id, remote_url, payload)
     VALUES (?, ?, ?, ?, ?, datetime('now'), 'item.created', ?, ?, '{}')`,
    [`evt-${Math.random().toString(36).slice(2)}`, orgId, 'inst-x', 'user@x', occurredAt, projectId, remoteUrl],
  );
}

const REPO_WEB = 'git@github.com:acme/web.git';
const REPO_API = 'git@github.com:acme/api.git';

describe('GET /v1/admin/projects (repo discovery)', () => {
  let app: any;
  let ctx: any;
  let cookieAdmin: string;
  let cookieView: string;

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
    await ctx.db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', ['org-b', 'org-b']);
    await ctx.db.run('INSERT OR IGNORE INTO auth_config (org_id, password_enabled) VALUES (?, 1)', ['org-b']);
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org-a', 'view@x', 'longenough1', 'viewer');
    await createPasswordUser(ctx.db, 'org-b', 'b-admin@x', 'longenough1', 'admin');
    cookieAdmin = await loginAs(app, 'admin@x', 'longenough1');
    cookieView = await loginAs(app, 'view@x', 'longenough1');
  });

  afterEach(async () => {
    // Drain in-flight responses before closing the DB — see helpers/drainApp.ts
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  it('returns distinct repos (remote URLs) for the caller org', async () => {
    // Same repo from two different local projectIds → collapses to one repo.
    await seedEvent(ctx.db, 'org-a', 'p-1', '2026-05-01T10:00:00Z', REPO_WEB);
    await seedEvent(ctx.db, 'org-a', 'p-2', '2026-05-02T10:00:00Z', REPO_WEB);
    await seedEvent(ctx.db, 'org-a', 'p-3', '2026-05-03T10:00:00Z', REPO_API);
    await seedEvent(ctx.db, 'org-b', 'p-4', '2026-05-04T10:00:00Z', 'git@github.com:other/repo.git');

    const r = await supertest(app).get('/v1/admin/projects').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    const repos = r.body.map((p: any) => p.remoteUrl).sort();
    expect(repos).toEqual([REPO_API, REPO_WEB]);
    // projectId mirrors the repo so the existing picker shape holds.
    expect(r.body.every((p: any) => p.projectId === p.remoteUrl)).toBe(true);
  });

  it('includes the most-recent occurredAt as lastSeen per repo', async () => {
    await seedEvent(ctx.db, 'org-a', 'p-1', '2026-05-01T10:00:00Z', REPO_WEB);
    await seedEvent(ctx.db, 'org-a', 'p-2', '2026-05-05T10:00:00Z', REPO_WEB);
    const r = await supertest(app).get('/v1/admin/projects').set('Cookie', cookieAdmin);
    const web = r.body.find((p: any) => p.remoteUrl === REPO_WEB);
    expect(web.lastSeen).toBe('2026-05-05T10:00:00Z');
  });

  it('excludes events that carry no remote URL (not repo-identifiable)', async () => {
    await seedEvent(ctx.db, 'org-a', 'p-noremote', '2026-05-01T10:00:00Z', null);
    await seedEvent(ctx.db, 'org-a', 'p-1', '2026-05-02T10:00:00Z', REPO_WEB);
    const r = await supertest(app).get('/v1/admin/projects').set('Cookie', cookieAdmin);
    const repos = r.body.map((p: any) => p.remoteUrl);
    expect(repos).toEqual([REPO_WEB]);
  });

  it('rejects non-admin', async () => {
    const r = await supertest(app).get('/v1/admin/projects').set('Cookie', cookieView);
    expect(r.status).toBe(403);
  });

  it('returns empty array when no events for the org', async () => {
    const r = await supertest(app).get('/v1/admin/projects').set('Cookie', cookieAdmin);
    expect(r.body).toEqual([]);
  });
});
