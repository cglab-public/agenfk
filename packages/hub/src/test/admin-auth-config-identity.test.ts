/**
 * Phase 0 of the Hub auto-join epic (INFRA-463): the sign-in settings an
 * admin saves must describe one tenant, one set of Workspace domains and a
 * well-formed allowlist, because sign-in is about to be trusted to create
 * users from them.
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
import { adminCanStillSignIn } from '../routes/admin';

let server: any;
let app: any;
let ctx: any;
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-authcfg-identity-test-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};
const TENANT = '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';

beforeEach(async () => {
  cleanup();
  const out = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' });
  app = out.app;
  if (server) await new Promise<void>(r => server.close(() => r()));
  server = app.listen(0);
  ctx = out.ctx;
  await createPasswordUser(ctx.db, 'org', 'admin@acme.com', 'longenough1', 'admin');
});

afterEach(async () => {
  await drainApp(server);
  await ctx.db.close();
  cleanup();
});

const put = async (body: any) => {
  const cookie = await loginAs(app, 'admin@acme.com', 'longenough1');
  return supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie).send(body);
};

describe('Entra tenant id', () => {
  for (const alias of ['organizations', 'common', 'consumers', 'Common']) {
    it(`refuses the multi-tenant alias "${alias}" and says why`, async () => {
      const r = await put({ entra: { tenantId: alias } });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/aliases are not supported/i);
      const row = await ctx.db.get<any>('SELECT entra_tenant_id FROM auth_config WHERE org_id = ?', ['org']);
      expect(row.entra_tenant_id).toBeNull();
    });
  }

  it('refuses a value that is not a tenant GUID', async () => {
    const r = await put({ entra: { tenantId: 'not a tenant!' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Directory \(tenant\) ID/);
  });

  it('accepts a verified domain name as the tenant, as Entra itself does', async () => {
    const r = await put({ entra: { tenantId: 'Contoso.onmicrosoft.com' } });
    expect(r.status).toBe(200);
    expect(r.body.entra.tenantId).toBe('contoso.onmicrosoft.com');
  });

  it('refuses a tenant id that is not text instead of clearing the stored one', async () => {
    await put({ entra: { tenantId: TENANT } });
    for (const bad of [123, true, { id: TENANT }]) {
      expect((await put({ entra: { tenantId: bad } })).status).toBe(400);
    }
    const row = await ctx.db.get<any>('SELECT entra_tenant_id FROM auth_config WHERE org_id = ?', ['org']);
    expect(row.entra_tenant_id).toBe(TENANT);
  });

  it('accepts a tenant GUID, trimmed', async () => {
    const r = await put({ entra: { tenantId: `  ${TENANT} ` } });
    expect(r.status).toBe(200);
    expect(r.body.entra.tenantId).toBe(TENANT);
  });

  it('still accepts clearing the tenant id', async () => {
    const r = await put({ entra: { tenantId: '' } });
    expect(r.status).toBe(200);
    expect(r.body.entra.tenantId).toBe('');
  });
});

describe('Email allowlist', () => {
  it('refuses entries that are not non-empty strings', async () => {
    expect((await put({ emailAllowlist: ['acme.com', 7] })).status).toBe(400);
    expect((await put({ emailAllowlist: ['acme.com', '  '] })).status).toBe(400);
  });

  it('refuses an allowlist that is not an array', async () => {
    const r = await put({ emailAllowlist: 'acme.com' });
    expect(r.status).toBe(400);
  });

  it('stores a valid list trimmed', async () => {
    const r = await put({ emailAllowlist: [' acme.com ', '*.sub.acme.com'] });
    expect(r.status).toBe(200);
    expect(r.body.emailAllowlist).toEqual(['acme.com', '*.sub.acme.com']);
  });
});

describe('Google Workspace domains', () => {
  it('starts empty and round-trips through GET', async () => {
    const cookie = await loginAs(app, 'admin@acme.com', 'longenough1');
    const before = await supertest(server).get('/v1/admin/auth-config').set('Cookie', cookie);
    expect(before.body.google.hostedDomains).toEqual([]);
    const r = await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie)
      .send({ google: { hostedDomains: ['Acme.com', ' sub.acme.com '] } });
    expect(r.status).toBe(200);
    expect(r.body.google.hostedDomains).toEqual(['acme.com', 'sub.acme.com']);
    const after = await supertest(server).get('/v1/admin/auth-config').set('Cookie', cookie);
    expect(after.body.google.hostedDomains).toEqual(['acme.com', 'sub.acme.com']);
  });

  it('refuses entries that are not bare domains', async () => {
    expect((await put({ google: { hostedDomains: ['@acme.com'] } })).status).toBe(400);
    expect((await put({ google: { hostedDomains: ['alice@acme.com'] } })).status).toBe(400);
    expect((await put({ google: { hostedDomains: ['*.acme.com'] } })).status).toBe(400);
    expect((await put({ google: { hostedDomains: 'acme.com' } })).status).toBe(400);
  });

  it('clears with an empty list', async () => {
    await put({ google: { hostedDomains: ['acme.com'] } });
    const r = await put({ google: { hostedDomains: [] } });
    expect(r.status).toBe(200);
    expect(r.body.google.hostedDomains).toEqual([]);
  });

  it('refuses a domain list that leaves no admin able to sign in with Google', async () => {
    // Password off, Google the only way in, and the only admin's address is
    // outside the Workspace domains being saved.
    await ctx.db.run(
      "UPDATE auth_config SET password_enabled = 0, google_enabled = 1, google_client_id = 'gid', google_client_secret_enc = 'v1:x' WHERE org_id = 'org'",
    );
    await ctx.db.run("UPDATE users SET provider = 'google', provider_subject = 'g-admin' WHERE email = 'admin@acme.com'");
    // The session is minted directly: password sign-in is off in this state.
    const { signSession } = await import('../auth/session');
    const admin = await ctx.db.get<any>("SELECT id FROM users WHERE email = 'admin@acme.com'");
    const cookie = `agenfk_hub_session=${signSession({ userId: admin.id, orgId: 'org', role: 'admin' }, 'test-session-secret')}`;
    const r = await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie)
      .send({ google: { hostedDomains: ['other.com'] } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/sign in/i);
  });
});

describe('adminCanStillSignIn with Workspace domains', () => {
  const cfg = {
    org_id: 'org', password_enabled: 0, google_enabled: 1, google_client_id: 'id', google_client_secret_enc: 'v1:x',
    entra_enabled: 0, entra_tenant_id: null, entra_client_id: null, entra_client_secret_enc: null, email_allowlist: null,
    google_hosted_domains: JSON.stringify(['acme.com']),
  };
  const googleAdmin = (email: string) => ({ email, password_hash: null, provider: 'google' });

  it('counts a Google admin whose address is in a listed domain', () => {
    expect(adminCanStillSignIn(cfg as any, [googleAdmin('b@acme.com')])).toBe(true);
  });

  it('does not count a Google admin outside every listed domain', () => {
    expect(adminCanStillSignIn(cfg as any, [googleAdmin('b@other.com')])).toBe(false);
  });

  it('ignores the domains for an admin who signs in with Entra', () => {
    const both = { ...cfg, google_enabled: 0, entra_enabled: 1, entra_tenant_id: 't', entra_client_id: 'c', entra_client_secret_enc: 'v1:x' };
    expect(adminCanStillSignIn(both as any, [{ email: 'b@other.com', password_hash: null, provider: 'entra' }])).toBe(true);
  });
});

describe('Unreadable stored lists', () => {
  // Sign-in denies everyone while a list is unreadable. Showing it as an empty
  // list would invite a save that opens sign-in to everyone instead.
  it('flags an unreadable allowlist rather than reporting it empty', async () => {
    await ctx.db.run('UPDATE auth_config SET email_allowlist = ? WHERE org_id = ?', ['["acme.com"', 'org']);
    const cookie = await loginAs(app, 'admin@acme.com', 'longenough1');
    const r = await supertest(server).get('/v1/admin/auth-config').set('Cookie', cookie);
    expect(r.body.emailAllowlistUnreadable).toBe(true);
  });

  it('flags unreadable Workspace domains', async () => {
    await ctx.db.run('UPDATE auth_config SET google_hosted_domains = ? WHERE org_id = ?', ['{"acme.com":1}', 'org']);
    const cookie = await loginAs(app, 'admin@acme.com', 'longenough1');
    const r = await supertest(server).get('/v1/admin/auth-config').set('Cookie', cookie);
    expect(r.body.google.hostedDomainsUnreadable).toBe(true);
  });

  it('reports readable lists as readable', async () => {
    const cookie = await loginAs(app, 'admin@acme.com', 'longenough1');
    const r = await supertest(server).get('/v1/admin/auth-config').set('Cookie', cookie);
    expect(r.body.emailAllowlistUnreadable).toBe(false);
    expect(r.body.google.hostedDomainsUnreadable).toBe(false);
  });
});

describe('Resetting a user\'s sign-in link', () => {
  // The refusal for an email already linked to another identity tells the
  // person to ask an admin; this is what the admin does.
  it('unlinks an SSO-bound user so their next sign-in binds again', async () => {
    await ctx.db.run(
      'INSERT INTO users (id, org_id, email, password_hash, provider, provider_subject, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['u-sso', 'org', 'bob@acme.com', null, 'google', 'g-sub-old', 'viewer'],
    );
    const cookie = await loginAs(app, 'admin@acme.com', 'longenough1');
    const r = await supertest(server).put('/v1/admin/users/u-sso').set('Cookie', cookie).send({ resetSignIn: true });
    expect(r.status).toBe(200);
    const row = await ctx.db.get<any>('SELECT provider, provider_subject, role FROM users WHERE id = ?', ['u-sso']);
    expect(row.provider).toBe('password');
    expect(row.provider_subject).toBeNull();
    expect(row.role).toBe('viewer');
    const audit = await ctx.db.all<any>("SELECT action FROM config_audit WHERE action = 'user.update'");
    expect(audit.length).toBeGreaterThan(0);
  });

  it('removes the stored password, so a reset cannot revive an old one', async () => {
    // A password invite, later bound to Google: the hash from the invite stays
    // on the row. After the reset the old password must not sign anyone in.
    await createPasswordUser(ctx.db, 'org', 'old@acme.com', 'oldpassword1', 'admin');
    await ctx.db.run("UPDATE users SET provider = 'google', provider_subject = 'g-sub-old' WHERE email = 'old@acme.com'");
    const id = (await ctx.db.get<any>("SELECT id FROM users WHERE email = 'old@acme.com'")).id;
    const cookie = await loginAs(app, 'admin@acme.com', 'longenough1');
    expect((await supertest(server).put(`/v1/admin/users/${id}`).set('Cookie', cookie).send({ resetSignIn: true })).status).toBe(200);
    const row = await ctx.db.get<any>('SELECT password_hash FROM users WHERE id = ?', [id]);
    expect(row.password_hash).toBeNull();
    const login = await supertest(server).post('/auth/login').send({ email: 'old@acme.com', password: 'oldpassword1' });
    expect(login.status).not.toBe(200);
  });

  it('refuses to unlink the signed-in admin, who would lose the way back in', async () => {
    const me = await ctx.db.get<any>("SELECT id FROM users WHERE email = 'admin@acme.com'");
    const cookie = await loginAs(app, 'admin@acme.com', 'longenough1');
    const r = await supertest(server).put(`/v1/admin/users/${me.id}`).set('Cookie', cookie).send({ resetSignIn: true });
    expect(r.status).toBe(400);
  });
});

describe('adminCanStillSignIn counts a provider only for admins it can still sign in', () => {
  const base = {
    org_id: 'org', password_enabled: 0, google_enabled: 0, google_client_id: 'id', google_client_secret_enc: 'v1:x',
    entra_enabled: 0, entra_tenant_id: TENANT, entra_client_id: 'c', entra_client_secret_enc: 'v1:x', email_allowlist: null,
    google_hosted_domains: null,
  };
  const admin = (provider: string) => ({ email: 'b@acme.com', password_hash: null, provider });

  it('does not count Entra for an admin bound to Google', () => {
    expect(adminCanStillSignIn({ ...base, entra_enabled: 1 } as any, [admin('google')])).toBe(false);
  });

  it('does not count Google for an admin bound to Entra', () => {
    expect(adminCanStillSignIn({ ...base, google_enabled: 1 } as any, [admin('entra')])).toBe(false);
  });

  it('counts either provider for an admin not bound yet', () => {
    expect(adminCanStillSignIn({ ...base, entra_enabled: 1 } as any, [admin('password')])).toBe(true);
    expect(adminCanStillSignIn({ ...base, google_enabled: 1 } as any, [admin('password')])).toBe(true);
  });

  it('does not count Entra while the stored tenant is a multi-tenant alias', () => {
    expect(adminCanStillSignIn({ ...base, entra_enabled: 1, entra_tenant_id: 'common' } as any, [admin('entra')])).toBe(false);
  });
});
