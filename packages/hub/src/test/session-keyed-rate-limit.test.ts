/**
 * Dashboard and admin rate limits are per signed-in user, not per IP.
 *
 * The hub is reached over the corporate network through an internal ALB, so
 * everyone behind one NAT or VPN egress arrives from the same address. Keyed
 * by IP, the 300/min budget of /v1 (queries) and /v1/admin was shared by the
 * whole office, and each dashboard page fires several queries. Both routers
 * require a session, so the bucket is the VERIFIED session's user. A cookie
 * that does not verify falls back to the IP bucket: a forged value cannot buy
 * a fresh budget.
 *
 * The first refusal in each bucket's window is logged (route, limit, what the
 * bucket is keyed by) - the ALB keeps no access logs, so without it a 429 is
 * invisible to the operator.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';
import jwt from 'jsonwebtoken';

const DB = path.join(os.tmpdir(), `agenfk-hub-sessionlimit-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };
const OFFICE = '203.0.113.77';
const BUDGET = 300;

describe('session-keyed limits on /v1 and /v1/admin', () => {
  let app: any; let ctx: any; let server: import('http').Server;
  let adminA: string; let adminB: string;
  const agent = () => supertest(server);
  const login = async (email: string) =>
    (await agent().post('/auth/login').set('X-Forwarded-For', OFFICE).send({ email, password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
  const get = (url: string, cookie: string) => agent().get(url).set('X-Forwarded-For', OFFICE).set('Cookie', cookie);
  const spend = async (url: string, cookie: string) => {
    for (let i = 0; i < BUDGET; i++) {
      const r = await get(url, cookie);
      expect(r.status, `request ${i + 1} was limited early`).not.toBe(429);
    }
  };

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: DB, secretKey: 'a'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    server = app.listen(0);
    await createPasswordUser(ctx.db, 'org', 'a@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org', 'b@x', 'longenough1', 'admin');
    adminA = await login('a@x');
    adminB = await login('b@x');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await drainApp(server); await new Promise<void>(r => server.close(() => r()));
    ctx.stopWorkers?.(); await ctx.db.close(); cleanup();
  });

  it('gives two users behind one office address separate query budgets', async () => {
    await spend('/v1/event-types', adminA);
    expect((await get('/v1/event-types', adminA)).status).toBe(429);
    expect((await get('/v1/event-types', adminB)).status).toBe(200);
  });

  it('gives two admins behind one office address separate admin budgets', async () => {
    await spend('/v1/admin/auth-config', adminA);
    expect((await get('/v1/admin/auth-config', adminA)).status).toBe(429);
    expect((await get('/v1/admin/auth-config', adminB)).status).toBe(200);
  });

  it('charges a cookie that does not verify to the IP bucket: forging one buys no budget', async () => {
    for (let i = 0; i < BUDGET; i++) {
      const r = await get('/v1/event-types', `agenfk_hub_session=forged-${i}`);
      expect(r.status, `request ${i + 1}`).toBe(401);
    }
    expect((await get('/v1/event-types', 'agenfk_hub_session=forged-final')).status).toBe(429);
  });

  it('charges an expired but correctly signed session to the IP bucket', async () => {
    const expired = jwt.sign({ userId: 'u-old', orgId: 'org', role: 'admin' }, 'sess', { algorithm: 'HS256', expiresIn: -1 });
    for (let i = 0; i < BUDGET; i++) await get('/v1/event-types', `agenfk_hub_session=${expired}`);
    // The office IP bucket is spent; a different forged value from it is refused too.
    expect((await get('/v1/event-types', 'agenfk_hub_session=other')).status).toBe(429);
  });

  it('keys /auth/me by the verified user too: forged cookies share the IP bucket instead of minting one each', async () => {
    // Keyed on the raw cookie string, every forged value was a new bucket kept
    // for the window - unbounded memory growth, and never a refusal.
    for (let i = 0; i < BUDGET; i++) {
      const r = await get('/auth/me', `agenfk_hub_session=forged-me-${i}`);
      expect(r.status, `request ${i + 1}`).toBe(401);
    }
    expect((await get('/auth/me', 'agenfk_hub_session=forged-me-final')).status).toBe(429);
    // A real session from the same office is unaffected.
    expect((await get('/auth/me', adminA)).status).toBe(200);
  });

  it('logs the first refusal in a bucket once per window, without the address or the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await spend('/v1/event-types', adminA);
    await get('/v1/event-types', adminA);
    await get('/v1/event-types', adminA);
    const lines = warn.mock.calls.map(c => c.join(' ')).filter(l => l.includes('[RATE_LIMIT]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\/v1\/event-types/);
    expect(lines[0]).toMatch(/300/);
    expect(lines[0]).toMatch(/user/);
    expect(lines[0]).not.toContain(OFFICE);
    expect(lines[0]).not.toContain(adminA.split(';')[0].split('=')[1]);
  });
});
