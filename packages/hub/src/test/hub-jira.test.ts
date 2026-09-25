import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { openPgMemDb } from '../db/postgres';
import { createPasswordUser } from '../auth/password';
import { issueApiKey, hashToken } from '../auth/apiKey';
import { decryptSecret, encryptSecret } from '../crypto';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

/**
 * Hub-centralized JIRA with per-user connections (CGLAB-412).
 *
 * An org admin registers the org's Atlassian OAuth app ONCE on the hub. Each
 * installation then connects its OWN JIRA identity through the hub: the token
 * is bound to that installation's hub api key and stored encrypted, and the
 * read-only relay calls JIRA with the caller's own token - so JIRA's
 * permissions apply per person, and no JIRA credential ever reaches a laptop.
 *
 * The binding flow resists link forgery: the callback only holds the token
 * PENDING and hands the browser a one-time completion code on the loopback
 * address the starting installation named; the token is bound only when the
 * SAME api key redeems that code. A victim tricked into authorising an
 * attacker's link never gives the attacker's key their token.
 *
 * Run against SQLite and pg-mem: hub schema bugs have shipped before because
 * only one dialect was exercised.
 */

const SECRET = 'a'.repeat(64);
const CLOUD_ID = 'cloud-123';
const CLOUD_URL = 'https://acme.atlassian.net';
const RETURN_TO = 'http://localhost:3000/jira/oauth/callback';

let __server: any;

/**
 * Atlassian fake. Records every call. Authorization codes map to distinct
 * users; refresh tokens rotate (a used one is rejected), like Atlassian's.
 */
