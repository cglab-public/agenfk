/**
 * Phase 1a of the Hub auto-join epic (INFRA-463): with join mode `auto`, a
 * first SSO sign-in that passes the tenant, domain and allowlist gates creates
 * the member, so nobody is invited by hand. For Entra the gate is the group
 * assigned to the enterprise app; the Hub backs it with an app-role claim, so
 * an app whose assignment was switched off by mistake fails closed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import axios from 'axios';
import { createHubApp } from '../server';
import { encryptSecret } from '../crypto';
import { _resetEntraDiscoveryCache } from '../auth/entra';
import { drainApp } from './helpers/drainApp';

let server: any;
let app: any;
let ctx: any;
let mockClaims: any = {};

vi.mock('jsonwebtoken', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jsonwebtoken')>();
  const verify = ((_t: any, _k: any, _o: any, cb: any) => cb(null, mockClaims)) as any;
  return { ...actual, verify, default: { ...(actual.default ?? actual), verify } };
});

vi.mock('jwks-rsa', () => ({
  default: () => ({ getSigningKey: (_k: any, cb: any) => cb(null, { getPublicKey: () => 'pem' }) }),
}));

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-jit-test-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const ROLE = 'AgEnFK.Member';
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};
const discovery = {
  authorization_endpoint: 'https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/authorize',
  token_endpoint: 'https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/token',
  jwks_uri: 'https://login.microsoftonline.com/tenant-uuid/discovery/v2.0/keys',
  issuer: 'https://login.microsoftonline.com/tenant-uuid/v2.0',
};

beforeEach(async () => {
  cleanup();
  _resetEntraDiscoveryCache();
  const out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org' });
  app = out.app;
  if (server) await new Promise<void>(r => server.close(() => r()));
  server = app.listen(0);
  ctx = out.ctx;
  vi.restoreAllMocks();
});

afterEach(async () => {
  await drainApp(server);
  await ctx.db.close();
  cleanup();
});

const enableEntra = async (opts: { joinMode?: string; role?: string | null; allowlist?: string | null } = {}) => {
  await ctx.db.run(
    `UPDATE auth_config SET entra_enabled = 1, entra_tenant_id = 'tenant-uuid', entra_client_id = 'app-client-id',
       entra_client_secret_enc = ?, email_allowlist = ?, join_mode = ?, entra_required_role = ? WHERE org_id = 'org'`,
    [encryptSecret('e-secret', SECRET), opts.allowlist ?? null, opts.joinMode ?? 'auto', opts.role === undefined ? ROLE : opts.role],
  );
};

const enableGoogle = async (opts: { joinMode?: string; domains?: string[] | null } = {}) => {
  await ctx.db.run(
    `UPDATE auth_config SET google_enabled = 1, google_client_id = 'gid', google_client_secret_enc = ?,
       google_hosted_domains = ?, join_mode = ? WHERE org_id = 'org'`,
    [encryptSecret('gsecret', SECRET), opts.domains ? JSON.stringify(opts.domains) : null, opts.joinMode ?? 'auto'],
  );
};

/** Drives /start then /callback once, with the claims the id token carries. */
const entraSignIn = async (claims: any) => {
  vi.spyOn(axios, 'get').mockResolvedValue({ data: discovery } as any);
  vi.spyOn(axios, 'post').mockResolvedValue({ data: { id_token: 'fake.jwt.token' } } as any);
  mockClaims = claims;
  const start = await supertest(server).get('/auth/entra/start').redirects(0);
  const stateCookie = start.headers['set-cookie']?.[0];
  const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(stateCookie!)![1]);
  return supertest(server).get(`/auth/entra/callback?code=abc&state=${state}`).set('Cookie', stateCookie!).redirects(0);
};

const googleSignIn = async (userinfo: any) => {
  vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { access_token: 'tok' } } as any);
  vi.spyOn(axios, 'get').mockResolvedValueOnce({ data: userinfo } as any);
  const start = await supertest(server).get('/auth/google/start').redirects(0);
  const stateCookie = start.headers['set-cookie']?.[0];
  const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(stateCookie!)![1]);
  return supertest(server).get(`/auth/google/callback?code=abc&state=${state}`).set('Cookie', stateCookie!).redirects(0);
};

const member = { tid: 'tenant-uuid', oid: 'oid-new', email: 'new@acme.com', name: 'New Person', roles: [ROLE] };
const signedIn = (r: any) => r.status === 302 && !!r.headers['set-cookie']?.some((c: string) => c.startsWith('agenfk_hub_session='));

