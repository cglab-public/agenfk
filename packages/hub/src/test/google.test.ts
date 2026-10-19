import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import axios from 'axios';
import { createHubApp } from '../server';
import { encryptSecret } from '../crypto';
import { checkEmailAllowlist } from '../auth/oauth';
import { drainApp } from './helpers/drainApp';

/**
 * A REAL listening server, so drainApp has something to drain (BUG 2bd7ee36).
 *
 * `drainApp` calls closeIdleConnections/closeAllConnections, which exist on
 * http.Server and NOT on an Express app — and `createHubApp` returns an
 * Express app. With `?.` those calls vanished silently, so the helper written
 * to fix this suite's flakiness never did anything. Module scope because a
 * file can hold several describes, each reassigning `app`.
 */
let __server: any;

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-google-test-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const enableGoogle = async (db: any, allowlist?: string[]) => {
  await db.run(`UPDATE auth_config SET
    google_enabled = 1,
    google_client_id = 'gid',
    google_client_secret_enc = ?,
    email_allowlist = ?
    WHERE org_id = 'org'`, [
    encryptSecret('gsecret', SECRET),
    allowlist ? JSON.stringify(allowlist) : null,
  ]);
};

describe('checkEmailAllowlist', () => {
  it('allows everything when null/empty', () => {
    expect(checkEmailAllowlist('a@b.com', null).allowed).toBe(true);
    expect(checkEmailAllowlist('a@b.com', '[]').allowed).toBe(true);
  });
  it('matches bare domains', () => {
    expect(checkEmailAllowlist('alice@acme.com', '["acme.com"]').allowed).toBe(true);
    expect(checkEmailAllowlist('alice@bad.com', '["acme.com"]').allowed).toBe(false);
  });
  it('matches @-prefixed and *.-prefixed', () => {
    expect(checkEmailAllowlist('alice@sub.acme.com', '["*.acme.com"]').allowed).toBe(true);
    expect(checkEmailAllowlist('alice@acme.com', '["@acme.com"]').allowed).toBe(true);
  });
  it('matches exact emails', () => {
    expect(checkEmailAllowlist('alice@example.com', '["alice@example.com"]').allowed).toBe(true);
  });
  // Once sign-in can create users, a typo in the stored list must not admit
  // everyone. The admin route only ever stores an array of strings, so these
  // shapes come from a hand edit or an older build.
  it('denies everyone when the stored list is not valid JSON', () => {
    expect(checkEmailAllowlist('alice@acme.com', '["acme.com"').allowed).toBe(false);
  });
  it('denies everyone when the stored list is not an array of strings', () => {
    expect(checkEmailAllowlist('alice@acme.com', '{"acme.com":true}').allowed).toBe(false);
    expect(checkEmailAllowlist('alice@acme.com', '"acme.com"').allowed).toBe(false);
    expect(checkEmailAllowlist('alice@acme.com', '["acme.com", 7]').allowed).toBe(false);
  });
});