function atlassianFake(opts: {
  validTokens?: string[];
  refreshOk?: boolean;
  refreshStatus?: number;
  /** A refresh answered 200 but without a token, as a broken edge proxy might. */
  refreshMalformed?: boolean;
  onRefresh?: () => Promise<void>;
  resources?: Array<{ id: string; url: string }>;
  issueStatus?: Record<string, number>;
  delayMs?: number;
} = {}) {
  const codes: Record<string, { at: string; rt: string }> = {
    'good-code': { at: 'at-1', rt: 'rt-1' },
    'code-b': { at: 'at-b', rt: 'rt-b' },
  };
  const valid = new Set(opts.validTokens ?? ['at-1', 'at-b']);
  const liveRefresh = new Set(['rt-1', 'rt-b']);
  const emailByToken: Record<string, string> = { 'at-1': 'alice@acme.test', 'at-b': 'bob@acme.test' };
  const calls: Array<{ method: string; url: string; auth?: string; body?: string }> = [];
  let refreshCount = 0;

  const json = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body),
  });

  const fn = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = init?.headers ?? {};
    const auth = headers.Authorization ?? headers.authorization;
    const body = typeof init?.body === 'string' ? init.body : init?.body?.toString();
    calls.push({ method, url, auth, body });
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));

    if (url === 'https://auth.atlassian.com/oauth/token') {
      const params = new URLSearchParams(body ?? '');
      if (params.get('grant_type') === 'authorization_code') {
        const user = codes[params.get('code') ?? ''];
        if (!user) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: user.at, refresh_token: user.rt, expires_in: 3600 });
      }
      if (params.get('grant_type') === 'refresh_token') {
        refreshCount++;
        if (opts.onRefresh) await opts.onRefresh();
        if (opts.refreshStatus) return json(opts.refreshStatus, { error: 'server_error' });
        if (opts.refreshMalformed) return json(200, { hello: 'proxy' });
        if (opts.refreshOk === false) return json(400, { error: 'invalid_grant' });
        const rt = params.get('refresh_token') ?? '';
        if (!liveRefresh.has(rt)) return json(403, { error: 'unauthorized_client' });
        liveRefresh.delete(rt);
        const next = `at-${refreshCount + 1}`;
        const nextRt = `rt-${refreshCount + 1}`;
        valid.add(next);
        liveRefresh.add(nextRt);
        return json(200, { access_token: next, refresh_token: nextRt, expires_in: 3600 });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }

    const token = String(auth ?? '').replace(/^Bearer /, '');
    if (!auth || !valid.has(token)) return json(401, { message: 'Unauthorized' });

    if (url === 'https://api.atlassian.com/oauth/token/accessible-resources') {
      return json(200, opts.resources ?? [{ id: CLOUD_ID, url: CLOUD_URL }]);
    }
    const prefix = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/`;
    if (url.startsWith(prefix)) {
      const rest = url.slice(prefix.length);
      if (rest === 'myself') return json(200, { emailAddress: emailByToken[token] ?? 'refreshed@acme.test' });
      if (rest.startsWith('project/search')) return json(200, { values: [{ key: 'ACME', name: 'Acme' }] });
      if (rest.startsWith('search/jql')) return json(200, { issues: [{ key: 'ACME-1', fields: { summary: 'One' } }] });
      const m = /^issue\/([^?]+)/.exec(rest);
      if (m) {
        const key = decodeURIComponent(m[1]);
        const status = opts.issueStatus?.[key] ?? 200;
        if (status !== 200) return json(status, { errorMessages: ['nope'] });
        return json(200, { key, fields: { summary: `Summary of ${key}` } });
      }
    }
    return json(404, { message: `fake: unhandled ${method} ${url}` });
  });

  return { fn, calls, get refreshCount() { return refreshCount; } };
}

type Backend = 'sqlite' | 'postgres';

describe.each<Backend>(['sqlite', 'postgres'])('hub JIRA (%s)', (backend) => {
  let db: HubDb;
  let cookieAdmin: string;
  let cookieView: string;
  let keyA: string;
  let keyA2: string;
  let keyB: string;
  let keyShared: string;

  beforeEach(async () => {
    db = backend === 'sqlite' ? await openSqliteDb(':memory:') : await openPgMemDb();
    const out = await createHubApp({
      dbPath: ':memory:', secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org-a', db,
    } as any);
    if (__server) await new Promise<void>(r => __server.close(() => r()));
    __server = out.app.listen(0);
    await createPasswordUser(db, 'org-a', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(db, 'org-a', 'view@x', 'longenough1', 'viewer');
    cookieAdmin = await loginAs(__server, 'admin@x', 'longenough1');
    cookieView = await loginAs(__server, 'view@x', 'longenough1');
    // Installation-bound, as `hub login` and invites issue them.
    keyA = await issueApiKey(db, 'org-a', 'alice-laptop', { installationId: 'inst-alice' });
    keyA2 = await issueApiKey(db, 'org-a', 'bob-laptop', { installationId: 'inst-bob' });
    keyB = await issueApiKey(db, 'org-b', 'other-org', { installationId: 'inst-other' });
    // An admin-minted key bound to no installation: shareable, e.g. a CI key.
    keyShared = await issueApiKey(db, 'org-a', 'ci');
  });

  afterEach(async () => {
    await drainApp(__server);
    await db.close();
    vi.unstubAllGlobals();
  });

  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
  const configure = (body: Record<string, unknown> = { clientId: 'cid-1', clientSecret: 'csecret-1' }) =>
    supertest(__server).put('/v1/admin/jira').set('Cookie', cookieAdmin).send(body);
  const status = (k: string) => supertest(__server).get('/v1/jira/status').set(bearer(k));
  const start = (k: string, returnTo: unknown = RETURN_TO) =>
    supertest(__server).post('/v1/jira/oauth/start').set(bearer(k)).send({ returnTo });
  const stateOf = (r: any) => new URL(r.body.authorizeUrl).searchParams.get('state')!;

  /** start -> callback; returns the completion code the browser would carry home. */
  async function authorize(key: string, code = 'good-code'): Promise<string> {
    const s = await start(key);
    expect(s.status).toBe(200);
    const cb = await supertest(__server).get(`/v1/jira/oauth/callback?code=${code}&state=${stateOf(s)}`);
    expect(cb.status).toBe(302);
    const loc = new URL(cb.headers.location);
    expect(loc.origin + loc.pathname).toBe(RETURN_TO);
    const completion = loc.searchParams.get('completion');
    expect(completion).toBeTruthy();
    return completion!;
  }
  const complete = (key: string, completion: string) =>
    supertest(__server).post('/v1/jira/oauth/complete').set(bearer(key)).send({ completion });
  async function connect(key: string, code = 'good-code') {
    const r = await complete(key, await authorize(key, code));
    expect(r.status).toBe(200);
    return r;
  }

  // ── S1: admin configuration of the org app ───────────────────────────────
  describe('admin: the org Atlassian app', () => {
    it('GET /v1/admin/jira reports an unconfigured org and the callback URL to register', async () => {
      const r = await supertest(__server).get('/v1/admin/jira').set('Cookie', cookieAdmin);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ configured: false, clientId: '', clientSecretSet: false, connectedCount: 0 });
      expect(r.body.redirectUri).toMatch(/^http:\/\/[^/]+\/v1\/jira\/oauth\/callback$/);
    });

    it('is admin-only: viewers get 403, anonymous callers 401', async () => {
      expect((await supertest(__server).get('/v1/admin/jira').set('Cookie', cookieView)).status).toBe(403);
      expect((await supertest(__server).get('/v1/admin/jira')).status).toBe(401);
      expect((await supertest(__server).put('/v1/admin/jira').set('Cookie', cookieView).send({ clientId: 'x', clientSecret: 'y' })).status).toBe(403);
      expect((await supertest(__server).post('/v1/admin/jira/disconnect-all').set('Cookie', cookieView)).status).toBe(403);
    });

    it('PUT stores the client secret encrypted and never returns it', async () => {
      const r = await configure();
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ configured: true, clientId: 'cid-1', clientSecretSet: true });
      expect(JSON.stringify(r.body)).not.toContain('csecret-1');
      const row = await db.get<{ client_secret_enc: string }>('SELECT client_secret_enc FROM org_jira WHERE org_id = ?', ['org-a']);
      expect(row!.client_secret_enc.startsWith('v1:')).toBe(true);
      expect(decryptSecret(row!.client_secret_enc, SECRET)).toBe('csecret-1');
      const g = await supertest(__server).get('/v1/admin/jira').set('Cookie', cookieAdmin);
      expect(JSON.stringify(g.body)).not.toMatch(/csecret-1|v1:/);
    });

    it('PUT with a blank secret keeps the stored one', async () => {
      await configure();
      expect((await configure({ clientId: 'cid-1', clientSecret: '' })).status).toBe(200);
      const row = await db.get<{ client_secret_enc: string }>('SELECT client_secret_enc FROM org_jira WHERE org_id = ?', ['org-a']);
      expect(decryptSecret(row!.client_secret_enc, SECRET)).toBe('csecret-1');
    });

    it('PUT refuses a new client id without that app\'s secret', async () => {
      await configure();
      expect((await configure({ clientId: 'cid-2' })).status).toBe(400);
      const g = await supertest(__server).get('/v1/admin/jira').set('Cookie', cookieAdmin);
      expect(g.body.clientId).toBe('cid-1');
    });

    it('PUT rejects a missing client id, and a first save without a secret', async () => {
      expect((await configure({ clientId: '', clientSecret: 's' })).status).toBe(400);
      expect((await configure({ clientSecret: 's' })).status).toBe(400);
      expect((await configure({ clientId: 'cid-1' })).status).toBe(400);
      expect((await configure({ clientId: 'x'.repeat(300), clientSecret: 's' })).status).toBe(400);
    });

    it('counts connected installations, and a new client id drops them all (their tokens belong to the old app)', async () => {
      vi.stubGlobal('fetch', atlassianFake().fn);
      await configure();
      await connect(keyA);
      await connect(keyA2, 'code-b');
      const g = await supertest(__server).get('/v1/admin/jira').set('Cookie', cookieAdmin);
      expect(g.body.connectedCount).toBe(2);
      expect((await configure({ clientId: 'cid-1', clientSecret: 'rotated' })).body.connectedCount).toBe(2);
      expect((await configure({ clientId: 'cid-2', clientSecret: 'other' })).body.connectedCount).toBe(0);
      expect((await status(keyA)).body.connected).toBe(false);
    });

    it('disconnect-all drops every installation\'s connection', async () => {
      vi.stubGlobal('fetch', atlassianFake().fn);
      await configure();
      await connect(keyA);
      const r = await supertest(__server).post('/v1/admin/jira/disconnect-all').set('Cookie', cookieAdmin);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ configured: true, connectedCount: 0 });
      expect((await status(keyA)).body.connected).toBe(false);
    });
  });

  // ── S1: per-user OAuth through the hub ───────────────────────────────────
  describe('per-user OAuth', () => {
    it('start requires an api key and a configured app', async () => {
      expect((await supertest(__server).post('/v1/jira/oauth/start').send({ returnTo: RETURN_TO })).status).toBe(401);
      const r = await start(keyA);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('jira_not_configured');
    });

    it('a key bound to no installation cannot connect: it may be shared, and a connection is one person\'s', async () => {
      await configure();
      const r = await start(keyShared);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('key_not_personal');
    });

    it('two callbacks for one state (reload, retry) do not destroy the first one\'s result', async () => {
      vi.stubGlobal('fetch', atlassianFake({ delayMs: 20 }).fn);
      await configure();
      const state = stateOf(await start(keyA));
      const [a, b] = await Promise.all([
        supertest(__server).get(`/v1/jira/oauth/callback?code=good-code&state=${state}`),
        supertest(__server).get(`/v1/jira/oauth/callback?code=good-code&state=${state}`),
      ]);
      const winner = [a, b].find(r => r.status === 302)!;
      expect([a, b].map(r => r.status).sort()).toEqual([302, 400]);
      const completion = new URL(winner.headers.location).searchParams.get('completion')!;
      expect((await complete(keyA, completion)).status).toBe(200);
    });

    it('start only returns to a loopback agenfk callback (no open redirect)', async () => {
      await configure();
      for (const returnTo of [
        'https://evil.test/jira/oauth/callback',
        'http://localhost.evil.test/jira/oauth/callback',
        'http://127.0.0.1:3000/somewhere-else',
        'http://user@localhost:3000/jira/oauth/callback',
        'javascript:alert(1)',
        '',
        null,
      ]) {
        expect((await start(keyA, returnTo)).status, String(returnTo)).toBe(400);
      }
      // No returnTo at all.
      expect((await supertest(__server).post('/v1/jira/oauth/start').set(bearer(keyA)).send({})).status).toBe(400);
      for (const returnTo of ['http://127.0.0.1:4123/jira/oauth/callback', 'http://[::1]:3000/jira/oauth/callback', RETURN_TO]) {
        expect((await start(keyA, returnTo)).status, returnTo).toBe(200);
      }
    });

    it('start hands back an Atlassian authorize URL for the org app, returning to the hub', async () => {
      await configure();
      const r = await start(keyA);
      const loc = new URL(r.body.authorizeUrl);
      expect(loc.origin + loc.pathname).toBe('https://auth.atlassian.com/authorize');
      expect(loc.searchParams.get('client_id')).toBe('cid-1');
      expect(loc.searchParams.get('audience')).toBe('api.atlassian.com');
      expect(loc.searchParams.get('response_type')).toBe('code');
      expect(loc.searchParams.get('scope')!.split(' ')).toEqual(
        expect.arrayContaining(['read:jira-user', 'read:jira-work', 'offline_access']));
      expect(loc.searchParams.get('redirect_uri')).toMatch(/\/v1\/jira\/oauth\/callback$/);
      expect(loc.searchParams.get('state')).toBeTruthy();
      expect(r.body.authorizeUrl).not.toContain('csecret-1');
    });

    it('the full flow binds the user\'s own token to THEIR key, encrypted', async () => {
      const fake = atlassianFake();
      vi.stubGlobal('fetch', fake.fn);
      await configure();
      const r = await connect(keyA);
      expect(r.body).toMatchObject({ connected: true, cloudUrl: CLOUD_URL, email: 'alice@acme.test' });

      const tokenCall = fake.calls.find(c => c.url === 'https://auth.atlassian.com/oauth/token')!;
      const params = new URLSearchParams(tokenCall.body);
      expect(params.get('client_secret')).toBe('csecret-1');
      expect(params.get('redirect_uri')).toMatch(/\/v1\/jira\/oauth\/callback$/);
      for (const c of fake.calls.filter(x => x !== tokenCall)) {
        expect(`${c.url} ${c.body ?? ''} ${c.auth ?? ''}`).not.toContain('csecret-1');
      }
      const row = await db.get<{ token_enc: string; org_id: string; account_email: string }>(
        'SELECT token_enc, org_id, account_email FROM jira_connections WHERE key_hash = ?', [hashToken(keyA)]);
      expect(row!.org_id).toBe('org-a');
      expect(row!.account_email).toBe('alice@acme.test');
      expect(row!.token_enc.startsWith('v1:')).toBe(true);
      expect(row!.token_enc).not.toMatch(/at-1|rt-1/);
      expect(JSON.parse(decryptSecret(row!.token_enc, SECRET))).toMatchObject({ access_token: 'at-1', refresh_token: 'rt-1' });

      expect((await status(keyA)).body).toMatchObject({ configured: true, connected: true, email: 'alice@acme.test' });
      // Another person in the same org is NOT connected by Alice's grant.
      expect((await status(keyA2)).body).toMatchObject({ configured: true, connected: false });
    });

    it('nothing is bound until the completion is redeemed', async () => {
      vi.stubGlobal('fetch', atlassianFake().fn);
      await configure();
      await authorize(keyA);
      expect((await status(keyA)).body.connected).toBe(false);
      const n = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jira_connections', []);
      expect(Number(n!.n)).toBe(0);
    });

    it('a completion redeemed by a DIFFERENT key binds nothing (link forgery)', async () => {
      vi.stubGlobal('fetch', atlassianFake().fn);
      await configure();
      // The attacker starts a flow with their key; the victim's browser completes Atlassian's consent.
      const completion = await authorize(keyA2);
      expect((await complete(keyA, completion)).status).toBe(403);
      expect((await status(keyA)).body.connected).toBe(false);
      expect((await status(keyA2)).body.connected).toBe(false);
      // And the code is burnt: the starting key cannot use it afterwards either.
      expect((await complete(keyA2, completion)).status).toBe(400);
    });

    it('a completion is single-use and expires', async () => {
      vi.stubGlobal('fetch', atlassianFake().fn);
      await configure();
      const c1 = await authorize(keyA);
      expect((await complete(keyA, c1)).status).toBe(200);
      expect((await complete(keyA, c1)).status).toBe(400);

      const c2 = await authorize(keyA);
      await db.run('UPDATE jira_oauth_pending SET expires_at = ?', ['2000-01-01T00:00:00.000Z']);
      expect((await complete(keyA, c2)).status).toBe(400);
    });

    it('callback with an unknown, replayed or expired state is refused without calling Atlassian', async () => {
      const fake = atlassianFake();
      vi.stubGlobal('fetch', fake.fn);
      await configure();
      expect((await supertest(__server).get('/v1/jira/oauth/callback?code=good-code&state=forged')).status).toBe(400);

      const state = stateOf(await start(keyA));
      expect((await supertest(__server).get(`/v1/jira/oauth/callback?code=good-code&state=${state}`)).status).toBe(302);
      fake.calls.length = 0;
      expect((await supertest(__server).get(`/v1/jira/oauth/callback?code=good-code&state=${state}`)).status).toBe(400);

      const state2 = stateOf(await start(keyA));
      await db.run('UPDATE jira_oauth_pending SET expires_at = ? WHERE state = ?', ['2000-01-01T00:00:00.000Z', state2]);
      expect((await supertest(__server).get(`/v1/jira/oauth/callback?code=good-code&state=${state2}`)).status).toBe(400);
      expect(fake.calls).toHaveLength(0);
    });

    it('a denied consent or rejected code returns to the installation with an error, binding nothing', async () => {
      vi.stubGlobal('fetch', atlassianFake().fn);
      await configure();
      for (const q of ['error=access_denied', 'code=bad-code']) {
        const cb = await supertest(__server).get(`/v1/jira/oauth/callback?${q}&state=${stateOf(await start(keyA))}`);
        expect(cb.status, q).toBe(302);
        const loc = new URL(cb.headers.location);
        expect(loc.origin + loc.pathname).toBe(RETURN_TO);
        expect(loc.searchParams.get('error'), q).toBeTruthy();
        expect(loc.searchParams.get('completion')).toBeNull();
      }
      expect((await status(keyA)).body.connected).toBe(false);
    });

    it('a site-less account is an error', async () => {
      vi.stubGlobal('fetch', atlassianFake({ resources: [] }).fn);
      await configure();
      const cb = await supertest(__server).get(`/v1/jira/oauth/callback?code=good-code&state=${stateOf(await start(keyA))}`);
      expect(new URL(cb.headers.location).searchParams.get('error')).toBe('no_accessible_site');
    });

    it('disconnect also drops a flow the key left half-done (it may hold a token)', async () => {
      vi.stubGlobal('fetch', atlassianFake().fn);
      await configure();
      await authorize(keyA);
      await supertest(__server).post('/v1/jira/disconnect').set(bearer(keyA));
      const n = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jira_oauth_pending WHERE key_hash = ?', [hashToken(keyA)]);
      expect(Number(n!.n)).toBe(0);
    });

    it('revoking a key deletes its JIRA token and stops counting it', async () => {
      vi.stubGlobal('fetch', atlassianFake().fn);
      await configure();
      await connect(keyA);
      await connect(keyA2, 'code-b');
      const del = await supertest(__server).delete(`/v1/admin/api-keys/${hashToken(keyA).slice(0, 16)}`).set('Cookie', cookieAdmin);
      expect(del.status).toBe(200);
      const row = await db.get('SELECT key_hash FROM jira_connections WHERE key_hash = ?', [hashToken(keyA)]);
      expect(row).toBeUndefined();
      const g = await supertest(__server).get('/v1/admin/jira').set('Cookie', cookieAdmin);
      expect(g.body.connectedCount).toBe(1);
    });

    it('hiding a person and retiring an installation also delete their JIRA tokens, at once', async () => {
      vi.stubGlobal('fetch', atlassianFake().fn);
      await configure();
      const now = new Date().toISOString();
      for (const [id, email] of [['inst-alice', 'alice@acme.test'], ['inst-bob', 'bob@acme.test']]) {
        await db.run('INSERT INTO installations (id, org_id, first_seen, last_seen, git_email) VALUES (?, ?, ?, ?, ?)', [id, 'org-a', now, now, email]);
      }
      await connect(keyA);
      await connect(keyA2, 'code-b');
      const hide = await supertest(__server).post('/v1/admin/hidden-users').set('Cookie', cookieAdmin).send({ userKey: 'alice@acme.test' });
      expect(hide.status).toBe(201);
      // Checked straight in the table: no admin read has swept anything yet.
      expect(await db.get('SELECT key_hash FROM jira_connections WHERE key_hash = ?', [hashToken(keyA)])).toBeUndefined();
      const retire = await supertest(__server).post('/v1/admin/installations/inst-bob/retire').set('Cookie', cookieAdmin);
      expect(retire.status).toBe(200);
      expect(await db.get('SELECT key_hash FROM jira_connections WHERE key_hash = ?', [hashToken(keyA2)])).toBeUndefined();
    });

    it('an expired flow holding a token is swept by the next start', async () => {
      await configure();
      await db.run(
        `INSERT INTO jira_oauth_pending (state, org_id, key_hash, return_to, completion_hash, token_enc, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['old-state', 'org-a', hashToken(keyA), RETURN_TO, 'h', encryptSecret('{"access_token":"x","refresh_token":"y"}', SECRET), '2000-01-01T00:00:00.000Z'],
      );
      await start(keyA2);
      expect(await db.get('SELECT state FROM jira_oauth_pending WHERE state = ?', ['old-state'])).toBeUndefined();
    });

    it('a key revoked by any other route is swept when an admin looks', async () => {
      vi.stubGlobal('fetch', atlassianFake().fn);
      await configure();
      await connect(keyA);
      await db.run('UPDATE api_keys SET revoked_at = ? WHERE token_hash = ?', [new Date().toISOString(), hashToken(keyA)]);
      const g = await supertest(__server).get('/v1/admin/jira').set('Cookie', cookieAdmin);
      expect(g.body.connectedCount).toBe(0);
      expect(await db.get('SELECT key_hash FROM jira_connections WHERE key_hash = ?', [hashToken(keyA)])).toBeUndefined();
    });

    it('POST /v1/jira/disconnect drops only the caller\'s connection', async () => {
      vi.stubGlobal('fetch', atlassianFake().fn);
      await configure();
      await connect(keyA);
      await connect(keyA2, 'code-b');
      const r = await supertest(__server).post('/v1/jira/disconnect').set(bearer(keyA));
      expect(r.status).toBe(200);
      expect(r.body.connected).toBe(false);
      expect((await status(keyA)).body.connected).toBe(false);
      expect((await status(keyA2)).body.connected).toBe(true);
    });
  });

  // ── S2: installation-facing relay with the caller's own token ────────────
  describe('installation relay', () => {
    async function connectedUser(fakeOpts: Parameters<typeof atlassianFake>[0] = {}) {
      const fake = atlassianFake(fakeOpts);
      vi.stubGlobal('fetch', fake.fn);
      await configure();
      await connect(keyA);
      fake.calls.length = 0;
      return fake;
    }
    const relay = (path: string, k = keyA) => supertest(__server).get(`/v1/jira/rest/api/3/${path}`).set(bearer(k));

    it('status requires an api key and exposes no credential', async () => {
      expect((await supertest(__server).get('/v1/jira/status')).status).toBe(401);
      expect((await status('agk_nope')).status).toBe(401);
      await connectedUser();
      const r = await status(keyA);
      expect(r.body).toMatchObject({ configured: true, connected: true, cloudId: CLOUD_ID, cloudUrl: CLOUD_URL, email: 'alice@acme.test', lastError: null });
      expect(JSON.stringify(r.body)).not.toMatch(/at-1|rt-1|csecret-1|cid-1|v1:/);
    });

    it('a key from another org sees neither the app nor any connection', async () => {
      await connectedUser();
      expect((await status(keyB)).body).toMatchObject({ configured: false, connected: false });
      expect((await relay('project/search?maxResults=50', keyB)).status).toBe(409);
    });

    it('relays with the CALLER\'s own token, so JIRA permissions apply per person', async () => {
      const fake = await connectedUser();
      await connect(keyA2, 'code-b');
      fake.calls.length = 0;
      expect((await relay('myself', keyA)).body.emailAddress).toBe('alice@acme.test');
      expect((await relay('myself', keyA2)).body.emailAddress).toBe('bob@acme.test');
      expect(fake.calls.map(c => c.auth)).toEqual(['Bearer at-1', 'Bearer at-b']);
    });

    it('an unconnected user in a connected org cannot ride anyone else\'s token', async () => {
      const fake = await connectedUser();
      const r = await relay('myself', keyA2);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('jira_not_connected');
      expect(fake.calls).toHaveLength(0);
    });

    it('relays an allowed read and returns Atlassian\'s body', async () => {
      const fake = await connectedUser();
      const r = await relay('project/search?maxResults=50');
      expect(r.status).toBe(200);
      expect(r.body.values[0].key).toBe('ACME');
      expect(fake.calls[0].url).toBe(`https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/project/search?maxResults=50`);
      expect(fake.calls[0].method).toBe('GET');
    });

    it('relays search/jql and issue/<KEY>, preserving the query string', async () => {
      const fake = await connectedUser();
      const jql = encodeURIComponent('project = "ACME" ORDER BY created DESC');
      const s = await relay(`search/jql?jql=${jql}&maxResults=50&fields=summary`);
      expect(s.body.issues[0].key).toBe('ACME-1');
      expect(fake.calls[0].url).toBe(`https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/search/jql?jql=${jql}&maxResults=50&fields=summary`);
      expect((await relay('issue/ACME-7?fields=summary')).body.fields.summary).toBe('Summary of ACME-7');
    });

    it('passes Atlassian\'s 404/403/400 through so a client can tell a bad key from an outage', async () => {
      await connectedUser({ issueStatus: { 'ACME-404': 404, 'ACME-403': 403, 'ACME-400': 400 } });
      for (const code of [404, 403, 400]) {
        expect((await relay(`issue/ACME-${code}?fields=summary`)).status).toBe(code);
      }
    });

    it('refuses anything outside the read-only allow-list with not_relayed, without calling Atlassian', async () => {
      const fake = await connectedUser();
      for (const path of [
        '/v1/jira/rest/api/3/user/search?query=a',
        '/v1/jira/rest/api/3/issue/ACME-1/comment',
        '/v1/jira/rest/api/3/issue/not-a-key',
        '/v1/jira/rest/api/3/issue/..%2F..%2Fmyself',
        '/v1/jira/rest/api/2/myself',
        '/v1/jira/rest/api/3/',
      ]) {
        const r = await supertest(__server).get(path).set(bearer(keyA));
        expect(r.status, path).toBe(404);
        expect(r.body.code, path).toBe('not_relayed');
      }
      expect((await supertest(__server).post('/v1/jira/rest/api/3/project/search').set(bearer(keyA)).send({})).status).toBe(404);
      expect((await relay(`search/jql?jql=${'a'.repeat(5000)}`)).status).toBe(414);
      expect(fake.calls).toHaveLength(0);
    });

    it('refreshes an expired token once, retries, and persists the rotated token on THAT connection', async () => {
      await connectedUser();
      const expired = atlassianFake({ validTokens: [] });
      vi.stubGlobal('fetch', expired.fn);
      expect((await relay('myself')).status).toBe(200);
      expect(expired.refreshCount).toBe(1);
      const refresh = expired.calls.find(c => c.url === 'https://auth.atlassian.com/oauth/token')!;
      const params = new URLSearchParams(refresh.body);
      expect(params.get('refresh_token')).toBe('rt-1');
      expect(params.get('client_secret')).toBe('csecret-1');
      expect(expired.calls.at(-1)!.auth).toBe('Bearer at-2');
      const row = await db.get<{ token_enc: string }>('SELECT token_enc FROM jira_connections WHERE key_hash = ?', [hashToken(keyA)]);
      expect(JSON.parse(decryptSecret(row!.token_enc, SECRET))).toMatchObject({ access_token: 'at-2', refresh_token: 'rt-2' });
    });

    it('concurrent requests on an expired token share ONE refresh (Atlassian rotates refresh tokens)', async () => {
      await connectedUser();
      const expired = atlassianFake({ validTokens: [], delayMs: 25 });
      vi.stubGlobal('fetch', expired.fn);
      const rs = await Promise.all([1, 2, 3, 4].map(() => relay('myself')));
      expect(rs.map(r => r.status)).toEqual([200, 200, 200, 200]);
      expect(expired.refreshCount).toBe(1);
    });

    it('a rejected refresh marks the grant dead: status says so, and no more refresh attempts', async () => {
      await connectedUser();
      const dead = atlassianFake({ validTokens: [], refreshOk: false });
      vi.stubGlobal('fetch', dead.fn);
      const first = await relay('myself');
      expect(first.status).toBe(502);
      expect(first.body.code).toBe('jira_auth_failed');
      expect((await status(keyA)).body).toMatchObject({ configured: true, connected: false, lastError: 'refresh_rejected' });
      expect((await relay('myself')).status).toBe(409);
      expect(dead.refreshCount).toBe(1);
    });

    it('reconnecting clears the recorded error', async () => {
      await connectedUser();
      vi.stubGlobal('fetch', atlassianFake({ validTokens: [], refreshOk: false }).fn);
      await relay('myself');
      vi.stubGlobal('fetch', atlassianFake().fn);
      await connect(keyA);
      expect((await status(keyA)).body).toMatchObject({ connected: true, lastError: null });
    });

    it('a 5xx from the token endpoint is an outage, not a dead grant: the connection is kept', async () => {
      await connectedUser();
      vi.stubGlobal('fetch', atlassianFake({ validTokens: [], refreshStatus: 503 }).fn);
      const r = await relay('myself');
      expect(r.status).toBe(502);
      expect(r.body.code).toBe('jira_unreachable');
      expect((await status(keyA)).body.connected).toBe(true);
    });

    it('a 429 or a malformed 200 from the token endpoint is not a dead grant either', async () => {
      for (const opts of [{ refreshStatus: 429 }, { refreshMalformed: true }]) {
        await connectedUser();
        vi.stubGlobal('fetch', atlassianFake({ validTokens: [], ...opts }).fn);
        const r = await relay('myself');
        expect(r.body.code, JSON.stringify(opts)).toBe('jira_unreachable');
        expect((await status(keyA)).body.connected, JSON.stringify(opts)).toBe(true);
      }
    });

    it('a refresh that loses the rotation race to another replica adopts that replica\'s token', async () => {
      await connectedUser();
      const fake = atlassianFake({
        validTokens: ['at-other'],
        refreshOk: false,
        onRefresh: async () => {
          await db.run('UPDATE jira_connections SET token_enc = ? WHERE key_hash = ?',
            [encryptSecret(JSON.stringify({ access_token: 'at-other', refresh_token: 'rt-other' }), SECRET), hashToken(keyA)]);
        },
      });
      vi.stubGlobal('fetch', fake.fn);
      expect((await relay('myself')).status).toBe(200);
      expect(fake.calls.at(-1)!.auth).toBe('Bearer at-other');
      expect((await status(keyA)).body.connected).toBe(true);
    });

    it('a refresh in flight when the user disconnects does not write the token back', async () => {
      await connectedUser();
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      const fake = atlassianFake({ validTokens: [], onRefresh: () => gate });
      vi.stubGlobal('fetch', fake.fn);
      const pending = relay('myself').then(r => r);
      await vi.waitFor(() => expect(fake.refreshCount).toBe(1));
      await supertest(__server).post('/v1/jira/disconnect').set(bearer(keyA));
      release();
      expect((await pending).status).toBe(409);
      const row = await db.get<{ token_enc: string | null }>('SELECT token_enc FROM jira_connections WHERE key_hash = ?', [hashToken(keyA)]);
      expect(row?.token_enc ?? null).toBeNull();
    });

    it('an unreachable Atlassian is a 502, never a hang or a crash', async () => {
      await connectedUser();
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
      const r = await relay('myself');
      expect(r.status).toBe(502);
      expect(r.body.code).toBe('jira_unreachable');
    });
  });
});

