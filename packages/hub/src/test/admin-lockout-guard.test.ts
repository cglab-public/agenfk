/**
 * [UX] Admin safety: an admin could lock everyone out. PUT /users/:id let the
 * only admin demote or deactivate themselves (only DELETE was guarded), and
 * PUT /auth-config saved with every sign-in method switched off.
 *
 * The server is the guard; the UI only hides controls that would be refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { loginAs } from './helpers/loginAs';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';
import { raceBehindGuard } from './helpers/raceBehindGuard';
import { ACTIVE_ADMINS_SQL } from '../routes/admin';
import { adminCanStillSignIn } from '../routes/admin';

let server: any;
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-lockout-test-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

let app: any;
let ctx: any;
const userId = async (email: string) => (await ctx.db.get('SELECT id FROM users WHERE email = ?', [email])).id as string;
const userRow = async (email: string) => ctx.db.get('SELECT role, active FROM users WHERE email = ?', [email]);

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
  await drainApp(server);
  await ctx.db.close();
  cleanup();
});

describe('PUT /users/:id refuses changes that lock admins out', () => {
  it('refuses to demote the signed-in user, and leaves the row unchanged', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(server).put(`/v1/admin/users/${await userId('admin@x')}`).set('Cookie', cookie).send({ role: 'viewer' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/your own/i);
    expect((await userRow('admin@x')).role).toBe('admin');
  });

  it('refuses to deactivate the signed-in user', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(server).put(`/v1/admin/users/${await userId('admin@x')}`).set('Cookie', cookie).send({ active: false });
    expect(r.status).toBe(400);
    expect(Number((await userRow('admin@x')).active)).toBe(1);
  });

  it('still lets the signed-in user change their own password', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(server).put(`/v1/admin/users/${await userId('admin@x')}`).set('Cookie', cookie).send({ password: 'brandnewpass' });
    expect(r.status).toBe(200);
  });

  it('still lets an admin demote and deactivate ANOTHER admin while one active admin remains', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const id = await userId('admin2@x');
    expect((await supertest(server).put(`/v1/admin/users/${id}`).set('Cookie', cookie).send({ role: 'viewer' })).status).toBe(200);
    expect((await supertest(server).put(`/v1/admin/users/${id}`).set('Cookie', cookie).send({ active: false })).status).toBe(200);
    const row = await userRow('admin2@x');
    expect(row.role).toBe('viewer');
    expect(Number(row.active)).toBe(0);
  });

  // The session guard reads the actor's row, then the route writes. Two admins
  // demoting each other can each pass the guard before either write lands; the
  // last-admin condition in the UPDATE is what keeps one admin standing.
  // (A stale session no longer reaches the route at all: BUG 8ef3ed7d.)
  it('refuses to demote the last active admin when a cross-demotion lands between guard and write', async () => {
    const a = await loginAs(app, 'admin@x', 'longenough1');
    const b = await loginAs(app, 'admin2@x', 'longenough1');
    const r = await raceBehindGuard(ctx.db, await userId('admin2@x'),
      async () => supertest(server).put(`/v1/admin/users/${await userId('admin@x')}`).set('Cookie', b).send({ role: 'viewer' }),
      async () => expect((await supertest(server).put(`/v1/admin/users/${await userId('admin2@x')}`).set('Cookie', a).send({ role: 'viewer' })).status).toBe(200), { method: 'all', sql: ACTIVE_ADMINS_SQL });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/last active admin/i);
    expect((await userRow('admin@x')).role).toBe('admin');
  });

  it('refuses to deactivate the last active admin when a cross-deactivation lands between guard and write', async () => {
    const a = await loginAs(app, 'admin@x', 'longenough1');
    const b = await loginAs(app, 'admin2@x', 'longenough1');
    const r = await raceBehindGuard(ctx.db, await userId('admin2@x'),
      async () => supertest(server).put(`/v1/admin/users/${await userId('admin@x')}`).set('Cookie', b).send({ active: false }),
      async () => expect((await supertest(server).put(`/v1/admin/users/${await userId('admin2@x')}`).set('Cookie', a).send({ active: false })).status).toBe(200), { method: 'all', sql: ACTIVE_ADMINS_SQL });
    expect(r.status).toBe(409);
    expect(Number((await userRow('admin@x')).active)).toBe(1);
  });

  it('counts an inactive admin as no admin', async () => {
    const a = await loginAs(app, 'admin@x', 'longenough1');
    const b = await loginAs(app, 'admin2@x', 'longenough1');
    // admin2 stays role=admin but is switched off (between its guard and its
    // write): it cannot sign in, so it does not count as an admin left.
    const r = await raceBehindGuard(ctx.db, await userId('admin2@x'),
      async () => supertest(server).put(`/v1/admin/users/${await userId('admin@x')}`).set('Cookie', b).send({ role: 'viewer' }),
      async () => expect((await supertest(server).put(`/v1/admin/users/${await userId('admin2@x')}`).set('Cookie', a).send({ active: false })).status).toBe(200), { method: 'all', sql: ACTIVE_ADMINS_SQL });
    expect(r.status).toBe(409);
  });

  it('answers 404, not 409, for an unknown user', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(server).put('/v1/admin/users/00000000-0000-0000-0000-000000000000').set('Cookie', cookie).send({ role: 'viewer' });
    expect(r.status).toBe(404);
  });

  it('refuses the whole body when it demotes yourself, password change included', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(server).put(`/v1/admin/users/${await userId('admin@x')}`).set('Cookie', cookie).send({ role: 'viewer', password: 'brandnewpass' });
    expect(r.status).toBe(400);
    expect(await loginAs(app, 'admin@x', 'longenough1')).toBeTruthy();
  });

  it('a viewer can still be switched off and on', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const id = await userId('view@x');
    expect((await supertest(server).put(`/v1/admin/users/${id}`).set('Cookie', cookie).send({ active: false })).status).toBe(200);
    expect((await supertest(server).put(`/v1/admin/users/${id}`).set('Cookie', cookie).send({ active: true })).status).toBe(200);
  });
});

describe('DELETE /users/:id refuses removing the last active admin', () => {
  it('refuses when a deactivation lands between guard and delete, and keeps the row', async () => {
    const a = await loginAs(app, 'admin@x', 'longenough1');
    const b = await loginAs(app, 'admin2@x', 'longenough1');
    const r = await raceBehindGuard(ctx.db, await userId('admin2@x'),
      async () => supertest(server).delete(`/v1/admin/users/${await userId('admin@x')}`).set('Cookie', b),
      async () => expect((await supertest(server).put(`/v1/admin/users/${await userId('admin2@x')}`).set('Cookie', a).send({ active: false })).status).toBe(200), { method: 'all', sql: ACTIVE_ADMINS_SQL });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/last active admin/i);
    expect(await userRow('admin@x')).toBeTruthy();
  });

  it('still deletes another admin while one active admin remains', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(server).delete(`/v1/admin/users/${await userId('admin2@x')}`).set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(await userRow('admin2@x')).toBeFalsy();
  });

  it('still answers 404 for an unknown user', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(server).delete('/v1/admin/users/00000000-0000-0000-0000-000000000000').set('Cookie', cookie);
    expect(r.status).toBe(404);
  });
});

describe('PUT /auth-config refuses a save that leaves no way to sign in', () => {
  const read = async (cookie: string) => (await supertest(server).get('/v1/admin/auth-config').set('Cookie', cookie)).body;

  it('refuses switching off email + password when it is the only method', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie).send({ passwordEnabled: false });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no admin/i);
    expect((await read(cookie)).passwordEnabled).toBe(true);
  });

  it('refuses a Google-only config with no client ID', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie)
      .send({ passwordEnabled: false, googleEnabled: true, google: { clientId: '', clientSecret: 'shh' } });
    expect(r.status).toBe(400);
    const after = await read(cookie);
    expect(after.passwordEnabled).toBe(true);
    expect(after.googleEnabled).toBe(false);
  });

  it('refuses a Google-only config with no client secret', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie)
      .send({ passwordEnabled: false, googleEnabled: true, google: { clientId: 'id.apps.googleusercontent.com' } });
    expect(r.status).toBe(400);
  });

  it('refuses an Entra-only config with no tenant', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie)
      .send({ passwordEnabled: false, entraEnabled: true, entra: { tenantId: '', clientId: 'app', clientSecret: 'shh' } });
    expect(r.status).toBe(400);
  });

  it('accepts switching password off once a complete Google provider is on', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie)
      .send({ passwordEnabled: false, googleEnabled: true, google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'shh' } });
    expect(r.status).toBe(200);
    expect(r.body.passwordEnabled).toBe(false);
    expect(r.body.googleEnabled).toBe(true);
  });

  it('judges the stored secret too: a later save that keeps the secret still counts Google as working', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie)
      .send({ googleEnabled: true, google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'shh' } });
    // The form sends no secret when it is left blank ("leave blank to keep").
    const r = await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie).send({ passwordEnabled: false });
    expect(r.status).toBe(200);
  });

  it('refuses an allowlist that shuts every admin out of the only method left', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie).send({
      passwordEnabled: false, googleEnabled: true,
      google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'shh' },
      emailAllowlist: ['other.com'],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no admin/i);
  });

  it('accepts an allowlist while email + password is on: password sign-in ignores it', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie).send({ emailAllowlist: ['other.com'] });
    expect(r.status).toBe(200);
  });

  // Judged as "does this save make it worse": an org already in a state no
  // admin can sign in under (saved before this guard) must still be able to
  // save a step towards fixing it.
  it('accepts a partial fix when the stored config already lets no admin sign in', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    await ctx.db.run('UPDATE auth_config SET password_enabled = 0, google_enabled = 1, google_client_id = NULL WHERE org_id = ?', ['org']);
    const r = await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie)
      .send({ entraEnabled: true, entra: { tenantId: 'common', clientId: 'app' } });
    expect(r.status).toBe(200);
  });

  it('still accepts an incomplete provider while another method works (the card warns instead)', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie)
      .send({ googleEnabled: true, google: { clientId: '' } });
    expect(r.status).toBe(200);
  });
});

describe('adminCanStillSignIn', () => {
  const cfg = {
    org_id: 'org', password_enabled: 0, google_enabled: 1, google_client_id: 'id', google_client_secret_enc: 'v1:x',
    entra_enabled: 0, entra_tenant_id: null, entra_client_id: null, entra_client_secret_enc: null, email_allowlist: null,
  };
  const pwAdmin = { email: 'a@acme.com', password_hash: 'h', provider: 'password' };
  const ssoAdmin = { email: 'b@acme.com', password_hash: null, provider: 'google' };

  it('password counts only for an admin who has a password', () => {
    expect(adminCanStillSignIn({ ...cfg, password_enabled: 1, google_enabled: 0 }, [ssoAdmin])).toBe(false);
    expect(adminCanStillSignIn({ ...cfg, password_enabled: 1, google_enabled: 0 }, [pwAdmin])).toBe(true);
  });

  it('a complete SSO provider counts for an admin the allowlist lets in', () => {
    expect(adminCanStillSignIn(cfg, [ssoAdmin])).toBe(true);
    expect(adminCanStillSignIn({ ...cfg, email_allowlist: JSON.stringify(['acme.com']) }, [ssoAdmin])).toBe(true);
    expect(adminCanStillSignIn({ ...cfg, email_allowlist: JSON.stringify(['other.com']) }, [ssoAdmin])).toBe(false);
  });

  it('an incomplete provider counts for nobody', () => {
    expect(adminCanStillSignIn({ ...cfg, google_client_secret_enc: null }, [ssoAdmin, pwAdmin])).toBe(false);
  });

  it('no admins means nobody can sign in', () => {
    expect(adminCanStillSignIn({ ...cfg, password_enabled: 1 }, [])).toBe(false);
  });
});
