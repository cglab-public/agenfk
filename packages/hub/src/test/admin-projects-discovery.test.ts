import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

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

describe('GET /v1/admin/projects', () => {
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

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  it('returns distinct project ids for the caller org', async () => {
    await seedEvent(ctx.db, 'org-a', 'p-1', '2026-05-01T10:00:00Z');
    await seedEvent(ctx.db, 'org-a', 'p-1', '2026-05-02T10:00:00Z');
    await seedEvent(ctx.db, 'org-a', 'p-2', '2026-05-03T10:00:00Z');
    await seedEvent(ctx.db, 'org-b', 'p-3', '2026-05-04T10:00:00Z');

    const r = await supertest(app).get('/v1/admin/projects').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    const ids = r.body.map((p: any) => p.projectId).sort();
    expect(ids).toEqual(['p-1', 'p-2']);
  });

  it('includes most-recent occurredAt as lastSeen', async () => {
    await seedEvent(ctx.db, 'org-a', 'p-1', '2026-05-01T10:00:00Z');
    await seedEvent(ctx.db, 'org-a', 'p-1', '2026-05-05T10:00:00Z');
    const r = await supertest(app).get('/v1/admin/projects').set('Cookie', cookieAdmin);
    const p1 = r.body.find((p: any) => p.projectId === 'p-1');
    expect(p1.lastSeen).toBe('2026-05-05T10:00:00Z');
  });

  it('rejects non-admin', async () => {
    const r = await supertest(app).get('/v1/admin/projects').set('Cookie', cookieView);
    expect(r.status).toBe(403);
  });

  it('returns empty array when no events for the org', async () => {
    const r = await supertest(app).get('/v1/admin/projects').set('Cookie', cookieAdmin);
    expect(r.body).toEqual([]);
  });

  // BUG b976a525: hub admin Flow Assignments UI showed raw project UUIDs
  // (which are unique-per-installation and meaningless to admins). The remote
  // URL is the recognizable identity. The discovery endpoint must surface it.
  it('includes remoteUrl from the project events', async () => {
    await seedEvent(ctx.db, 'org-a', 'p-1', '2026-05-01T10:00:00Z', 'git@github.com:acme/web.git');
    await seedEvent(ctx.db, 'org-a', 'p-1', '2026-05-02T10:00:00Z', 'git@github.com:acme/web.git');
    await seedEvent(ctx.db, 'org-a', 'p-2', '2026-05-03T10:00:00Z', 'git@github.com:acme/api.git');
    const r = await supertest(app).get('/v1/admin/projects').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    const p1 = r.body.find((p: any) => p.projectId === 'p-1');
    const p2 = r.body.find((p: any) => p.projectId === 'p-2');
    expect(p1.remoteUrl).toBe('git@github.com:acme/web.git');
    expect(p2.remoteUrl).toBe('git@github.com:acme/api.git');
  });

  it('returns null remoteUrl when no event for the project carries one', async () => {
    await seedEvent(ctx.db, 'org-a', 'p-1', '2026-05-01T10:00:00Z', null);
    const r = await supertest(app).get('/v1/admin/projects').set('Cookie', cookieAdmin);
    const p1 = r.body.find((p: any) => p.projectId === 'p-1');
    expect(p1.remoteUrl).toBeNull();
  });

  it('uses the latest non-null remoteUrl when historical events have stale values', async () => {
    // Earliest event has no remote; later events get one. Picker must show the latest known.
    await seedEvent(ctx.db, 'org-a', 'p-1', '2026-05-01T10:00:00Z', null);
    await seedEvent(ctx.db, 'org-a', 'p-1', '2026-05-02T10:00:00Z', 'git@github.com:acme/web.git');
    const r = await supertest(app).get('/v1/admin/projects').set('Cookie', cookieAdmin);
    const p1 = r.body.find((p: any) => p.projectId === 'p-1');
    expect(p1.remoteUrl).toBe('git@github.com:acme/web.git');
  });
});
