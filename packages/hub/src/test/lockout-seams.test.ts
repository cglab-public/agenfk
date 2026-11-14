/**
 * BUG 928234fb: lockouts across the seams of the admin-safety epic, found by
 * its epic-level review.
 *
 * (1) The break-glass (AGENFK_HUB_FORCE_PASSWORD_LOGIN) refused the very admin
 *     it exists for: one SSO sign-in rewrites a password account's provider to
 *     google/entra, and /auth/login refused any non-password provider.
 * (2) Demote / deactivate / delete only counted active admins, while the
 *     sign-in config guard asks whether an admin can actually sign in. An
 *     admin outside the allowlist, on a session from before it tightened,
 *     could remove the last admin who could.
 * (3) The config guard's refusal named the wrong reason when password was on
 *     but no admin had a password account.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { loginAs } from './helpers/loginAs';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { encryptSecret } from '../crypto';
import { drainApp } from './helpers/drainApp';

const SECRET = 'a'.repeat(64);
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-lockout-seams-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

let server: any;
let app: any;
let ctx: any;

async function boot(forcePasswordLogin = false) {
  if (ctx) { await drainApp(server); await ctx.db.close(); }
  const out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org', forcePasswordLogin });
  app = out.app;
  if (server) await new Promise<void>(r => server.close(() => r()));
  server = app.listen(0);
  ctx = out.ctx;
}
const idOf = async (email: string) => (await ctx.db.get('SELECT id FROM users WHERE email = ?', [email])).id as string;
/** What one Google sign-in does to an invited password account (oauth.ts findInvitedSsoUser). */
const signedInWithGoogleOnce = (email: string) =>
  ctx.db.run("UPDATE users SET provider = 'google', provider_subject = ? WHERE email = ?", [`sub-${email}`, email]);
/** Password off; Google complete; optional allowlist. Written directly: this is the stored state, not a save. */
const ssoOnly = (allowlist: string[] | null) => ctx.db.run(
  `UPDATE auth_config SET password_enabled = 0, google_enabled = 1, google_client_id = 'id.apps.googleusercontent.com',
     google_client_secret_enc = ?, email_allowlist = ? WHERE org_id = 'org'`,
  [encryptSecret('shh', SECRET), allowlist ? JSON.stringify(allowlist) : null],
);

beforeEach(async () => {
  cleanup();
  ctx = undefined;
  await boot();
});
afterEach(async () => {
  await drainApp(server);
  await ctx.db.close();
  cleanup();
});

describe('(1) the break-glass works for an admin SSO has moved off password', () => {
  it('signs in with the password under AGENFK_HUB_FORCE_PASSWORD_LOGIN, password off and SSO broken', async () => {
    await createPasswordUser(ctx.db, 'org', 'admin@corp.com', 'longenough1', 'admin');
    await signedInWithGoogleOnce('admin@corp.com');
    await ssoOnly(null);
    // Google's secret is revoked: SSO is broken, password is off.
    await boot(true);
    const r = await supertest(server).post('/auth/login').send({ email: 'admin@corp.com', password: 'longenough1' });
    expect(r.status).toBe(200);
  });

  it('still checks the password', async () => {
    await createPasswordUser(ctx.db, 'org', 'admin@corp.com', 'longenough1', 'admin');
    await signedInWithGoogleOnce('admin@corp.com');
    await ssoOnly(null);
    await boot(true);
    expect((await supertest(server).post('/auth/login').send({ email: 'admin@corp.com', password: 'wrongpassword1' })).status).toBe(401);
  });

  it('the break-glass lets admins through, not every account SSO moved off password', async () => {
    await createPasswordUser(ctx.db, 'org', 'viewer@corp.com', 'longenough1', 'viewer');
    await signedInWithGoogleOnce('viewer@corp.com');
    await boot(true);
    const r = await supertest(server).post('/auth/login').send({ email: 'viewer@corp.com', password: 'longenough1' });
    expect(r.status).toBe(401);
  });

  it('without the break-glass, an SSO account still cannot use its old password', async () => {
    await createPasswordUser(ctx.db, 'org', 'admin@corp.com', 'longenough1', 'admin');
    await signedInWithGoogleOnce('admin@corp.com');
    const r = await supertest(server).post('/auth/login').send({ email: 'admin@corp.com', password: 'longenough1' });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/signs in with google/);
  });
});

describe('(2) removing an admin is refused when no remaining admin could sign in', () => {
  // A (a@corp.com) signs in with Google. B (b@contractor.com) is a password
  // admin whose session predates the switch to Google-only with a corp.com
  // allowlist. B is an active admin, so the old count let B remove A.
  async function strandedB() {
    await createPasswordUser(ctx.db, 'org', 'a@corp.com', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org', 'b@contractor.com', 'longenough1', 'admin');
    await signedInWithGoogleOnce('a@corp.com');
    const b = await loginAs(app, 'b@contractor.com', 'longenough1');
    await ssoOnly(['corp.com']);
    return b;
  }

  it('refuses to deactivate the last admin who can sign in', async () => {
    const b = await strandedB();
    const r = await supertest(server).put(`/v1/admin/users/${await idOf('a@corp.com')}`).set('Cookie', b).send({ active: false });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no admin .*able to sign in/i);
    expect(Number((await ctx.db.get('SELECT active FROM users WHERE email = ?', ['a@corp.com'])).active)).toBe(1);
  });

  it('refuses to demote the last admin who can sign in', async () => {
    const b = await strandedB();
    const r = await supertest(server).put(`/v1/admin/users/${await idOf('a@corp.com')}`).set('Cookie', b).send({ role: 'viewer' });
    expect(r.status).toBe(409);
  });

  it('refuses to delete the last admin who can sign in', async () => {
    const b = await strandedB();
    const r = await supertest(server).delete(`/v1/admin/users/${await idOf('a@corp.com')}`).set('Cookie', b);
    expect(r.status).toBe(409);
    expect(await ctx.db.get('SELECT id FROM users WHERE email = ?', ['a@corp.com'])).toBeTruthy();
  });

  it('allows it while another admin who can sign in remains', async () => {
    const b = await strandedB();
    await createPasswordUser(ctx.db, 'org', 'c@corp.com', 'longenough1', 'admin');
    await signedInWithGoogleOnce('c@corp.com');
    const r = await supertest(server).put(`/v1/admin/users/${await idOf('a@corp.com')}`).set('Cookie', b).send({ active: false });
    expect(r.status).toBe(200);
  });

  it('a change that does not touch admin access is never refused for this', async () => {
    const b = await strandedB();
    const r = await supertest(server).put(`/v1/admin/users/${await idOf('a@corp.com')}`).set('Cookie', b).send({ password: 'brandnewpass' });
    expect(r.status).toBe(200);
  });
});

describe('(3) the sign-in config refusal names the real reason', () => {
  it('says no admin has a password account when password is on but every admin moved to SSO', async () => {
    await createPasswordUser(ctx.db, 'org', 'admin@corp.com', 'longenough1', 'admin');
    await ctx.db.run(
      "UPDATE auth_config SET google_enabled = 1, google_client_id = 'id', google_client_secret_enc = ? WHERE org_id = 'org'",
      [encryptSecret('shh', SECRET)],
    );
    const cookie = await loginAs(app, 'admin@corp.com', 'longenough1');
    await signedInWithGoogleOnce('admin@corp.com');
    const r = await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie).send({ googleEnabled: false });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no admin has an email \+ password account/i);
    expect(r.body.error).not.toMatch(/keep email \+ password on/i);
  });
});
