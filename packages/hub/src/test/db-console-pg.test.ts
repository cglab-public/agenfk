// Exercise the admin DB console + saved queries against in-process Postgres
// (pg-mem), so the postgres introspection branch and the dialect-translated
// saved-query CRUD are covered (the SQLite specs don't reach those paths).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openPgMemDb } from '../db/postgres';
import { createPasswordUser } from '../auth/password';
import type { HubDb } from '../db/types';

const SECRET = 'a'.repeat(64);

const loginAs = async (app: any, email: string, password: string) => {
  const r = await supertest(app).post('/auth/login').send({ email, password });
  return r.headers['set-cookie']?.[0] ?? '';
};

describe('admin db console + saved queries on Postgres (pg-mem)', () => {
  let app: any;
  let db: HubDb;

  beforeEach(async () => {
    db = await openPgMemDb();
    const out = await createHubApp({
      dbPath: '/tmp/unused-pg-mem-dbconsole.sqlite',
      secretKey: SECRET,
      sessionSecret: 'sess-secret',
      defaultOrgId: 'org',
      db,
    });
    app = out.app;
    await createPasswordUser(db, 'org', 'admin@x', 'longenough1', 'admin');
  });

  afterEach(async () => { try { await db.close(); } catch { /* */ } });

  it('introspects the schema via information_schema', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(app).get('/v1/admin/db-console/schema').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.backend).toBe('postgres');
    const names = r.body.tables.map((t: any) => t.name);
    expect(names).toContain('orgs');
    expect(names).toContain('users');
    const users = r.body.tables.find((t: any) => t.name === 'users');
    const colNames = users.columns.map((c: any) => c.name);
    expect(colNames).toContain('email');
    expect(colNames).toContain('role');
    // pk detection runs the table_constraints/key_column_usage join; pg-mem
    // doesn't populate those catalogs (real Postgres does), so we only assert
    // the column is present and pk is a boolean here.
    const idCol = users.columns.find((c: any) => c.name === 'id');
    expect(idCol).toBeDefined();
    expect(typeof idCol.pk).toBe('boolean');
  });

  it('runs a read-only query and blocks writes', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const ok = await supertest(app).post('/v1/admin/db-console/query').set('Cookie', cookie)
      .send({ sql: 'SELECT id, name FROM orgs' });
    expect(ok.status).toBe(200);
    expect(ok.body.rows[0].id).toBe('org');

    const bad = await supertest(app).post('/v1/admin/db-console/query').set('Cookie', cookie)
      .send({ sql: 'DELETE FROM users' });
    expect(bad.status).toBe(400);
  });

  it('creates and lists a saved query', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const created = await supertest(app).post('/v1/admin/saved-queries').set('Cookie', cookie)
      .send({ name: 'pg q', sql: 'SELECT 1' });
    expect(created.status).toBe(201);
    const list = await supertest(app).get('/v1/admin/saved-queries').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);
    expect(list.body[0].name).toBe('pg q');
  });
});