describe('Entra sign-in with join mode auto', () => {
  it('creates a viewer bound to the Entra object id and signs them in', async () => {
    await enableEntra();
    const r = await entraSignIn(member);
    expect(signedIn(r)).toBe(true);
    const row = await ctx.db.get<any>("SELECT * FROM users WHERE email = 'new@acme.com'");
    expect(row).toMatchObject({
      org_id: 'org', provider: 'entra', provider_subject: 'oid-new', name: 'New Person', role: 'viewer', active: 1, password_hash: null,
    });
    const audit = await ctx.db.all<any>("SELECT action, target, after_json FROM config_audit WHERE action = 'user.jit_create'");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].after_json)).toMatchObject({ provider: 'entra', providerSubject: 'oid-new', role: 'viewer' });
  });

  it('signs the same member in again on the next sign-in, without a second row or audit entry', async () => {
    await enableEntra();
    expect(signedIn(await entraSignIn(member))).toBe(true);
    expect(signedIn(await entraSignIn(member))).toBe(true);
    expect(await ctx.db.all<any>("SELECT id FROM users WHERE email = 'new@acme.com'")).toHaveLength(1);
    expect(await ctx.db.all<any>("SELECT id FROM config_audit WHERE action = 'user.jit_create'")).toHaveLength(1);
  });

  it('keeps refusing an uninvited account while join mode is off', async () => {
    await enableEntra({ joinMode: 'off' });
    const r = await entraSignIn(member);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/not invited/i);
    expect(await ctx.db.all<any>('SELECT id FROM users')).toHaveLength(0);
  });

  for (const [label, roles] of [['no roles claim', undefined], ['another role', ['Other.Role']], ['a role that only differs in case', ['agenfk.member']]] as const) {
    it(`refuses to create a member from a token with ${label}`, async () => {
      await enableEntra();
      const r = await entraSignIn({ ...member, roles });
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/app role/i);
      expect(await ctx.db.all<any>('SELECT id FROM users')).toHaveLength(0);
    });
  }

  it('creates nobody when no required role is stored, even with join mode auto', async () => {
    // A row saved by hand or by an older build: the backstop is missing, so
    // the Hub does not create members at all.
    await enableEntra({ role: null });
    const r = await entraSignIn(member);
    expect(r.status).toBe(403);
    expect(await ctx.db.all<any>('SELECT id FROM users')).toHaveLength(0);
  });

  it('creates nobody from another tenant', async () => {
    await enableEntra();
    const r = await entraSignIn({ ...member, tid: 'other-tenant' });
    expect(r.status).toBe(403);
    expect(await ctx.db.all<any>('SELECT id FROM users')).toHaveLength(0);
  });

  it('creates nobody outside the allowlist, or while the allowlist is unreadable', async () => {
    for (const allowlist of [JSON.stringify(['other.com']), '["acme.com"']) {
      await enableEntra({ allowlist });
      const r = await entraSignIn(member);
      expect(r.status).toBe(403);
    }
    expect(await ctx.db.all<any>('SELECT id FROM users')).toHaveLength(0);
  });

  it('does not take over an email bound to another identity', async () => {
    await enableEntra();
    await ctx.db.run(
      'INSERT INTO users (id, org_id, email, password_hash, provider, provider_subject, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['u-old', 'org', 'new@acme.com', null, 'entra', 'oid-old', 'admin'],
    );
    const r = await entraSignIn(member);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/another sign-in identity/i);
    expect(await ctx.db.all<any>('SELECT id, provider_subject, role FROM users')).toEqual([{ id: 'u-old', provider_subject: 'oid-old', role: 'admin' }]);
  });

  it('does not recreate a deactivated member', async () => {
    await enableEntra();
    await ctx.db.run(
      'INSERT INTO users (id, org_id, email, password_hash, provider, provider_subject, role, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['u-gone', 'org', 'new@acme.com', null, 'entra', 'oid-new', 'viewer', 0],
    );
    const r = await entraSignIn(member);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/deactivated/i);
    expect(await ctx.db.all<any>('SELECT id FROM users')).toHaveLength(1);
  });

  it('binds an invited row as before instead of creating a second one', async () => {
    await enableEntra();
    await ctx.db.run(
      'INSERT INTO users (id, org_id, email, password_hash, provider, role) VALUES (?, ?, ?, ?, ?, ?)',
      ['u-pre', 'org', 'new@acme.com', null, 'password', 'admin'],
    );
    expect(signedIn(await entraSignIn(member))).toBe(true);
    expect(await ctx.db.all<any>('SELECT id, provider, provider_subject, role FROM users')).toEqual([
      { id: 'u-pre', provider: 'entra', provider_subject: 'oid-new', role: 'admin' },
    ]);
    expect(await ctx.db.all<any>("SELECT id FROM config_audit WHERE action = 'user.jit_create'")).toHaveLength(0);
  });

  it('creates exactly one member when two first sign-ins race', async () => {
    await enableEntra();
    vi.spyOn(axios, 'get').mockResolvedValue({ data: discovery } as any);
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { id_token: 'fake.jwt.token' } } as any);
    mockClaims = member;
    const starts = await Promise.all([1, 2].map(() => supertest(server).get('/auth/entra/start').redirects(0)));
    const callbacks = await Promise.all(starts.map((s) => {
      const cookie = s.headers['set-cookie']?.[0];
      const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(cookie!)![1]);
      return supertest(server).get(`/auth/entra/callback?code=abc&state=${state}`).set('Cookie', cookie!).redirects(0);
    }));
    expect(callbacks.every(signedIn)).toBe(true);
    expect(await ctx.db.all<any>("SELECT id FROM users WHERE email = 'new@acme.com'")).toHaveLength(1);
    expect(await ctx.db.all<any>("SELECT id FROM config_audit WHERE action = 'user.jit_create'")).toHaveLength(1);
  });
});

