import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import axios from 'axios';
import { createHubApp } from '../server';
import { encryptSecret } from '../crypto';
import { checkEmailAllowlist } from '../auth/oauth';

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
    ctx = out.ctx;
    vi.restoreAllMocks();
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  it('returns 404 when Google is not configured', async () => {
    const r = await supertest(app).get('/auth/google/start');
    expect(r.status).toBe(404);
  });

  it('start redirects to Google with state cookie', async () => {
    await enableGoogle(ctx.db);
    const r = await supertest(app).get('/auth/google/start').redirects(0);
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(r.headers.location).toContain('client_id=gid');
    expect(r.headers['set-cookie']?.[0]).toMatch(/agenfk_hub_oauth_state=/);
  });

  it('callback rejects bad state', async () => {
    await enableGoogle(ctx.db);
    const r = await supertest(app).get('/auth/google/callback?code=abc&state=wrong');
    expect(r.status).toBe(400);
  });

  it('callback exchanges code, upserts user, sets session', async () => {
    await enableGoogle(ctx.db);
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { access_token: 'tok' } } as any);
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: { sub: 'g-sub-1', email: 'alice@acme.com', email_verified: true },
    } as any);

    const start = await supertest(app).get('/auth/google/start').redirects(0);
    const stateCookie = start.headers['set-cookie']?.[0];
    const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(stateCookie!)![1]);

    const cb = await supertest(app)
      .get(`/auth/google/callback?code=abc&state=${state}`)
      .set('Cookie', stateCookie!)
      .redirects(0);
    expect(cb.status).toBe(302);
    expect(cb.headers['set-cookie']?.some((c: string) => c.startsWith('agenfk_hub_session='))).toBe(true);

    const row = await ctx.db.get<any>('SELECT * FROM users');
    expect(row.email).toBe('alice@acme.com');
    expect(row.provider).toBe('google');
    expect(row.provider_subject).toBe('g-sub-1');
  });

  it('callback enforces allowlist', async () => {
    await enableGoogle(ctx.db, ['acme.com']);
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { access_token: 'tok' } } as any);
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: { sub: 'g-sub-2', email: 'eve@badco.com', email_verified: true },
    } as any);

    const start = await supertest(app).get('/auth/google/start').redirects(0);
    const stateCookie = start.headers['set-cookie']?.[0];
    const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(stateCookie!)![1]);

    const cb = await supertest(app)
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
    const start = await supertest(app).get('/auth/google/start').redirects(0);
    const stateCookie = start.headers['set-cookie']?.[0];
    const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(stateCookie!)![1]);
    const cb = await supertest(app)
      .get(`/auth/google/callback?code=abc&state=${state}`)
      .set('Cookie', stateCookie!);
    expect(cb.status).toBe(403);
  });
});
