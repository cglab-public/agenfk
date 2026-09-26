/**
 * Query parameters that must be ONE value (CodeQL #107,
 * js/type-confusion-through-parameter-tampering).
 *
 * Express hands a repeated parameter over as an array. `from` and `to` were
 * cast to string and sliced, so `?from=a&from=b` sent an array into the SQL
 * bind - a 500 at best, and a bound the caller never meant at worst. A bound
 * that is not one value is refused, not guessed at: silently dropping it would
 * widen the window without saying so.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const DB = path.join(os.tmpdir(), `agenfk-hub-qparam-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };

describe('single-valued query parameters on the query endpoints', () => {
  let app: any; let ctx: any; let cookie: string;
  const get = (url: string) => supertest(app).get(url).set('Cookie', cookie);

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: DB, secretKey: 'a'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
  });
  afterEach(async () => { ctx.stopWorkers?.(); await drainApp(app); await ctx.db.close(); cleanup(); });

  it('answers a single from/to normally', async () => {
    const r = await get('/v1/users?from=2026-05-01&to=2026-05-31');
    expect(r.status).toBe(200);
  });

  for (const route of ['/v1/users', '/v1/timeline', '/v1/histogram']) {
    it(`refuses a repeated from on ${route} with a 400 naming the parameter`, async () => {
      const r = await get(`${route}?from=2026-05-01&from=2026-06-01`);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/\bfrom\b/);
    });
  }

  it('refuses a repeated to', async () => {
    const r = await get('/v1/users?to=2026-05-01&to=2026-06-01');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/\bto\b/);
  });

  it('refuses a nested object from (?from[a]=b)', async () => {
    const r = await get('/v1/users?from[a]=b');
    expect(r.status).toBe(400);
  });

  it('still refuses a repeated histogram bucket (a pin: the allow-list check already did)', async () => {
    const r = await get('/v1/histogram?bucket=day&bucket=hour');
    expect(r.status).toBe(400);
  });

  it('still accepts a repeated LIST filter: those are merged, not refused', async () => {
    const r = await get('/v1/users?users=a@x&users=b@x');
    expect(r.status).toBe(200);
  });
});