/**
 * The tenant, the Workspace domain and the allowlist are read on every
 * sign-in. The app role was read once, when the member was created: a person
 * removed from the group, on an app whose assignment is switched off, kept
 * signing in (QA run 20261104, card 00aaf82f).
 */
describe('the app role on later Entra sign-ins', () => {
  const withoutRole = { ...member, roles: undefined };
  const hasSession = (r: any) => !!r.headers['set-cookie']?.some((c: string) => c.startsWith('agenfk_hub_session='));

  it('refuses a member the Hub created once the token stops carrying the role, and changes nothing', async () => {
    await enableEntra();
    expect(signedIn(await entraSignIn(member))).toBe(true);
    const before = await ctx.db.all<any>('SELECT * FROM users');
    const r = await entraSignIn(withoutRole);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/app role/i);
    expect(hasSession(r)).toBe(false);
    expect(await ctx.db.all<any>('SELECT * FROM users')).toEqual(before);
  });

  it('refuses the same way for another role, or the role in another case', async () => {
    await enableEntra();
    expect(signedIn(await entraSignIn(member))).toBe(true);
    for (const roles of [['Other.Role'], ['agenfk.member'], ROLE]) {
      const r = await entraSignIn({ ...member, roles });
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/app role/i);
    }
  });

  it('signs the same member in again when the role is back', async () => {
    await enableEntra();
    expect(signedIn(await entraSignIn(member))).toBe(true);
    expect((await entraSignIn(withoutRole)).status).toBe(403);
    expect(signedIn(await entraSignIn(member))).toBe(true);
    expect(await ctx.db.all<any>('SELECT id FROM users')).toHaveLength(1);
  });

  it('keeps the gate for members already created after automatic join is switched off', async () => {
    await enableEntra();
    expect(signedIn(await entraSignIn(member))).toBe(true);
    await enableEntra({ joinMode: 'off' });
    expect((await entraSignIn(withoutRole)).status).toBe(403);
    expect(signedIn(await entraSignIn(member))).toBe(true);
  });

  it('checks nothing once no role is stored', async () => {
    await enableEntra();
    expect(signedIn(await entraSignIn(member))).toBe(true);
    await enableEntra({ joinMode: 'off', role: null });
    expect(signedIn(await entraSignIn(withoutRole))).toBe(true);
  });

  it('keeps signing in a member an admin invited, with or without the role', async () => {
    await enableEntra();
    await ctx.db.run(
      'INSERT INTO users (id, org_id, email, password_hash, provider, role) VALUES (?, ?, ?, ?, ?, ?)',
      ['u-pre', 'org', 'new@acme.com', null, 'password', 'admin'],
    );
    expect(signedIn(await entraSignIn(withoutRole))).toBe(true);
    expect(signedIn(await entraSignIn(withoutRole))).toBe(true);
    expect(signedIn(await entraSignIn(member))).toBe(true);
  });

  it('still tells a deactivated member that the account is deactivated', async () => {
    await enableEntra();
    expect(signedIn(await entraSignIn(member))).toBe(true);
    await ctx.db.run("UPDATE users SET active = 0 WHERE email = 'new@acme.com'");
    const r = await entraSignIn(withoutRole);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/deactivated/i);
  });
});

describe('Google sign-in with join mode auto', () => {
  const person = { sub: 'g-new', email: 'new@acme.com', email_verified: true, name: 'New Person', hd: 'acme.com' };

  it('creates a viewer when the account is in a configured Workspace domain', async () => {
    await enableGoogle({ domains: ['acme.com'] });
    expect(signedIn(await googleSignIn(person))).toBe(true);
    const row = await ctx.db.get<any>("SELECT * FROM users WHERE email = 'new@acme.com'");
    expect(row).toMatchObject({ provider: 'google', provider_subject: 'g-new', role: 'viewer', active: 1 });
  });

  it('creates nobody when no Workspace domain is configured', async () => {
    // Without a domain list every Google account passes the hd gate; creating
    // members from that would open the Hub to anyone with a Google account.
    await enableGoogle({ domains: null });
    const r = await googleSignIn(person);
    expect(r.status).toBe(403);
    expect(await ctx.db.all<any>('SELECT id FROM users')).toHaveLength(0);
  });
});
