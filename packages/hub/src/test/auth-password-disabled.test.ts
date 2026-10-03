/**
 * BUG cdb1b47f: switching "Email + password" off in Admin → Sign-in only hid
 * the form. POST /auth/login never read auth_config.password_enabled, so a
 * direct request with a valid password still signed in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { loginAs } from './helpers/loginAs';
import { createHubApp, configFromEnv } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

let server: any;
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-pw-disabled-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

let app: any;
let ctx: any;
const login = (email: string, password: string) => supertest(server).post('/auth/login').send({ email, password });

beforeEach(async () => {
  cleanup();
  const out = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' });
  app = out.app;
  if (server) await new Promise<void>(r => server.close(() => r()));
  server = app.listen(0);
  ctx = out.ctx;
  await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
});

afterEach(async () => {
  await drainApp(server);
  await ctx.db.close();
  cleanup();
});

/** Switch password sign-in off the way an admin does: Google set up first, then password off. */
async function switchPasswordOff() {
  const cookie = await loginAs(app, 'admin@x', 'longenough1');
  const r = await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie).send({
    passwordEnabled: false, googleEnabled: true,
    google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'shh' },
  });
  expect(r.status).toBe(200);
}

describe('POST /auth/login honours "Email + password" being switched off', () => {
  it('signs in while password sign-in is on', async () => {
    expect((await login('admin@x', 'longenough1')).status).toBe(200);
  });

  it('refuses a correct password once password sign-in is off, and sets no cookie', async () => {
    await switchPasswordOff();
    const r = await login('admin@x', 'longenough1');
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/password sign-in is not enabled/i);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('answers an unknown email exactly as a known one, so it cannot be used to find accounts', async () => {
    await switchPasswordOff();
    const known = await login('admin@x', 'wrongpassword1');
    const unknown = await login('nobody@x', 'wrongpassword1');
    expect(known.status).toBe(403);
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });

  it('does not count refused attempts towards the account lockout', async () => {
    await switchPasswordOff();
    for (let i = 0; i < 6; i++) await login('admin@x', 'wrongpassword1');
    await ctx.db.run('UPDATE auth_config SET password_enabled = 1 WHERE org_id = ?', ['org']);
    expect((await login('admin@x', 'longenough1')).status).toBe(200);
  });

  it('signs in again once password sign-in is switched back on', async () => {
    await switchPasswordOff();
    await ctx.db.run('UPDATE auth_config SET password_enabled = 1 WHERE org_id = ?', ['org']);
    expect((await login('admin@x', 'longenough1')).status).toBe(200);
  });

  // Boot seeds the row, so at runtime it is missing only when this process's
  // org id is stale (an org rename on another replica). Fail closed, as
  // /auth/providers and the SSO routes do.
  it('refuses password sign-in when the org has no auth_config row', async () => {
    await ctx.db.run('DELETE FROM auth_config WHERE org_id = ?', ['org']);
    expect((await login('admin@x', 'longenough1')).status).toBe(403);
  });
});

/**
 * Break-glass: an admin who switched password off and then lost SSO (a wrong
 * secret, a revoked app, an IdP outage) has no way back in. The operator sets
 * AGENFK_HUB_FORCE_PASSWORD_LOGIN=1 on the server, signs in with a password,
 * repairs the config, and unsets it. Server access is the same trust as the
 * database, which was the only way back before.
 */
describe('AGENFK_HUB_FORCE_PASSWORD_LOGIN', () => {
  async function bootForced() {
    await drainApp(server);
    await ctx.db.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org', forcePasswordLogin: true });
    app = out.app;
    await new Promise<void>(r => server.close(() => r()));
    server = app.listen(0);
    ctx = out.ctx;
    return warn;
  }

  it('lets password sign-in through while password sign-in is off, and shows the form', async () => {
    await switchPasswordOff();
    const warn = await bootForced();
    expect((await login('admin@x', 'longenough1')).status).toBe(200);
    expect((await supertest(server).get('/auth/providers')).body.password).toBe(true);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/AGENFK_HUB_FORCE_PASSWORD_LOGIN/);
    warn.mockRestore();
  });

  it('still checks the password', async () => {
    await switchPasswordOff();
    const warn = await bootForced();
    expect((await login('admin@x', 'wrongpassword1')).status).toBe(401);
    warn.mockRestore();
  });

  it('is read from the environment only when set to exactly 1', () => {
    const saved = { ...process.env };
    try {
      process.env.AGENFK_HUB_SECRET_KEY = 'a'.repeat(64);
      process.env.AGENFK_HUB_SESSION_SECRET = 's';
      delete process.env.AGENFK_HUB_FORCE_PASSWORD_LOGIN;
      expect(configFromEnv().forcePasswordLogin).toBe(false);
      process.env.AGENFK_HUB_FORCE_PASSWORD_LOGIN = 'true';
      expect(configFromEnv().forcePasswordLogin).toBe(false);
      process.env.AGENFK_HUB_FORCE_PASSWORD_LOGIN = '1';
      expect(configFromEnv().forcePasswordLogin).toBe(true);
    } finally {
      process.env = saved;
    }
  });
});
