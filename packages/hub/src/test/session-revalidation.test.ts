/**
 * BUG 8ef3ed7d: the hub's session guards trusted the role baked into the
 * session JWT for its whole 12-hour life. A demoted admin kept admin access
 * (and could re-promote themselves), and a deactivated or deleted user kept
 * whatever they had. The guards now read the user's row on every request.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { loginAs } from './helpers/loginAs';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';
import { SESSION_USER_SQL } from '../auth/session';

let server: any;
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-session-reval-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

let app: any;
let ctx: any;
const idOf = async (email: string) => (await ctx.db.get('SELECT id FROM users WHERE email = ?', [email])).id as string;

beforeEach(async () => {
  cleanup();
  const out = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' });
  app = out.app;
  if (server) await new Promise<void>(r => server.close(() => r()));
  server = app.listen(0);
  ctx = out.ctx;
  await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
  await createPasswordUser(ctx.db, 'org', 'admin2@x', 'longenough1', 'admin');
  await createPasswordUser(ctx.db, 'org', 'view@x', 'longenough1', 'viewer');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await drainApp(server);
  await ctx.db.close();
  cleanup();
});

describe('admin routes read the role from the database, not the cookie', () => {
  it('a demoted admin\'s existing session loses admin access at once', async () => {
    const a = await loginAs(app, 'admin@x', 'longenough1');
    const b = await loginAs(app, 'admin2@x', 'longenough1');
    expect((await supertest(server).get('/v1/admin/users').set('Cookie', b)).status).toBe(200);
    await supertest(server).put(`/v1/admin/users/${await idOf('admin2@x')}`).set('Cookie', a).send({ role: 'viewer' });

    const r = await supertest(server).get('/v1/admin/users').set('Cookie', b);
    expect(r.status).toBe(403);
  });

  it('a demoted admin cannot promote themselves back', async () => {
    const a = await loginAs(app, 'admin@x', 'longenough1');
    const b = await loginAs(app, 'admin2@x', 'longenough1');
    const id = await idOf('admin2@x');
    await supertest(server).put(`/v1/admin/users/${id}`).set('Cookie', a).send({ role: 'viewer' });

    const r = await supertest(server).put(`/v1/admin/users/${id}`).set('Cookie', b).send({ role: 'admin' });
    expect(r.status).toBe(403);
    expect((await ctx.db.get('SELECT role FROM users WHERE id = ?', [id])).role).toBe('viewer');
  });

  it('a promoted viewer gets admin access without signing in again', async () => {
    const a = await loginAs(app, 'admin@x', 'longenough1');
    const v = await loginAs(app, 'view@x', 'longenough1');
    expect((await supertest(server).get('/v1/admin/users').set('Cookie', v)).status).toBe(403);
    await supertest(server).put(`/v1/admin/users/${await idOf('view@x')}`).set('Cookie', a).send({ role: 'admin' });
    expect((await supertest(server).get('/v1/admin/users').set('Cookie', v)).status).toBe(200);
  });

  it('a deactivated admin\'s session is signed out of admin routes', async () => {
    const a = await loginAs(app, 'admin@x', 'longenough1');
    const b = await loginAs(app, 'admin2@x', 'longenough1');
    await supertest(server).put(`/v1/admin/users/${await idOf('admin2@x')}`).set('Cookie', a).send({ active: false });
    expect((await supertest(server).get('/v1/admin/users').set('Cookie', b)).status).toBe(401);
  });

  it('the guard covers routers other than /v1/admin (org rename)', async () => {
    const a = await loginAs(app, 'admin@x', 'longenough1');
    const b = await loginAs(app, 'admin2@x', 'longenough1');
    await supertest(server).put(`/v1/admin/users/${await idOf('admin2@x')}`).set('Cookie', a).send({ role: 'viewer' });
    const r = await supertest(server).post('/v1/admin/orgs/rename').set('Cookie', b).send({ from: 'org', to: 'stolen-org' });
    expect(r.status).toBe(403);
    expect(await ctx.db.get('SELECT id FROM orgs WHERE id = ?', ['stolen-org'])).toBeFalsy();
  });
});

describe('every signed-in route refuses a user who is gone or switched off', () => {
  it('a deactivated viewer loses the dashboards', async () => {
    const a = await loginAs(app, 'admin@x', 'longenough1');
    const v = await loginAs(app, 'view@x', 'longenough1');
    expect((await supertest(server).get('/v1/users').set('Cookie', v)).status).toBe(200);
    await supertest(server).put(`/v1/admin/users/${await idOf('view@x')}`).set('Cookie', a).send({ active: false });

    expect((await supertest(server).get('/v1/users').set('Cookie', v)).status).toBe(401);
    expect((await supertest(server).get('/auth/me').set('Cookie', v)).status).toBe(401);
  });

  it('a deleted user\'s session stops working', async () => {
    const a = await loginAs(app, 'admin@x', 'longenough1');
    const v = await loginAs(app, 'view@x', 'longenough1');
    await supertest(server).delete(`/v1/admin/users/${await idOf('view@x')}`).set('Cookie', a);
    expect((await supertest(server).get('/v1/users').set('Cookie', v)).status).toBe(401);
  });

  // An org rename moves every user row to the new org id but re-signs only the
  // caller's cookie. Everyone else's cookie still names the old org, which no
  // longer exists: they are signed out cleanly rather than querying nothing.
  it('after an org rename, other users\' cookies stop working and the renamer\'s keeps working', async () => {
    const a = await loginAs(app, 'admin@x', 'longenough1');
    const v = await loginAs(app, 'view@x', 'longenough1');
    const renamed = await supertest(server).post('/v1/admin/orgs/rename').set('Cookie', a).send({ from: 'org', to: 'new-org' });
    expect(renamed.status).toBe(200);
    const a2 = renamed.headers['set-cookie']?.[0] as string;

    expect((await supertest(server).get('/v1/users').set('Cookie', v)).status).toBe(401);
    expect((await supertest(server).get('/v1/admin/users').set('Cookie', a2)).status).toBe(200);
    // The renamer's old cookie names the old org too: only the re-signed one works.
    expect((await supertest(server).get('/v1/admin/users').set('Cookie', a)).status).toBe(401);
  });

  it('a session still works for an active user', async () => {
    const v = await loginAs(app, 'view@x', 'longenough1');
    const r = await supertest(server).get('/auth/me').set('Cookie', v);
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('viewer');
  });

  it('/auth/me reports the role the database holds now', async () => {
    const a = await loginAs(app, 'admin@x', 'longenough1');
    const b = await loginAs(app, 'admin2@x', 'longenough1');
    await supertest(server).put(`/v1/admin/users/${await idOf('admin2@x')}`).set('Cookie', a).send({ role: 'viewer' });
    expect((await supertest(server).get('/auth/me').set('Cookie', b)).body.role).toBe('viewer');
  });

  // express 4 drops a rejected middleware promise: without handling, a DB error
  // in the guard would leave the request hanging with no response at all.
  it('a database error in the guard answers 500 instead of hanging', async () => {
    const v = await loginAs(app, 'view@x', 'longenough1');
    const realGet = ctx.db.get.bind(ctx.db);
    vi.spyOn(ctx.db, 'get').mockImplementation(async (sql: unknown, params?: unknown) => {
      if (sql === SESSION_USER_SQL) throw new Error('db down');
      return realGet(sql, params);
    });
    const r = await supertest(server).get('/v1/users').set('Cookie', v).timeout(5000);
    expect(r.status).toBe(500);
  });
});
