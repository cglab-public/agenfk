import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-admin-installations-${process.pid}.sqlite`);
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

async function seedInstallation(
  db: any,
  orgId: string,
  id: string,
  agenfkVersion: string | null,
  lastSeen: string,
  osUser: string | null = 'alice',
) {
  await db.run(
    `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email, agenfk_version, agenfk_version_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, orgId, lastSeen, lastSeen, osUser, null, null, agenfkVersion, agenfkVersion ? lastSeen : null],
  );
}

describe('GET /v1/admin/installations', () => {
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
    cookieAdmin = await loginAs(app, 'admin@x', 'longenough1');
    cookieView = await loginAs(app, 'view@x', 'longenough1');
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  it('lists installations scoped to the caller org with version + lastSeen', async () => {
    await seedInstallation(ctx.db, 'org-a', 'inst-1', 'v0.3.0-beta.28', '2026-05-06T12:00:00Z', 'alice');
    await seedInstallation(ctx.db, 'org-a', 'inst-2', 'v0.3.0-beta.27', '2026-05-05T12:00:00Z', 'bob');
    await seedInstallation(ctx.db, 'org-b', 'inst-other', 'v0.3.0-beta.28', '2026-05-06T12:00:00Z', 'eve');

    const r = await supertest(app).get('/v1/admin/installations').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);

    const ids = r.body.map((x: any) => x.id).sort();
    expect(ids).toEqual(['inst-1', 'inst-2']);

    const inst1 = r.body.find((x: any) => x.id === 'inst-1');
    expect(inst1.agenfkVersion).toBe('v0.3.0-beta.28');
    expect(inst1.lastSeen).toBe('2026-05-06T12:00:00Z');
    expect(inst1.osUser).toBe('alice');
  });

  it('orders by lastSeen descending', async () => {
    await seedInstallation(ctx.db, 'org-a', 'old', 'v0.3.0-beta.20', '2026-04-01T00:00:00Z');
    await seedInstallation(ctx.db, 'org-a', 'newest', 'v0.3.0-beta.28', '2026-05-06T00:00:00Z');
    await seedInstallation(ctx.db, 'org-a', 'middle', 'v0.3.0-beta.25', '2026-05-01T00:00:00Z');

    const r = await supertest(app).get('/v1/admin/installations').set('Cookie', cookieAdmin);
    expect(r.body.map((x: any) => x.id)).toEqual(['newest', 'middle', 'old']);
  });

  it('returns null agenfkVersion when none recorded', async () => {
    await seedInstallation(ctx.db, 'org-a', 'inst-unknown', null, '2026-05-06T00:00:00Z');
    const r = await supertest(app).get('/v1/admin/installations').set('Cookie', cookieAdmin);
    const row = r.body.find((x: any) => x.id === 'inst-unknown');
    expect(row.agenfkVersion).toBeNull();
  });

  it('rejects non-admin viewer', async () => {
    const r = await supertest(app).get('/v1/admin/installations').set('Cookie', cookieView);
    expect(r.status).toBe(403);
  });

  it('returns empty array when org has no installations', async () => {
    const r = await supertest(app).get('/v1/admin/installations').set('Cookie', cookieAdmin);
    expect(r.body).toEqual([]);
  });
});
