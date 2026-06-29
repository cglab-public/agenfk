import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-savedq-test-${process.pid}.sqlite`);
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

describe('saved queries routes', () => {
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
    await createPasswordUser(ctx.db, 'org', 'admin2@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org', 'view@x', 'longenough1', 'viewer');
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  it('rejects anonymous (401) and viewer (403)', async () => {
    const anon = await supertest(app).get('/v1/admin/saved-queries');
    expect(anon.status).toBe(401);
    const cookie = await loginAs(app, 'view@x', 'longenough1');
    const v = await supertest(app).get('/v1/admin/saved-queries').set('Cookie', cookie);
    expect(v.status).toBe(403);
  });

  it('creates and lists a saved query for the owner', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const created = await supertest(app).post('/v1/admin/saved-queries').set('Cookie', cookie)
      .send({ name: 'Recent events', sql: 'SELECT * FROM events', description: 'last events' });
    expect(created.status).toBe(201);
    expect(typeof created.body.id).toBe('string');
    expect(created.body.name).toBe('Recent events');
    expect(created.body.sql).toBe('SELECT * FROM events');

    const list = await supertest(app).get('/v1/admin/saved-queries').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);
    expect(list.body[0].name).toBe('Recent events');
  });

  it('isolates saved queries per user', async () => {
    const c1 = await loginAs(app, 'admin@x', 'longenough1');
    await supertest(app).post('/v1/admin/saved-queries').set('Cookie', c1)
      .send({ name: 'mine', sql: 'SELECT 1' });

    const c2 = await loginAs(app, 'admin2@x', 'longenough1');
    const list2 = await supertest(app).get('/v1/admin/saved-queries').set('Cookie', c2);
    expect(list2.status).toBe(200);
    expect(list2.body.length).toBe(0); // admin2 cannot see admin1's query
  });

  it('updates an owned query (rename + edit SQL)', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const created = await supertest(app).post('/v1/admin/saved-queries').set('Cookie', cookie)
      .send({ name: 'orig', sql: 'SELECT 1' });
    const id = created.body.id;
    const upd = await supertest(app).put(`/v1/admin/saved-queries/${id}`).set('Cookie', cookie)
      .send({ name: 'renamed', sql: 'SELECT 2' });
    expect(upd.status).toBe(200);
    expect(upd.body.name).toBe('renamed');
    expect(upd.body.sql).toBe('SELECT 2');
  });

  it('cannot update or delete another user\'s query (404)', async () => {
    const c1 = await loginAs(app, 'admin@x', 'longenough1');
    const created = await supertest(app).post('/v1/admin/saved-queries').set('Cookie', c1)
      .send({ name: 'mine', sql: 'SELECT 1' });
    const id = created.body.id;

    const c2 = await loginAs(app, 'admin2@x', 'longenough1');
    const upd = await supertest(app).put(`/v1/admin/saved-queries/${id}`).set('Cookie', c2)
      .send({ name: 'hijack' });
    expect(upd.status).toBe(404);
    const del = await supertest(app).delete(`/v1/admin/saved-queries/${id}`).set('Cookie', c2);
    expect(del.status).toBe(404);

    // still present for the real owner
    const list1 = await supertest(app).get('/v1/admin/saved-queries').set('Cookie', c1);
    expect(list1.body.length).toBe(1);
  });

  it('deletes an owned query', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const created = await supertest(app).post('/v1/admin/saved-queries').set('Cookie', cookie)
      .send({ name: 'tmp', sql: 'SELECT 1' });
    const id = created.body.id;
    const del = await supertest(app).delete(`/v1/admin/saved-queries/${id}`).set('Cookie', cookie);
    expect(del.status).toBe(204);
    const list = await supertest(app).get('/v1/admin/saved-queries').set('Cookie', cookie);
    expect(list.body.length).toBe(0);
  });

  it('rejects creation with a missing name or sql (400)', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const noName = await supertest(app).post('/v1/admin/saved-queries').set('Cookie', cookie)
      .send({ sql: 'SELECT 1' });
    expect(noName.status).toBe(400);
    const noSql = await supertest(app).post('/v1/admin/saved-queries').set('Cookie', cookie)
      .send({ name: 'x' });
    expect(noSql.status).toBe(400);
  });
});
