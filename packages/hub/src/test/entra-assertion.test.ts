import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import axios from 'axios';
import { createHubApp } from '../server';
import { encryptSecret } from '../crypto';
import { _resetEntraDiscoveryCache } from '../auth/entra';
import { adminCanStillSignIn } from '../routes/admin';
import { drainApp } from './helpers/drainApp';

// STS is mocked: no network and no AWS credentials inside the suite.
const stsSend = vi.hoisted(() => vi.fn());
const stsInputs = vi.hoisted(() => [] as any[]);
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send(cmd: any) { return stsSend(cmd); } },
  GetWebIdentityTokenCommand: class { constructor(public input: any) { stsInputs.push(input); } },
}));

let mockClaims: any = {};
vi.mock('jsonwebtoken', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jsonwebtoken')>();
  const verify = ((_t: any, _k: any, _o: any, cb: any) => cb(null, mockClaims)) as any;
  return { ...actual, verify, default: { ...(actual.default ?? actual), verify } };
});
vi.mock('jwks-rsa', () => ({
  default: () => ({ getSigningKey: (_k: any, cb: any) => cb(null, { getPublicKey: () => 'pem' }) }),
}));

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-entra-assertion-test-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const CLIENT_SECRET = 'super-secret-value';
const ASSERTION = 'header.assertion-payload.sig';
const DISCOVERY = {
  authorization_endpoint: 'https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/authorize',
  token_endpoint: 'https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/token',
  jwks_uri: 'https://login.microsoftonline.com/tenant-uuid/discovery/v2.0/keys',
  issuer: 'https://login.microsoftonline.com/tenant-uuid/v2.0',
};
const cleanup = () => {
  for (const s of ['', '-wal', '-shm']) { const f = TEST_DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
};
const entraError = (status: number, body: any) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, data: body } });
const INVALID_CLIENT = { error: 'invalid_client', error_description: 'AADSTS7000222: The provided client secret keys are expired.', error_codes: [7000222] };

