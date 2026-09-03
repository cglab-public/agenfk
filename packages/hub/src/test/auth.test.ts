import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-auth-test-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('hub auth + setup', () => {
  let app: any;
  let ctx: any;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: '0'.repeat(64),
      sessionSecret: 'test-session-secret-min-32-bytes-please',
      defaultOrgId: 'org',
    });
    app = out.app;
    ctx = out.ctx;
  });

  afterEach(async () => {
    // Drain in-flight responses before closing the DB — see helpers/drainApp.ts
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  it('GET /auth/providers reflects requiresSetup when no users exist', async () => {
    const r = await supertest(app).get('/auth/providers');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ password: true, google: false, entra: false, requiresSetup: true });
  });

  it('POST /setup/initial-admin creates the first admin', async () => {
    const tok = (await ctx.db.get('SELECT token FROM bootstrap_tokens LIMIT 1') as { token: string } | undefined)?.token;
    const r = await supertest(app).post('/setup/initial-admin').send({ token: tok, email: 'first@x', password: 'longenough1' });
    expect(r.status).toBe(201);
    const r2 = await supertest(app).post('/setup/initial-admin').send({ token: tok, email: 'second@x', password: 'longenough2' });
    expect(r2.status).toBe(409);
  });

  it('rejects short passwords on /setup/initial-admin', async () => {
    const tok = (await ctx.db.get('SELECT token FROM bootstrap_tokens LIMIT 1') as { token: string } | undefined)?.token;
    const r = await supertest(app).post('/setup/initial-admin').send({ token: tok, email: 'a@b', password: 'short' });
    expect(r.status).toBe(400);
  });

  it('does NOT auto-create an admin from initialAdminEmail/Password env on /auth/login (env-var bootstrap removed)', async () => {
    // Even if a deployment still passes the legacy fields, the login route
    // ignores them — the only interactive bootstrap is /setup/initial-admin
    // gated by the stdout token.
    const r = await supertest(app)
      .post('/auth/login')
      .send({ email: 'boot@example.com', password: 'bootpass1' });
    expect(r.status).toBe(401);
    const users = await ctx.db.all('SELECT id FROM users');
    expect(users).toHaveLength(0);
  });

  it('ignores legacy initialAdminEmail/Password fields even when passed via deployment config', async () => {
    // Tear down the default app and rebuild with the legacy fields supplied
    // by a stale deployment manifest. Type-cast bypasses the now-removed
    // optional fields to simulate a deployment that hasn't been updated yet.
    await ctx.db.close();
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: '0'.repeat(64),
      sessionSecret: 'test-session-secret-min-32-bytes-please',
      defaultOrgId: 'org',
      initialAdminEmail: 'legacy@example.com',
      initialAdminPassword: 'legacypass1',
    } as any);
    app = out.app;
    ctx = out.ctx;

    const r = await supertest(app)
      .post('/auth/login')
      .send({ email: 'legacy@example.com', password: 'legacypass1' });
    expect(r.status).toBe(401);
    const users = await ctx.db.all('SELECT id FROM users');
    expect(users).toHaveLength(0);
  });

  it('login fails with wrong password', async () => {
    await createPasswordUser(ctx.db, 'org', 'alice@example.com', 'rightpassword', 'viewer');
    const r = await supertest(app).post('/auth/login').send({ email: 'alice@example.com', password: 'wrongpassword' });
    expect(r.status).toBe(401);
  });

  it('login is case-insensitive on email', async () => {
    await createPasswordUser(ctx.db, 'org', 'Alice@Example.com', 'rightpassword', 'viewer');
    const r = await supertest(app).post('/auth/login').send({ email: 'alice@example.COM', password: 'rightpassword' });
    expect(r.status).toBe(200);
  });

  it('logout clears the session cookie', async () => {
    await createPasswordUser(ctx.db, 'org', 'a@b.com', 'rightpassword', 'viewer');
    const login = await supertest(app).post('/auth/login').send({ email: 'a@b.com', password: 'rightpassword' });
    const cookie = login.headers['set-cookie']?.[0];
    const out = await supertest(app).post('/auth/logout').set('Cookie', cookie);
    expect(out.status).toBe(200);
    const me = await supertest(app).get('/auth/me').set('Cookie', out.headers['set-cookie']?.[0] ?? '');
    expect(me.status).toBe(401);
  });

  it('GET /auth/me without cookie returns 401', async () => {
    const r = await supertest(app).get('/auth/me');
    expect(r.status).toBe(401);
  });
});
