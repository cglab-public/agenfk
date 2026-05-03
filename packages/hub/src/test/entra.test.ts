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

const enableEntra = (db: any, allowlist?: string[]) => {
  db.prepare(`UPDATE auth_config SET
    entra_enabled = 1,
    entra_tenant_id = 'tenant-uuid',
    entra_client_id = 'app-client-id',
    entra_client_secret_enc = ?,
    email_allowlist = ?
    WHERE org_id = 'org'`).run(
    encryptSecret('e-secret', SECRET),
    allowlist ? JSON.stringify(allowlist) : null,
  );
};

describe('Entra OIDC flow', () => {
  let app: any;
  let ctx: any;

  beforeEach(() => {
    cleanup();
    _resetEntraDiscoveryCache();
    const out = createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org',
    });
    app = out.app;
    ctx = out.ctx;
    vi.restoreAllMocks();
  });

  afterEach(() => { ctx.db.close(); cleanup(); });

  it('returns 404 when not configured', async () => {
    const r = await supertest(app).get('/auth/entra/start');
    expect(r.status).toBe(404);
  });

  it('start fetches discovery and redirects to authorization endpoint', async () => {
    enableEntra(ctx.db);
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
    enableEntra(ctx.db);
    const r = await supertest(app).get('/auth/entra/callback?code=x&state=wrong');
    expect(r.status).toBe(400);
  });

  it('callback exchanges code, verifies id_token, upserts user', async () => {
    enableEntra(ctx.db);
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
    const row = ctx.db.prepare('SELECT * FROM users').get() as any;
    expect(row.email).toBe('bob@acme.com');
    expect(row.provider).toBe('entra');
    expect(row.provider_subject).toBe('entra-oid-1');
    void getSpy; void postSpy;
  });
});