describe('Entra callback: client assertion from AWS STS', () => {
  let app: any; let server: any; let ctx: any; let postSpy: any;
  let logged: string[];

  const configure = async (withSecret: boolean) => {
    await ctx.db.run(`UPDATE auth_config SET entra_enabled = 1, entra_tenant_id = 'tenant-uuid',
      entra_client_id = 'app-client-id', entra_client_secret_enc = ? WHERE org_id = 'org'`,
      [withSecret ? encryptSecret(CLIENT_SECRET, SECRET) : null]);
    await ctx.db.run('INSERT INTO users (id, org_id, email, password_hash, provider, role) VALUES (?, ?, ?, ?, ?, ?)',
      ['u-pre', 'org', 'bob@acme.com', null, 'password', 'viewer']);
    mockClaims = { oid: 'entra-oid-1', email: 'bob@acme.com' };
  };
  const callback = async () => {
    const start = await supertest(server).get('/auth/entra/start').redirects(0);
    const cookie = start.headers['set-cookie']?.[0];
    const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(cookie!)![1]);
    return supertest(server).get(`/auth/entra/callback?code=abc&state=${state}`).set('Cookie', cookie!).redirects(0);
  };
  const form = (call: number) => new URLSearchParams(postSpy.mock.calls[call][1] as string);

  beforeEach(async () => {
    cleanup();
    _resetEntraDiscoveryCache();
    stsSend.mockReset();
    stsInputs.length = 0;
    delete process.env.AGENFK_HUB_ENTRA_ASSERTION;
    const out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    server = app.listen(0);
    vi.restoreAllMocks();
    vi.spyOn(axios, 'get').mockResolvedValue({ data: DISCOVERY } as any);
    postSpy = vi.spyOn(axios, 'post');
    logged = [];
    for (const m of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: any[]) => { logged.push(a.map(String).join(' ')); });
    }
  });

  afterEach(async () => {
    delete process.env.AGENFK_HUB_ENTRA_ASSERTION;
    await drainApp(server);
    await ctx.db.close();
    cleanup();
  });

  it('asserts mode: sends client_assertion, not client_secret, and asks STS for an Entra-audience RS256 token', async () => {
    process.env.AGENFK_HUB_ENTRA_ASSERTION = 'aws-sts';
    await configure(true);
    stsSend.mockResolvedValue({ WebIdentityToken: ASSERTION });
    postSpy.mockResolvedValueOnce({ data: { id_token: 'fake.jwt' } } as any);
    const r = await callback();
    expect(r.status).toBe(302);
    const body = form(0);
    expect(body.get('client_assertion')).toBe(ASSERTION);
    expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect(body.has('client_secret')).toBe(false);
    expect(stsInputs[0].Audience).toEqual(['api://AzureADTokenExchange']);
    expect(stsInputs[0].SigningAlgorithm).toBe('RS256');
    expect(stsInputs[0].DurationSeconds).toBe(60);
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(logged.join('\n')).toMatch(/assertion/i);
  });

  it('assertion mode needs no stored client secret', async () => {
    process.env.AGENFK_HUB_ENTRA_ASSERTION = 'aws-sts';
    await configure(false);
    stsSend.mockResolvedValue({ WebIdentityToken: ASSERTION });
    postSpy.mockResolvedValueOnce({ data: { id_token: 'fake.jwt' } } as any);
    expect((await callback()).status).toBe(302);
  });

  it('without assertion mode a missing client secret still disables the callback (404)', async () => {
    await configure(false);
    const r = await supertest(server).get('/auth/entra/callback?code=abc&state=x');
    expect(r.status).toBe(404);
  });

  it('without assertion mode STS is never called and the secret is sent', async () => {
    await configure(true);
    postSpy.mockResolvedValueOnce({ data: { id_token: 'fake.jwt' } } as any);
    expect((await callback()).status).toBe(302);
    expect(stsSend).not.toHaveBeenCalled();
    expect(form(0).get('client_secret')).toBe(CLIENT_SECRET);
    expect(form(0).has('client_assertion')).toBe(false);
  });

  it('STS failure with a secret configured: retries once with the secret and logs which path worked', async () => {
    process.env.AGENFK_HUB_ENTRA_ASSERTION = 'aws-sts';
    await configure(true);
    stsSend.mockRejectedValue(new Error('AccessDenied: not allowed to GetWebIdentityToken'));
    postSpy.mockResolvedValueOnce({ data: { id_token: 'fake.jwt' } } as any);
    expect((await callback()).status).toBe(302);
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(form(0).get('client_secret')).toBe(CLIENT_SECRET);
    expect(logged.join('\n')).toMatch(/AccessDenied/);
    expect(logged.join('\n')).toMatch(/client secret/i);
  });

  it('Entra rejects the assertion (invalid_client) with a secret configured: retries once with the secret', async () => {
    process.env.AGENFK_HUB_ENTRA_ASSERTION = 'aws-sts';
    await configure(true);
    stsSend.mockResolvedValue({ WebIdentityToken: ASSERTION });
    postSpy.mockRejectedValueOnce(entraError(401, { error: 'invalid_client', error_description: 'AADSTS700211: no matching federated identity', error_codes: [700211] }));
    postSpy.mockResolvedValueOnce({ data: { id_token: 'fake.jwt' } } as any);
    expect((await callback()).status).toBe(302);
    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(form(0).has('client_assertion')).toBe(true);
    expect(form(1).get('client_secret')).toBe(CLIENT_SECRET);
    expect(form(1).has('client_assertion')).toBe(false);
  });

  it('a non-credential Entra error (invalid_grant) is not retried with the secret', async () => {
    process.env.AGENFK_HUB_ENTRA_ASSERTION = 'aws-sts';
    await configure(true);
    stsSend.mockResolvedValue({ WebIdentityToken: ASSERTION });
    postSpy.mockRejectedValueOnce(entraError(400, { error: 'invalid_grant', error_description: 'AADSTS54005: code already redeemed', error_codes: [54005] }));
    const r = await callback();
    expect(r.status).toBe(502);
    expect(r.body.error_codes).toEqual([54005]);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('both paths fail: returns and logs Entra error and error_codes, never the secret or the assertion', async () => {
    process.env.AGENFK_HUB_ENTRA_ASSERTION = 'aws-sts';
    await configure(true);
    stsSend.mockResolvedValue({ WebIdentityToken: ASSERTION });
    postSpy.mockRejectedValueOnce(entraError(401, { error: 'invalid_client', error_description: 'AADSTS700211: x', error_codes: [700211] }));
    postSpy.mockRejectedValueOnce(entraError(401, INVALID_CLIENT));
    const r = await callback();
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('Entra OAuth exchange failed');
    expect(r.body.entra_error).toBe('invalid_client');
    expect(r.body.error_codes).toEqual([7000222]);
    expect(r.body.detail).not.toMatch(/AADSTS/);
    const everything = JSON.stringify(r.body) + logged.join('\n');
    expect(everything).toMatch(/7000222/);
    expect(everything).not.toContain(CLIENT_SECRET);
    expect(everything).not.toContain(ASSERTION);
  });

  it('assertion mode, no secret, STS fails: 502 naming the STS failure, no Entra call', async () => {
    process.env.AGENFK_HUB_ENTRA_ASSERTION = 'aws-sts';
    await configure(false);
    stsSend.mockRejectedValue(new Error('CredentialsProviderError: no credentials'));
    const r = await callback();
    expect(r.status).toBe(502);
    expect(r.body.detail).toBe('STS unavailable');
    expect(logged.join('\n')).toMatch(/CredentialsProviderError/);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('assertion mode, no secret, Entra answers invalid_client: 502 with Entra code, no retry', async () => {
    process.env.AGENFK_HUB_ENTRA_ASSERTION = 'aws-sts';
    await configure(false);
    stsSend.mockResolvedValue({ WebIdentityToken: ASSERTION });
    postSpy.mockRejectedValueOnce(entraError(401, INVALID_CLIENT));
    const r = await callback();
    expect(r.status).toBe(502);
    expect(r.body.entra_error).toBe('invalid_client');
    expect(r.body.error_codes).toEqual([7000222]);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('the response never carries Entra trace ids or an STS role ARN, only the log does', async () => {
    process.env.AGENFK_HUB_ENTRA_ASSERTION = 'aws-sts';
    await configure(false);
    stsSend.mockRejectedValueOnce(new Error('AccessDenied: arn:aws:sts::123456789012:assumed-role/hub-task/abc not authorized'));
    const sts = await callback();
    expect(JSON.stringify(sts.body)).not.toMatch(/123456789012|assumed-role/);
    expect(sts.body.detail).toBe('STS unavailable');
    expect(logged.join('\n')).toContain('123456789012');

    stsSend.mockResolvedValue({ WebIdentityToken: ASSERTION });
    postSpy.mockRejectedValueOnce(entraError(401, {
      error: 'invalid_client', error_codes: [7000222],
      error_description: 'AADSTS7000222: expired. Trace ID: x Correlation ID: y Timestamp: 2026-11-04',
    }));
    const entra = await callback();
    expect(JSON.stringify(entra.body)).not.toMatch(/Trace ID|Correlation ID|Timestamp/);
    expect(entra.body.error_codes).toEqual([7000222]);
    expect(logged.join('\n')).toContain('Trace ID: x');
  });

  it('secret mode: an expired-secret 401 surfaces AADSTS code instead of the bare status', async () => {
    await configure(true);
    postSpy.mockRejectedValueOnce(entraError(401, INVALID_CLIENT));
    const r = await callback();
    expect(r.status).toBe(502);
    expect(r.body.error_codes).toEqual([7000222]);
    expect(r.body.entra_error).toBe('invalid_client');
    expect(logged.join('\n')).toMatch(/7000222/);
    expect(logged.join('\n')).not.toContain(CLIENT_SECRET);
  });
});

describe('adminCanStillSignIn with assertion mode', () => {
  const cfg = {
    org_id: 'org', password_enabled: 0, google_enabled: 0, google_client_id: null, google_client_secret_enc: null,
    entra_enabled: 1, entra_tenant_id: 't', entra_client_id: 'c', entra_client_secret_enc: null, email_allowlist: null,
  };
  const ssoAdmin = { email: 'b@acme.com', password_hash: null, provider: 'entra' };
  afterEach(() => { delete process.env.AGENFK_HUB_ENTRA_ASSERTION; });

  it('Entra without a secret counts only when assertion mode is on', () => {
    expect(adminCanStillSignIn(cfg, [ssoAdmin])).toBe(false);
    process.env.AGENFK_HUB_ENTRA_ASSERTION = 'aws-sts';
    expect(adminCanStillSignIn(cfg, [ssoAdmin])).toBe(true);
  });
});
