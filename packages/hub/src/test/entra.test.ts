import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import axios from 'axios';
import { createHubApp } from '../server';
import { encryptSecret } from '../crypto';
import { _resetEntraDiscoveryCache } from '../auth/entra';

let mockClaims: any = {};

// Mock only verify; keep sign + everything else from the real module so
// session signing still works.
vi.mock('jsonwebtoken', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jsonwebtoken')>();
  const verify = ((_t: any, _k: any, _o: any, cb: any) => cb(null, mockClaims)) as any;
  return {
    ...actual,
    verify,
    default: { ...(actual.default ?? actual), verify },
  };
});

vi.mock('jwks-rsa', () => ({
  default: () => ({ getSigningKey: (_k: any, cb: any) => cb(null, { getPublicKey: () => 'pem' }) }),
}));

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-entra-test-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const enableEntra = async (db: any, allowlist?: string[]) => {
  await db.run(`UPDATE auth_config SET
    entra_enabled = 1,
    entra_tenant_id = 'tenant-uuid',
    entra_client_id = 'app-client-id',
    entra_client_secret_enc = ?,
    email_allowlist = ?
    WHERE org_id = 'org'`, [
    encryptSecret('e-secret', SECRET),
    allowlist ? JSON.stringify(allowlist) : null,
  ]);
};

describe('Entra OIDC flow', () => {
  let app: any;
  let ctx: any;

  beforeEach(async () => {
    cleanup();
    _resetEntraDiscoveryCache();
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

  it('returns 404 when not configured', async () => {
    const r = await supertest(app).get('/auth/entra/start');
    expect(r.status).toBe(404);
  });

  it('start fetches discovery and redirects to authorization endpoint', async () => {
    await enableEntra(ctx.db);
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        authorization_endpoint: 'https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/authorize',
        token_endpoint: 'https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/token',
        jwks_uri: 'https://login.microsoftonline.com/tenant-uuid/discovery/v2.0/keys',
        issuer: 'https://login.microsoftonline.com/tenant-uuid/v2.0',
      },
    } as any);
    const r = await supertest(app).get('/auth/entra/start').redirects(0);
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain('login.microsoftonline.com/tenant-uuid/oauth2/v2.0/authorize');
    expect(r.headers.location).toContain('client_id=app-client-id');
  });

  it('callback rejects bad state', async () => {
    await enableEntra(ctx.db);
    const r = await supertest(app).get('/auth/entra/callback?code=x&state=wrong');
    expect(r.status).toBe(400);
  });

  it('callback signs in a pre-invited user and upgrades their row to entra in place', async () => {
    await enableEntra(ctx.db);
    await ctx.db.run(
      'INSERT INTO users (id, org_id, email, password_hash, provider, role) VALUES (?, ?, ?, ?, ?, ?)',
      ['u-pre', 'org', 'bob@acme.com', null, 'password', 'viewer'],
    );
    const discovery = {
      authorization_endpoint: 'https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/authorize',
      token_endpoint: 'https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/token',
      jwks_uri: 'https://login.microsoftonline.com/tenant-uuid/discovery/v2.0/keys',
      issuer: 'https://login.microsoftonline.com/tenant-uuid/v2.0',
    };
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({ data: discovery } as any);
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { id_token: 'fake.jwt.token' } } as any);
    mockClaims = { oid: 'entra-oid-1', email: 'bob@acme.com' };

    const start = await supertest(app).get('/auth/entra/start').redirects(0);
    const stateCookie = start.headers['set-cookie']?.[0];
    const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(stateCookie!)![1]);

    const cb = await supertest(app)
      .get(`/auth/entra/callback?code=abc&state=${state}`)
      .set('Cookie', stateCookie!)
      .redirects(0);
    expect(cb.status).toBe(302);
    expect(cb.headers['set-cookie']?.some((c: string) => c.startsWith('agenfk_hub_session='))).toBe(true);
    const rows = await ctx.db.all<any>('SELECT * FROM users');
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.id).toBe('u-pre');
    expect(row.email).toBe('bob@acme.com');
    expect(row.provider).toBe('entra');
    expect(row.provider_subject).toBe('entra-oid-1');
    void getSpy; void postSpy;
  });

  it('callback rejects an un-invited email with 403', async () => {
    await enableEntra(ctx.db);
    const discovery = {
      authorization_endpoint: 'https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/authorize',
      token_endpoint: 'https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/token',
      jwks_uri: 'https://login.microsoftonline.com/tenant-uuid/discovery/v2.0/keys',
      issuer: 'https://login.microsoftonline.com/tenant-uuid/v2.0',
    };
    vi.spyOn(axios, 'get').mockResolvedValue({ data: discovery } as any);
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { id_token: 'fake.jwt.token' } } as any);
    mockClaims = { oid: 'entra-stranger', email: 'stranger@acme.com' };

    const start = await supertest(app).get('/auth/entra/start').redirects(0);
    const stateCookie = start.headers['set-cookie']?.[0];
    const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(stateCookie!)![1]);

    const cb = await supertest(app)
      .get(`/auth/entra/callback?code=abc&state=${state}`)
      .set('Cookie', stateCookie!);
    expect(cb.status).toBe(403);
    expect(cb.body.error).toMatch(/not invited/i);
    const count = await ctx.db.get<{ c: number | string }>('SELECT COUNT(*) AS c FROM users');
    expect(Number(count?.c ?? 0)).toBe(0);
  });
});
