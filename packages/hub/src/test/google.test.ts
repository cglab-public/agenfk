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
  it('allows everything when there is no allowlist (null)', () => {
    expect(checkEmailAllowlist('a@b.com', null).allowed).toBe(true);
  });
  // "No allowlist" is NULL; an empty list is a misconfiguration and fails closed.
  it('denies an empty stored list as misconfigured, not as "no restriction"', () => {
    const r = checkEmailAllowlist('a@b.com', '[]');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('allowlist is misconfigured');
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

  // An ACTIVE, INVITED user, so a 403 here can only be the allowlist (the test above would also pass on the invite check).
  describe('callback and the stored allowlist, for an active invited user', () => {
    const invite = () => ctx.db.run(
      'INSERT INTO users (id, org_id, email, password_hash, provider, role) VALUES (?, ?, ?, ?, ?, ?)',
      ['u-pre', 'org', 'alice@acme.com', null, 'password', 'viewer'],
    );
    const callback = async () => {
      vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { access_token: 'tok' } } as any);
      vi.spyOn(axios, 'get').mockResolvedValueOnce({ data: { sub: 'g-sub-1', email: 'alice@acme.com', email_verified: true } } as any);
      const start = await supertest(__server).get('/auth/google/start').redirects(0);
      const stateCookie = start.headers['set-cookie']?.[0];
      const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(stateCookie!)![1]);
      return supertest(__server).get(`/auth/google/callback?code=abc&state=${state}`).set('Cookie', stateCookie!).redirects(0);
    };
    const signedIn = (cb: any): boolean => cb.headers['set-cookie']?.some((c: string) => c?.startsWith('agenfk_hub_session=')) ?? false;
    const row = () => ctx.db.get<any>("SELECT provider, provider_subject, last_login_at FROM users WHERE id = 'u-pre'");

    it.each(['{not json', '[]', '"acme.com"', '[42]'])('an unreadable list (%s) denies with the allowlist error: no session, and the row is not moved to google', async (stored) => {
      await enableGoogle(ctx.db);
      await ctx.db.run("UPDATE auth_config SET email_allowlist = ? WHERE org_id = 'org'", [stored]);
      await invite();
      const cb = await callback();
      expect(cb.status).toBe(403);
      expect(cb.body.error).toBe('allowlist is misconfigured');
      expect(signedIn(cb)).toBe(false);
      expect(await row()).toMatchObject({ provider: 'password', provider_subject: null, last_login_at: null });
    });

    it('a readable list that excludes them denies the same way', async () => {
      await enableGoogle(ctx.db, ['other.com']);
      await invite();
      const cb = await callback();
      expect(cb.status).toBe(403);
      expect(cb.body.error).toMatch(/allowlist/i);
      expect(signedIn(cb)).toBe(false);
      expect(await row()).toMatchObject({ provider: 'password', provider_subject: null });
    });

    it("another org's unreadable list does not count: this org has none, so the user signs in", async () => {
      await enableGoogle(ctx.db);
      await ctx.db.run("INSERT INTO orgs (id, name) VALUES ('other-org', 'other')");
      await ctx.db.run("INSERT INTO auth_config (org_id, password_enabled, email_allowlist) VALUES ('other-org', 1, '{not json')");
      await invite();
      const cb = await callback();
      expect(cb.status).toBe(302);
      expect(signedIn(cb)).toBe(true);
      expect(await row()).toMatchObject({ provider: 'google', provider_subject: 'g-sub-1' });
    });
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
