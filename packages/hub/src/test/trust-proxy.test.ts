/**
 * Which X-Forwarded-For hop the hub believes (AGENFK_HUB_TRUST_PROXY).
 *
 * Production is an AWS ALB in front of the hub. The ALB APPENDS the address it
 * saw to whatever X-Forwarded-For the client sent, so the header reads
 * "<anything the client wrote>, <real client>". The hub used to key every rate
 * limit on the FIRST hop - the part the client writes - so a fresh header per
 * request was a fresh budget: login, device-code, invite redemption.
 *
 * Now Express decides, from how many proxies are trusted: the default is one
 * (the ALB, or any single reverse proxy), 0 is a hub exposed directly, and
 * `true` - "trust every hop", which is the old behaviour - is refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp, configFromEnv } from '../server';
import { drainApp } from './helpers/drainApp';

const DB = path.join(os.tmpdir(), `agenfk-hub-trustproxy-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };

/** /auth/login allows 20 attempts per window per client; attempt 21 is the probe. */
const LOGIN_BUDGET = 20;

describe('hub client IP behind a proxy', () => {
  let app: any; let ctx: any; let server: import('http').Server;
  // A different email each attempt, so the per-ACCOUNT lockout (5 failures)
  // never fires and only the per-client limit is under test.
  let n = 0;
  const login = (xff: string) => supertest(server).post('/auth/login')
    .set('X-Forwarded-For', xff).send({ email: `nobody${n++}@x`, password: 'wrong-password' });

  const boot = async (extra: Record<string, unknown> = {}) => {
    const out = await createHubApp({ dbPath: DB, secretKey: 'a'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org', ...extra } as any);
    app = out.app; ctx = out.ctx;
    server = app.listen(0);
  };

  beforeEach(() => { cleanup(); });
  afterEach(async () => {
    if (server) { await drainApp(server); await new Promise<void>(r => server.close(() => r())); }
    ctx?.stopWorkers?.(); await ctx?.db.close(); cleanup();
    server = undefined as any; ctx = undefined;
  });

  it('by default ignores the client-written first hop: rotating it buys no new budget', async () => {
    await boot();
    for (let i = 0; i < LOGIN_BUDGET; i++) {
      const r = await login(`10.9.${i}.1, 203.0.113.5`);
      expect(r.status, `attempt ${i + 1}`).not.toBe(429);
    }
    expect((await login('10.9.250.1, 203.0.113.5')).status).toBe(429);
  });

  it('by default still tells two real clients apart by the hop the proxy appended', async () => {
    await boot();
    for (let i = 0; i < LOGIN_BUDGET; i++) await login('203.0.113.5');
    expect((await login('203.0.113.5')).status).toBe(429);
    expect((await login('203.0.113.6')).status).not.toBe(429);
  });

  it('with trustProxy 0 (a hub exposed directly) ignores X-Forwarded-For entirely', async () => {
    await boot({ trustProxy: 0 });
    for (let i = 0; i < LOGIN_BUDGET; i++) await login(`198.51.100.${i + 1}`);
    expect((await login('198.51.100.200')).status).toBe(429);
  });

  it('keys a client reported as ip:port by its address, not by each connection', async () => {
    // An ALB with routing.http.xff_client_port.enabled appends "ip:port"; a
    // key that kept the port would give every TCP connection its own bucket.
    await boot();
    for (let i = 0; i < LOGIN_BUDGET; i++) await login(`203.0.113.9:${40000 + i}`);
    expect((await login('203.0.113.9:50000')).status).toBe(429);
  });
});

describe('AGENFK_HUB_TRUST_PROXY parsing', () => {
  const KEYS = ['AGENFK_HUB_SECRET_KEY', 'AGENFK_HUB_SESSION_SECRET', 'AGENFK_HUB_TRUST_PROXY'] as const;
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  const withEnv = (v: string | undefined) => {
    process.env.AGENFK_HUB_SECRET_KEY = 'a'.repeat(64);
    process.env.AGENFK_HUB_SESSION_SECRET = 'sess';
    if (v === undefined) delete process.env.AGENFK_HUB_TRUST_PROXY;
    else process.env.AGENFK_HUB_TRUST_PROXY = v;
    return configFromEnv();
  };
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  it('defaults to one trusted hop', () => { expect(withEnv(undefined).trustProxy).toBe(1); });
  it('reads 0 and false as "trust no proxy"', () => {
    expect(withEnv('0').trustProxy).toBe(0);
    expect(withEnv('false').trustProxy).toBe(0);
  });
  it('reads a hop count', () => { expect(withEnv('2').trustProxy).toBe(2); });
  it('passes an address/CIDR list through', () => {
    expect(withEnv('loopback, 10.0.0.0/8').trustProxy).toBe('loopback, 10.0.0.0/8');
  });
  it('refuses "true": trusting every hop is the spoofable behaviour this replaces', () => {
    expect(() => withEnv('true')).toThrow(/AGENFK_HUB_TRUST_PROXY/);
  });
  it('refuses an implausible hop count: trusting 99 hops is "true" by another name', () => {
    expect(() => withEnv('99')).toThrow(/AGENFK_HUB_TRUST_PROXY/);
    expect(withEnv('5').trustProxy).toBe(5);
  });
  it('refuses a list item that is not an address, CIDR or named range', () => {
    // Express would read "1,2" as the IPv4 addresses 0.0.0.1 and 0.0.0.2,
    // trust nothing, and put the whole org in one rate-limit bucket - silently.
    expect(() => withEnv('1,2')).toThrow(/AGENFK_HUB_TRUST_PROXY/);
    expect(() => withEnv('1.0')).toThrow(/AGENFK_HUB_TRUST_PROXY/);
    expect(() => withEnv('loopback, alb')).toThrow(/AGENFK_HUB_TRUST_PROXY/);
    expect(withEnv('uniquelocal, 10.0.0.0/8, fd00::/8').trustProxy).toBe('uniquelocal, 10.0.0.0/8, fd00::/8');
  });
});
