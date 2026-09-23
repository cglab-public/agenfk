/**
 * URLs and flags the hub derives from proxy headers.
 *
 * Production is an AWS ALB, which OVERWRITES X-Forwarded-Proto but never sets
 * X-Forwarded-Host - so any X-Forwarded-Host the hub sees there was written by
 * the client. The hub used to read both raw, whatever AGENFK_HUB_TRUST_PROXY
 * said:
 *   - the protocol (cookie Secure flag, OAuth redirect) now comes from
 *     req.protocol / req.secure, which honour X-Forwarded-Proto only from a
 *     trusted proxy;
 *   - X-Forwarded-Host is no longer read at all: the host is the Host header,
 *     which proxies preserve;
 *   - URLs the hub HANDS TO OTHERS (invite join command, device-code link,
 *     hubUrl) come from AGENFK_HUB_PUBLIC_URL when it is set - production sets
 *     it to its canonical hostname. OAuth callbacks deliberately stay on the
 *     host the user is browsing, so a sign-in returns where it started.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp, configFromEnv } from '../server';
import { createPasswordUser } from '../auth/password';
import { encryptSecret } from '../crypto';
import { drainApp } from './helpers/drainApp';

const DB = path.join(os.tmpdir(), `agenfk-hub-proxyurls-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };

describe('proxy-derived URLs', () => {
  let app: any; let ctx: any; let server: import('http').Server | undefined; let cookie: string;
  const agent = () => supertest(server!);

  const boot = async (extra: Record<string, unknown> = {}) => {
    const out = await createHubApp({ dbPath: DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org', ...extra } as any);
    app = out.app; ctx = out.ctx; server = app.listen(0);
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    cookie = (await agent().post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
  };
  const invite = () => agent().post('/hub/invite/create').set('Cookie', cookie);

  beforeEach(() => { cleanup(); });
  afterEach(async () => {
    if (server) { await drainApp(server); await new Promise<void>(r => server!.close(() => r())); }
    ctx?.stopWorkers?.(); await ctx?.db.close(); cleanup();
    server = undefined; ctx = undefined;
  });

  describe('handed-out URLs', () => {
    it('use AGENFK_HUB_PUBLIC_URL when it is set, whatever host the admin browsed', async () => {
      await boot({ publicUrl: 'https://afk-hub.corp.example' });
      const r = await invite().set('Host', 'afk-hub.example').send({});
      expect(r.body.hubUrl).toBe('https://afk-hub.corp.example');
      expect(r.body.joinCommand).toBe(`agenfk hub join https://afk-hub.corp.example ${r.body.inviteToken}`);

      const d = await agent().post('/hub/device/start').set('Host', 'afk-hub.example').send({});
      expect(d.body.verificationUri).toMatch(/^https:\/\/afk-hub\.corp\.example\/connect\?code=/);
    });

    it('otherwise follow the Host header and IGNORE a client-written X-Forwarded-Host', async () => {
      await boot();
      const r = await invite().set('Host', 'hub.example.com').set('X-Forwarded-Host', 'evil.example').send({});
      expect(r.body.hubUrl).toBe('http://hub.example.com');
    });

    it('take https from X-Forwarded-Proto only when the proxy is trusted', async () => {
      await boot();
      const trusted = await invite().set('Host', 'hub.example.com').set('X-Forwarded-Proto', 'https').send({});
      expect(trusted.body.hubUrl).toBe('https://hub.example.com');
    });

    it('ignore X-Forwarded-Proto when the hub is exposed directly (trustProxy 0)', async () => {
      await boot({ trustProxy: 0 });
      const r = await invite().set('Host', 'hub.example.com').set('X-Forwarded-Proto', 'https').send({});
      expect(r.body.hubUrl).toBe('http://hub.example.com');
    });
  });

  describe('session cookie Secure flag', () => {
    const loginSetCookie = async (headers: Record<string, string>) => {
      let req = agent().post('/auth/login');
      for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
      return String((await req.send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '');
    };
    const saved = { env: process.env.NODE_ENV, sec: process.env.AGENFK_HUB_COOKIE_SECURE };
    beforeEach(() => { process.env.NODE_ENV = 'test'; delete process.env.AGENFK_HUB_COOKIE_SECURE; });
    afterEach(() => {
      if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
      if (saved.sec === undefined) delete process.env.AGENFK_HUB_COOKIE_SECURE; else process.env.AGENFK_HUB_COOKIE_SECURE = saved.sec;
    });

    it('is set when a trusted proxy reports https', async () => {
      await boot();
      expect(await loginSetCookie({ 'X-Forwarded-Proto': 'https' })).toMatch(/;\s*Secure/i);
    });

    it('is not set from X-Forwarded-Proto when no proxy is trusted', async () => {
      await boot({ trustProxy: 0 });
      expect(await loginSetCookie({ 'X-Forwarded-Proto': 'https' })).not.toMatch(/;\s*Secure/i);
    });
  });

  describe('OAuth callback', () => {
    const enableGoogle = () => ctx.db.run(`UPDATE auth_config SET google_enabled = 1, google_client_id = 'gid',
      google_client_secret_enc = ? WHERE org_id = 'org'`, [encryptSecret('gsecret', SECRET)]);
    const redirectUri = (location: string) => new URL(location).searchParams.get('redirect_uri');

    it('returns to the host being browsed, not AGENFK_HUB_PUBLIC_URL', async () => {
      await boot({ publicUrl: 'https://afk-hub.corp.example' });
      await enableGoogle();
      const r = await agent().get('/auth/google/start').set('Host', 'afk-hub.example').set('X-Forwarded-Proto', 'https').redirects(0);
      expect(redirectUri(r.headers.location)).toBe('https://afk-hub.example/auth/google/callback');
    });

    it('takes its protocol from a trusted proxy only', async () => {
      await boot({ trustProxy: 0 });
      await enableGoogle();
      const r = await agent().get('/auth/google/start').set('Host', 'hub.example.com').set('X-Forwarded-Proto', 'https').redirects(0);
      expect(redirectUri(r.headers.location)).toBe('http://hub.example.com/auth/google/callback');
    });
  });
});

describe('AGENFK_HUB_PUBLIC_URL parsing', () => {
  const KEYS = ['AGENFK_HUB_SECRET_KEY', 'AGENFK_HUB_SESSION_SECRET', 'AGENFK_HUB_PUBLIC_URL'] as const;
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  const withEnv = (v: string | undefined) => {
    process.env.AGENFK_HUB_SECRET_KEY = SECRET;
    process.env.AGENFK_HUB_SESSION_SECRET = 'sess';
    if (v === undefined) delete process.env.AGENFK_HUB_PUBLIC_URL; else process.env.AGENFK_HUB_PUBLIC_URL = v;
    return configFromEnv();
  };
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('is absent when unset or empty', () => {
    expect(withEnv(undefined).publicUrl).toBeUndefined();
    expect(withEnv('  ').publicUrl).toBeUndefined();
  });
  it('is reduced to its origin', () => {
    expect(withEnv('https://afk-hub.corp.example/').publicUrl).toBe('https://afk-hub.corp.example');
    expect(withEnv('https://afk-hub.corp.example:8443/some/path').publicUrl).toBe('https://afk-hub.corp.example:8443');
  });
  it('refuses anything that is not an http(s) URL', () => {
    expect(() => withEnv('afk-hub.corp.example')).toThrow(/AGENFK_HUB_PUBLIC_URL/);
    expect(() => withEnv('ftp://afk-hub.corp.example')).toThrow(/AGENFK_HUB_PUBLIC_URL/);
  });
});