describe('Google OAuth flow', () => {
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
    if (__server) await new Promise<void>(r => __server.close(() => r()));
    __server = app.listen(0);
    ctx = out.ctx;
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    // Drain in-flight responses before closing the DB — see helpers/drainApp.ts
    await drainApp(__server);
    await ctx.db.close();
    cleanup();
  });

  it('returns 404 when Google is not configured', async () => {
    const r = await supertest(__server).get('/auth/google/start');
    expect(r.status).toBe(404);
  });

  it('start redirects to Google with state cookie', async () => {
    await enableGoogle(ctx.db);
    const r = await supertest(__server).get('/auth/google/start').redirects(0);
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(r.headers.location).toContain('client_id=gid');
    expect(r.headers['set-cookie']?.[0]).toMatch(/agenfk_hub_oauth_state=/);
  });

  it('callback rejects bad state', async () => {
    await enableGoogle(ctx.db);
    const r = await supertest(__server).get('/auth/google/callback?code=abc&state=wrong');
    expect(r.status).toBe(400);
  });

  it('callback signs in a pre-invited user and upgrades their row to google in place', async () => {
    await enableGoogle(ctx.db);
    // Admin pre-invites the user (no password — SSO-only invite). The row
    // exists with provider='password' and password_hash=NULL until the user
    // signs in via Google for the first time.
    await ctx.db.run(
      'INSERT INTO users (id, org_id, email, password_hash, provider, role) VALUES (?, ?, ?, ?, ?, ?)',
      ['u-pre', 'org', 'alice@acme.com', null, 'password', 'viewer'],
    );
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { access_token: 'tok' } } as any);
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: { sub: 'g-sub-1', email: 'alice@acme.com', email_verified: true },
    } as any);

    const start = await supertest(__server).get('/auth/google/start').redirects(0);
    const stateCookie = start.headers['set-cookie']?.[0];
    const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(stateCookie!)![1]);

    const cb = await supertest(__server)
      .get(`/auth/google/callback?code=abc&state=${state}`)
      .set('Cookie', stateCookie!)
      .redirects(0);
    expect(cb.status).toBe(302);
    expect(cb.headers['set-cookie']?.some((c: string) => c.startsWith('agenfk_hub_session='))).toBe(true);

    const rows = await ctx.db.all<any>('SELECT * FROM users');
    expect(rows.length).toBe(1); // upgrade in place — no new row
    const row = rows[0];
    expect(row.id).toBe('u-pre');
    expect(row.email).toBe('alice@acme.com');
    expect(row.provider).toBe('google');
    expect(row.provider_subject).toBe('g-sub-1');
  });

  it('callback rejects an un-invited email even when allowlist passes', async () => {
    await enableGoogle(ctx.db, ['acme.com']);
    // No row exists for stranger@acme.com — admin never invited them.
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { access_token: 'tok' } } as any);
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: { sub: 'g-stranger', email: 'stranger@acme.com', email_verified: true },
    } as any);

    const start = await supertest(__server).get('/auth/google/start').redirects(0);
    const stateCookie = start.headers['set-cookie']?.[0];
    const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(stateCookie!)![1]);

    const cb = await supertest(__server)
      .get(`/auth/google/callback?code=abc&state=${state}`)
      .set('Cookie', stateCookie!);
    expect(cb.status).toBe(403);
    expect(cb.body.error).toMatch(/not invited/i);
    // No session was set.
    expect(cb.headers['set-cookie']?.some((c: string) => c?.startsWith('agenfk_hub_session=')) ?? false).toBe(false);
    // No row was auto-created.
    const count = await ctx.db.get<{ c: number | string }>('SELECT COUNT(*) AS c FROM users');
    expect(Number(count?.c ?? 0)).toBe(0);
  });

  it('callback enforces allowlist', async () => {
    await enableGoogle(ctx.db, ['acme.com']);
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { access_token: 'tok' } } as any);
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: { sub: 'g-sub-2', email: 'eve@badco.com', email_verified: true },
    } as any);

    const start = await supertest(__server).get('/auth/google/start').redirects(0);
    const stateCookie = start.headers['set-cookie']?.[0];
    const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(stateCookie!)![1]);

    const cb = await supertest(__server)
      .get(`/auth/google/callback?code=abc&state=${state}`)
      .set('Cookie', stateCookie!);
    expect(cb.status).toBe(403);
  });

  it('rejects unverified Google email', async () => {
    await enableGoogle(ctx.db);
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { access_token: 'tok' } } as any);
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: { sub: 'g-sub-3', email: 'unverified@x.com', email_verified: false },
    } as any);
    const start = await supertest(__server).get('/auth/google/start').redirects(0);
    const stateCookie = start.headers['set-cookie']?.[0];
    const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(stateCookie!)![1]);
    const cb = await supertest(__server)
      .get(`/auth/google/callback?code=abc&state=${state}`)
      .set('Cookie', stateCookie!);
    expect(cb.status).toBe(403);
  });
});

/**
 * Phase 0 of the Hub auto-join epic (INFRA-463). Google says the domain of
 * the email claim does not prove Workspace membership; the hd claim does, and
 * it is absent for consumer accounts. With google_hosted_domains set, only
 * accounts of those Workspace domains get in.
 */
