// Tests for the hidden-users admin API (CGLAB-31):
//   GET    /v1/admin/hidden-users           — list hidden people for the org
//   POST   /v1/admin/hidden-users           — hide a person (keyed on user_key)
//   DELETE /v1/admin/hidden-users/:userKey  — unhide (reversible)
// Hiding revokes, in the same transaction, every api_key bound to an
// installation whose git email matches the hidden user_key.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-hidden-users-${process.pid}.sqlite`);
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

async function seedInstallation(db: any, orgId: string, id: string, gitEmail: string | null) {
  await db.run(
    `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, orgId, '2026-05-01T00:00:00Z', '2026-05-06T00:00:00Z', 'user', null, gitEmail],
  );
}

async function seedApiKey(db: any, orgId: string, tokenHash: string, installationId: string | null) {
  await db.run(
    `INSERT INTO api_keys (token_hash, org_id, label, installation_id) VALUES (?, ?, ?, ?)`,
    [tokenHash, orgId, 'test-key', installationId],
  );
}

describe('hidden-users admin API', () => {
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
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org-a', 'view@x', 'longenough1', 'viewer');
    cookieAdmin = await loginAs(app, 'admin@x', 'longenough1');
    cookieView = await loginAs(app, 'view@x', 'longenough1');
  });

  afterEach(async () => {
    // Drain in-flight responses before closing the DB — see helpers/drainApp.ts
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  describe('authz', () => {
    it('rejects unauthenticated requests', async () => {
      expect((await supertest(app).get('/v1/admin/hidden-users')).status).toBe(401);
      expect((await supertest(app).post('/v1/admin/hidden-users').send({ userKey: 'a@x' })).status).toBe(401);
      expect((await supertest(app).delete('/v1/admin/hidden-users/a@x')).status).toBe(401);
    });

    it('rejects non-admin sessions', async () => {
      expect((await supertest(app).get('/v1/admin/hidden-users').set('Cookie', cookieView)).status).toBe(403);
      expect((await supertest(app).post('/v1/admin/hidden-users').set('Cookie', cookieView).send({ userKey: 'a@x' })).status).toBe(403);
      expect((await supertest(app).delete('/v1/admin/hidden-users/a@x').set('Cookie', cookieView)).status).toBe(403);
    });
  });

  describe('POST /v1/admin/hidden-users', () => {
    it('hides a person and lists them afterwards', async () => {
      const r = await supertest(app)
        .post('/v1/admin/hidden-users')
        .set('Cookie', cookieAdmin)
        .send({ userKey: 'departed@acme.com' });
      expect(r.status).toBe(201);

      const list = await supertest(app).get('/v1/admin/hidden-users').set('Cookie', cookieAdmin);
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].userKey).toBe('departed@acme.com');
      expect(list.body[0].hiddenByEmail).toBe('admin@x');
      expect(list.body[0].createdAt).toBeTruthy();
    });

    it('normalizes the user_key to lowercase + trim', async () => {
      const r = await supertest(app)
        .post('/v1/admin/hidden-users')
        .set('Cookie', cookieAdmin)
        .send({ userKey: '  Departed@Acme.COM ' });
      expect(r.status).toBe(201);
      const list = await supertest(app).get('/v1/admin/hidden-users').set('Cookie', cookieAdmin);
      expect(list.body[0].userKey).toBe('departed@acme.com');
    });

    it('rejects a missing/invalid userKey', async () => {
      for (const body of [{}, { userKey: '' }, { userKey: '   ' }, { userKey: 42 }]) {
        const r = await supertest(app).post('/v1/admin/hidden-users').set('Cookie', cookieAdmin).send(body);
        expect(r.status).toBe(400);
      }
    });

    it('is idempotent — hiding an already-hidden person succeeds without duplicating', async () => {
      await supertest(app).post('/v1/admin/hidden-users').set('Cookie', cookieAdmin).send({ userKey: 'departed@acme.com' });
      const r = await supertest(app).post('/v1/admin/hidden-users').set('Cookie', cookieAdmin).send({ userKey: 'departed@acme.com' });
      expect([200, 201]).toContain(r.status);
      const list = await supertest(app).get('/v1/admin/hidden-users').set('Cookie', cookieAdmin);
      expect(list.body).toHaveLength(1);
    });

    it('revokes api_keys bound to the hidden person\'s installations, in the same transaction', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-1', 'departed@acme.com');
      await seedInstallation(ctx.db, 'org-a', 'inst-2', 'Departed@Acme.com'); // case-variant
      await seedInstallation(ctx.db, 'org-a', 'inst-3', 'active@acme.com');
      await seedApiKey(ctx.db, 'org-a', 'hash-departed-1', 'inst-1');
      await seedApiKey(ctx.db, 'org-a', 'hash-departed-2', 'inst-2');
      await seedApiKey(ctx.db, 'org-a', 'hash-active', 'inst-3');
      await seedApiKey(ctx.db, 'org-a', 'hash-unbound', null);

      const r = await supertest(app)
        .post('/v1/admin/hidden-users')
        .set('Cookie', cookieAdmin)
        .send({ userKey: 'departed@acme.com' });
      expect(r.status).toBe(201);
      expect(r.body.revokedApiKeys).toBe(2);

      const keys = await ctx.db.all(
        'SELECT token_hash, revoked_at FROM api_keys ORDER BY token_hash',
      );
      const byHash = Object.fromEntries(keys.map((k: any) => [k.token_hash, k.revoked_at]));
      expect(byHash['hash-departed-1']).toBeTruthy();
      expect(byHash['hash-departed-2']).toBeTruthy();
      expect(byHash['hash-active']).toBeNull();
      expect(byHash['hash-unbound']).toBeNull();
    });

    it('does not revoke api_keys from another org\'s installations even with matching email', async () => {
      await ctx.db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', ['org-b', 'org-b']);
      await seedInstallation(ctx.db, 'org-b', 'inst-b', 'departed@acme.com');
      await seedApiKey(ctx.db, 'org-b', 'hash-org-b', 'inst-b');

      await supertest(app).post('/v1/admin/hidden-users').set('Cookie', cookieAdmin).send({ userKey: 'departed@acme.com' });

      const key = await ctx.db.get<{ revoked_at: string | null }>(
        'SELECT revoked_at FROM api_keys WHERE token_hash = ?', ['hash-org-b'],
      );
      expect(key?.revoked_at).toBeNull();
    });
  });

  describe('DELETE /v1/admin/hidden-users/:userKey', () => {
    it('unhides a hidden person (reversible)', async () => {
      await supertest(app).post('/v1/admin/hidden-users').set('Cookie', cookieAdmin).send({ userKey: 'departed@acme.com' });
      const r = await supertest(app).delete('/v1/admin/hidden-users/departed%40acme.com').set('Cookie', cookieAdmin);
      expect(r.status).toBe(200);
      expect(r.body.unhidden).toBe(true);
      const list = await supertest(app).get('/v1/admin/hidden-users').set('Cookie', cookieAdmin);
      expect(list.body).toHaveLength(0);
    });

    it('returns 404 (or unhidden:false) when the person is not hidden', async () => {
      const r = await supertest(app).delete('/v1/admin/hidden-users/nobody%40acme.com').set('Cookie', cookieAdmin);
      expect([404, 200]).toContain(r.status);
      if (r.status === 200) expect(r.body.unhidden).toBe(false);
    });

    it('does not restore revoked api_keys (revocation is permanent)', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-1', 'departed@acme.com');
      await seedApiKey(ctx.db, 'org-a', 'hash-departed-1', 'inst-1');
      await supertest(app).post('/v1/admin/hidden-users').set('Cookie', cookieAdmin).send({ userKey: 'departed@acme.com' });
      await supertest(app).delete('/v1/admin/hidden-users/departed%40acme.com').set('Cookie', cookieAdmin);
      const key = await ctx.db.get<{ revoked_at: string | null }>(
        'SELECT revoked_at FROM api_keys WHERE token_hash = ?', ['hash-departed-1'],
      );
      expect(key?.revoked_at).toBeTruthy();
    });
  });

  describe('GET /v1/admin/hidden-users', () => {
    it('returns hidden people scoped to the caller org only', async () => {
      await ctx.db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', ['org-b', 'org-b']);
      await ctx.db.run(`INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)`, ['org-b', 'other@acme.com']);
      await supertest(app).post('/v1/admin/hidden-users').set('Cookie', cookieAdmin).send({ userKey: 'mine@acme.com' });

      const list = await supertest(app).get('/v1/admin/hidden-users').set('Cookie', cookieAdmin);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].userKey).toBe('mine@acme.com');
    });
  });
});