/**
 * The redirect URI is the hub's CANONICAL public URL when one is configured:
 * the admin registers what the admin page shows, and every installation's
 * start must send Atlassian that same URI, whatever hostname it joined by.
 */
describe('hub JIRA callback URL with AGENFK_HUB_PUBLIC_URL', () => {
  let db: HubDb;
  let server: any;
  beforeEach(async () => {
    db = await openSqliteDb(':memory:');
    const out = await createHubApp({
      dbPath: ':memory:', secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org-a', db,
      publicUrl: 'https://hub.public.test',
    } as any);
    server = out.app.listen(0);
  });
  afterEach(async () => {
    await drainApp(server);
    await new Promise<void>(r => server.close(() => r()));
    await db.close();
  });

  it('uses the public URL for both the admin page and every start', async () => {
    await createPasswordUser(db, 'org-a', 'admin@x', 'longenough1', 'admin');
    const cookie = await loginAs(server, 'admin@x', 'longenough1');
    const key = await issueApiKey(db, 'org-a', 'k', { installationId: 'inst' });
    const put = await supertest(server).put('/v1/admin/jira').set('Cookie', cookie).send({ clientId: 'cid', clientSecret: 's' });
    expect(put.body.redirectUri).toBe('https://hub.public.test/v1/jira/oauth/callback');
    const r = await supertest(server).post('/v1/jira/oauth/start').set('Authorization', `Bearer ${key}`).send({ returnTo: RETURN_TO });
    expect(new URL(r.body.authorizeUrl).searchParams.get('redirect_uri')).toBe('https://hub.public.test/v1/jira/oauth/callback');
  });
});