describe('Google sign-in binds to the configured Workspace domains and an immutable subject', () => {
  let ctx: any;

  const signIn = async (userinfo: any) => {
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { access_token: 'tok' } } as any);
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ data: userinfo } as any);
    const start = await supertest(__server).get('/auth/google/start').redirects(0);
    const stateCookie = start.headers['set-cookie']?.[0];
    const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(stateCookie!)![1]);
    return supertest(__server)
      .get(`/auth/google/callback?code=abc&state=${state}`)
      .set('Cookie', stateCookie!)
      .redirects(0);
  };
  const invite = (email: string) => ctx.db.run(
    'INSERT INTO users (id, org_id, email, password_hash, provider, role) VALUES (?, ?, ?, ?, ?, ?)',
    ['u-pre', 'org', email, null, 'password', 'viewer'],
  );
  const setHostedDomains = (domains: string[]) =>
    ctx.db.run('UPDATE auth_config SET google_hosted_domains = ? WHERE org_id = ?', [JSON.stringify(domains), 'org']);
  const sessionSet = (r: any) => (r.headers['set-cookie'] ?? []).some((c: string) => c.startsWith('agenfk_hub_session='));

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org' });
    if (__server) await new Promise<void>(r => __server.close(() => r()));
    __server = out.app.listen(0);
    ctx = out.ctx;
    vi.restoreAllMocks();
    await enableGoogle(ctx.db);
  });

  afterEach(async () => {
    await drainApp(__server);
    await ctx.db.close();
    cleanup();
  });

  it('signs in an invited account whose hd is in google_hosted_domains', async () => {
    await setHostedDomains(['acme.com']);
    await invite('alice@acme.com');
    const r = await signIn({ sub: 'g-sub-1', email: 'alice@acme.com', email_verified: true, hd: 'acme.com' });
    expect(r.status).toBe(302);
    expect(sessionSet(r)).toBe(true);
  });

  it('refuses a Workspace account from a domain outside the list', async () => {
    await setHostedDomains(['acme.com']);
    await invite('alice@acme.com');
    const r = await signIn({ sub: 'g-sub-1', email: 'alice@acme.com', email_verified: true, hd: 'other.com' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/workspace|domain/i);
    expect(sessionSet(r)).toBe(false);
  });

  it('refuses a consumer account, which carries no hd, while the list is set', async () => {
    await setHostedDomains(['acme.com']);
    await invite('alice@acme.com');
    const r = await signIn({ sub: 'g-sub-1', email: 'alice@acme.com', email_verified: true });
    expect(r.status).toBe(403);
    const row = await ctx.db.get<any>('SELECT provider, provider_subject FROM users WHERE id = ?', ['u-pre']);
    expect(row.provider).toBe('password');
    expect(row.provider_subject).toBeNull();
  });

  it('matches hd case-insensitively', async () => {
    await setHostedDomains(['Acme.com']);
    await invite('alice@acme.com');
    const r = await signIn({ sub: 'g-sub-1', email: 'alice@acme.com', email_verified: true, hd: 'ACME.COM' });
    expect(r.status).toBe(302);
  });

  it('never rebinds by email a row already bound to another Google subject', async () => {
    await ctx.db.run(
      'INSERT INTO users (id, org_id, email, password_hash, provider, provider_subject, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['u-old', 'org', 'alice@acme.com', null, 'google', 'g-sub-old', 'admin'],
    );
    const r = await signIn({ sub: 'g-sub-new', email: 'alice@acme.com', email_verified: true });
    expect(r.status).toBe(403);
    expect(sessionSet(r)).toBe(false);
    const row = await ctx.db.get<any>('SELECT provider_subject, role FROM users WHERE id = ?', ['u-old']);
    expect(row.provider_subject).toBe('g-sub-old');
    expect(row.role).toBe('admin');
  });

  // Admin recovery (AGENFK_HUB_RESET_ADMIN_EMAIL) moves the row back to a
  // password account. Rows recovered before it also cleared the subject still
  // carry the old one; both must sign in with Google again.
  it('rebinds a recovered admin who is back on a password account, old subject still on the row', async () => {
    await ctx.db.run(
      'INSERT INTO users (id, org_id, email, password_hash, provider, provider_subject, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['u-rec', 'org', 'alice@acme.com', 'hash', 'password', 'g-sub-old', 'admin'],
    );
    const r = await signIn({ sub: 'g-sub-new', email: 'alice@acme.com', email_verified: true });
    expect(r.status).toBe(302);
    const row = await ctx.db.get<any>('SELECT provider, provider_subject FROM users WHERE id = ?', ['u-rec']);
    expect(row.provider).toBe('google');
    expect(row.provider_subject).toBe('g-sub-new');
  });

  it('redeeming an admin recovery token clears the sign-in subject along with the provider', async () => {
    const { mintAdminRecoveryToken, redeemAdminRecoveryToken } = await import('../auth/adminRecovery');
    await ctx.db.run(
      'INSERT INTO users (id, org_id, email, password_hash, provider, provider_subject, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['u-adm', 'org', 'alice@acme.com', null, 'google', 'g-sub-1', 'admin'],
    );
    const minted: any = await mintAdminRecoveryToken(ctx.db, 'org', 'alice@acme.com');
    expect(minted.token).toBeTruthy();
    const redeemed: any = await redeemAdminRecoveryToken(ctx.db, 'org', minted.token, 'longenough1');
    expect(redeemed.user).toBeTruthy();
    const row = await ctx.db.get<any>('SELECT provider, provider_subject FROM users WHERE id = ?', ['u-adm']);
    expect(row.provider).toBe('password');
    expect(row.provider_subject).toBeNull();
  });

  it('records user.sso_bind when a Google sign-in first binds an invited row', async () => {
    await invite('alice@acme.com');
    const r = await signIn({ sub: 'g-sub-1', email: 'alice@acme.com', email_verified: true });
    expect(r.status).toBe(302);
    const rows = await ctx.db.all<any>("SELECT * FROM config_audit WHERE action = 'user.sso_bind'");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].after_json)).toMatchObject({ provider: 'google', providerSubject: 'g-sub-1' });
  });
});
