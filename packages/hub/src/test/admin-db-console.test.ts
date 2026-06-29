import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-dbconsole-test-${process.pid}.sqlite`);
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

describe('admin db-console routes', () => {
  let app: any;
  let ctx: any;

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
    await createPasswordUser(ctx.db, 'org', 'view@x', 'longenough1', 'viewer');
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  // ---- schema introspection ----
  describe('GET /v1/admin/db-console/schema', () => {
    it('rejects anonymous (401)', async () => {
      const r = await supertest(app).get('/v1/admin/db-console/schema');
      expect(r.status).toBe(401);
    });
    it('rejects viewer (403)', async () => {
      const cookie = await loginAs(app, 'view@x', 'longenough1');
      const r = await supertest(app).get('/v1/admin/db-console/schema').set('Cookie', cookie);
      expect(r.status).toBe(403);
    });
    it('admin gets tables and columns', async () => {
      const cookie = await loginAs(app, 'admin@x', 'longenough1');
      const r = await supertest(app).get('/v1/admin/db-console/schema').set('Cookie', cookie);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.tables)).toBe(true);
      const names = r.body.tables.map((t: any) => t.name);
      expect(names).toContain('orgs');
      expect(names).toContain('users');
      expect(names).toContain('events');
      const users = r.body.tables.find((t: any) => t.name === 'users');
      const colNames = users.columns.map((c: any) => c.name);
      expect(colNames).toContain('email');
      expect(colNames).toContain('role');
    });
  });

  // ---- query execution ----
  describe('POST /v1/admin/db-console/query', () => {
    it('rejects anonymous (401)', async () => {
      const r = await supertest(app).post('/v1/admin/db-console/query').send({ sql: 'SELECT 1' });
      expect(r.status).toBe(401);
    });
    it('rejects viewer (403)', async () => {
      const cookie = await loginAs(app, 'view@x', 'longenough1');
      const r = await supertest(app).post('/v1/admin/db-console/query').set('Cookie', cookie).send({ sql: 'SELECT 1' });
      expect(r.status).toBe(403);
    });

    it('admin runs a read-only SELECT and gets columns + rows', async () => {
      const cookie = await loginAs(app, 'admin@x', 'longenough1');
      const r = await supertest(app).post('/v1/admin/db-console/query').set('Cookie', cookie)
        .send({ sql: 'SELECT id, name FROM orgs' });
      expect(r.status).toBe(200);
      expect(r.body.columns).toEqual(expect.arrayContaining(['id', 'name']));
      expect(r.body.rowCount).toBeGreaterThanOrEqual(1);
      expect(r.body.rows[0].id).toBe('org');
      expect(r.body.truncated).toBe(false);
    });

    it('blocks a write and does not mutate data', async () => {
      const cookie = await loginAs(app, 'admin@x', 'longenough1');
      const r = await supertest(app).post('/v1/admin/db-console/query').set('Cookie', cookie)
        .send({ sql: 'DELETE FROM users' });
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toMatch(/read-only|only.*select/i);
      const rows = await ctx.db.all('SELECT id FROM users');
      expect(rows.length).toBe(2); // both seeded users intact
    });

    it('blocks multiple statements', async () => {
      const cookie = await loginAs(app, 'admin@x', 'longenough1');
      const r = await supertest(app).post('/v1/admin/db-console/query').set('Cookie', cookie)
        .send({ sql: 'SELECT 1; DROP TABLE orgs' });
      expect(r.status).toBe(400);
      const t = await ctx.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='orgs'");
      expect(t.length).toBe(1); // orgs table still exists
    });

    it('caps result rows and flags truncation', async () => {
      const cookie = await loginAs(app, 'admin@x', 'longenough1');
      const r = await supertest(app).post('/v1/admin/db-console/query').set('Cookie', cookie)
        .send({ sql: 'SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3', limit: 2 });
      expect(r.status).toBe(200);
      expect(r.body.rows.length).toBe(2);
      expect(r.body.truncated).toBe(true);
    });

    it('rejects a missing/non-string sql body (400)', async () => {
      const cookie = await loginAs(app, 'admin@x', 'longenough1');
      const r = await supertest(app).post('/v1/admin/db-console/query').set('Cookie', cookie)
        .send({ limit: 10 });
      expect(r.status).toBe(400);
    });

    it('clamps an over-large limit to the maximum', async () => {
      const cookie = await loginAs(app, 'admin@x', 'longenough1');
      const r = await supertest(app).post('/v1/admin/db-console/query').set('Cookie', cookie)
        .send({ sql: 'SELECT 1 AS n', limit: 999999 });
      expect(r.status).toBe(200);
      expect(r.body.truncated).toBe(false);
      expect(r.body.rowCount).toBe(1);
    });

    it('returns a structured error for invalid SQL', async () => {
      const cookie = await loginAs(app, 'admin@x', 'longenough1');
      const r = await supertest(app).post('/v1/admin/db-console/query').set('Cookie', cookie)
        .send({ sql: 'SELECT * FROM no_such_table_here' });
      expect(r.status).toBe(400);
      expect(typeof r.body.error).toBe('string');
    });
  });
});
