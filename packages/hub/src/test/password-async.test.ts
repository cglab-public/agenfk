/**
 * Security audit, Fix 4 (AEF-5): bcrypt must not run on the request thread.
 *
 * verifyPassword used bcrypt.compareSync at cost 11 (~105 ms). Every login
 * attempt against an existing email - failed ones included, the hash runs
 * before the 401 is decided - froze the whole hub for that long, so 30
 * concurrent bad logins from one IP took a trivial endpoint from ~1 ms to
 * ~400 ms: an unauthenticated DoS that the per-account lockout does not touch
 * (the loop time is already spent when the 429 is decided).
 *
 * The audit proposed bcrypt.hash/compare from bcryptjs. Measured here, that
 * does not fix it: bcryptjs only yields once per MAX_EXECUTION_TIME (100 ms) of
 * CPU, about one whole cost-11 hash, so six concurrent compares starved the
 * event loop for ~600 ms. The work therefore runs on a small worker_threads
 * pool (auth/bcryptPool.ts) that still uses bcryptjs, so hashes keep their
 * format and existing passwords keep working.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import bcrypt from 'bcryptjs';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser, hashPassword, verifyPassword, getBcryptRounds } from '../auth/password';
import { shutdownBcryptPool } from '../auth/bcryptPool';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-password-async-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); };

let server: any = null;
let ctx: any = null;

async function boot() {
  const out = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' } as any);
  server = out.app.listen(0);
  ctx = out.ctx;
}
const login = (email: string, password: string) => supertest(server).post('/auth/login').send({ email, password });
const port = (): number => (server.address() as { port: number }).port;

beforeEach(async () => {
  cleanup();
  await boot();
});
afterEach(async () => {
  if (server) await drainApp(server);
  if (ctx) await ctx.db.close();
  server = null; ctx = null;
  cleanup();
});
afterAll(async () => { await shutdownBcryptPool(); });

describe('hashPassword / verifyPassword are asynchronous', () => {
  it('both return promises, so a caller cannot block on them', async () => {
    const h = hashPassword('longenough1');
    expect(typeof (h as any).then).toBe('function');
    const hash = await h;
    const v = verifyPassword('longenough1', hash);
    expect(typeof (v as any).then).toBe('function');
    expect(await v).toBe(true);
  });

  it('keep the hash format: bcryptjs reads what they write, and they read what bcryptjs writes', async () => {
    const hash = await hashPassword('longenough1');
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(Number.parseInt(hash.split('$')[2], 10)).toBe(getBcryptRounds());
    expect(bcrypt.compareSync('longenough1', hash)).toBe(true);
    // A password hashed before this change (synchronously, by bcryptjs) still signs in.
    const legacy = bcrypt.hashSync('legacy-password-1', 4);
    expect(await verifyPassword('legacy-password-1', legacy)).toBe(true);
    expect(await verifyPassword('wrong', legacy)).toBe(false);
  });

  it('answer false, not an error, for a hash that is not a bcrypt hash', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });
});

describe('POST /auth/login behaves as before', () => {
  beforeEach(async () => { await createPasswordUser(ctx.db, 'org', 'user@x', 'correct-horse-1', 'viewer'); });

  it('correct password signs in and sets the session cookie', async () => {
    const r = await login('user@x', 'correct-horse-1');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ email: 'user@x', role: 'viewer' });
    expect(r.headers['set-cookie']?.[0]).toBeTruthy();
  });

  it('wrong password is 401 Invalid credentials with no cookie; so is an unknown email', async () => {
    const wrong = await login('user@x', 'wrong-password-1');
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('Invalid credentials');
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect((await login('nobody@x', 'whatever-1')).status).toBe(401);
  });

  it('still records failures: the fifth bad attempt locks the account, even against the right password', async () => {
    for (let i = 0; i < 5; i++) expect((await login('user@x', `wrong-${i}-password`)).status).toBe(401);
    const locked = await login('user@x', 'correct-horse-1');
    expect(locked.status).toBe(429);
    expect(locked.body.error).toMatch(/locked/i);
  });

  it('a successful sign-in clears earlier failures', async () => {
    for (let i = 0; i < 3; i++) await login('user@x', `wrong-${i}-password`);
    expect((await login('user@x', 'correct-horse-1')).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login('user@x', `again-${i}-password`)).status).toBe(401);
    expect((await login('user@x', 'correct-horse-1')).status).toBe(200);
  });
});

describe('every password write goes through the async hash', () => {
  it('a password set by an admin (PUT /users/:id) and by invite both verify afterwards', async () => {
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'admin-password-1', 'admin');
    const cookie = (await login('admin@x', 'admin-password-1')).headers['set-cookie'][0];
    const invite = await supertest(server).post('/v1/admin/users/invite').set('Cookie', cookie)
      .send({ email: 'invited@x', password: 'invited-password-1', role: 'viewer' });
    expect(invite.status, JSON.stringify(invite.body)).toBeLessThan(300);
    expect((await login('invited@x', 'invited-password-1')).status).toBe(200);

    const id = (await ctx.db.get('SELECT id FROM users WHERE email = ?', ['invited@x'])).id;
    const put = await supertest(server).put(`/v1/admin/users/${id}`).set('Cookie', cookie).send({ password: 'changed-password-1' });
    expect(put.status).toBe(200);
    expect((await login('invited@x', 'changed-password-1')).status).toBe(200);
    expect((await login('invited@x', 'invited-password-1')).status).toBe(401);
  });
});

describe('POST /v1/admin/users/invite tells a busy hash pool from a duplicate email', () => {
  const invite = (cookie: string, email: string, password?: string) =>
    supertest(server).post('/v1/admin/users/invite').set('Cookie', cookie)
      .send(password === undefined ? { email, role: 'viewer' } : { email, password, role: 'viewer' });

  it('a saturated pool answers 429, not a false "A user with that email already exists"', async () => {
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'admin-password-1', 'admin');
    const cookie = (await login('admin@x', 'admin-password-1')).headers['set-cookie'][0];
    const pool = await import('../auth/bcryptPool');
    const busy = vi.spyOn(pool, 'bcryptHash').mockRejectedValueOnce(Object.assign(new Error('Too many sign-in attempts are being checked right now; try again shortly.'), { status: 429 }));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await invite(cookie, 'new@x', 'invited-password-1');
      expect(r.status, JSON.stringify(r.body)).toBe(429);
      expect(JSON.stringify(r.body)).not.toMatch(/already exists/);
    } finally { busy.mockRestore(); quiet.mockRestore(); }
    // Nothing was created, so the same invite goes through once the pool is free.
    expect((await invite(cookie, 'new@x', 'invited-password-1')).status).toBe(201);
  });

  it('a database failure on the insert is a 500, not a false "already exists"', async () => {
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'admin-password-1', 'admin');
    const cookie = (await login('admin@x', 'admin-password-1')).headers['set-cookie'][0];
    const realRun = ctx.db.run.bind(ctx.db);
    ctx.db.run = async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO users/.test(sql)) throw new Error('SQLITE_IOERR: disk I/O error');
      return realRun(sql, params);
    };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const body of [{ email: 'io@x', password: 'invited-password-1', role: 'viewer' }, { email: 'io2@x', role: 'viewer' }]) {
        const r = await supertest(server).post('/v1/admin/users/invite').set('Cookie', cookie).send(body);
        expect(r.status, JSON.stringify(r.body)).toBe(500);
        expect(JSON.stringify(r.body)).not.toMatch(/already exists/);
      }
    } finally { quiet.mockRestore(); ctx.db.run = realRun; }
  });

  it('a real duplicate is still 409, with or without a password', async () => {
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'admin-password-1', 'admin');
    const cookie = (await login('admin@x', 'admin-password-1')).headers['set-cookie'][0];
    expect((await invite(cookie, 'dup@x', 'invited-password-1')).status).toBe(201);
    expect((await invite(cookie, 'dup@x', 'invited-password-1')).status).toBe(409);
    expect((await invite(cookie, 'sso@x')).status).toBe(201);
    expect((await invite(cookie, 'sso@x')).status).toBe(409);
  });
});

describe('no hash is awaited inside a database transaction', () => {
  // SQLite's transaction() is a bare BEGIN ... COMMIT on the ONE shared
  // connection. While a hash is a worker round-trip, other requests run on that
  // connection inside the open BEGIN, and a ROLLBACK (a UNIQUE collision, a
  // saturated pool) would discard their writes with it. So the hash is computed
  // before the transaction opens, as it was when it was synchronous.
  it('/setup/initial-admin: the transaction body never yields to the event loop', async () => {
    const stored = await ctx.db.get('SELECT token FROM bootstrap_tokens LIMIT 1');
    expect(stored?.token, 'a fresh hub mints a bootstrap token').toBeTruthy();

    const original = ctx.db.transaction.bind(ctx.db);
    let yielded = false;
    ctx.db.transaction = (fn: () => Promise<unknown>) => original(async () => {
      // A macrotask cannot run while the body only awaits already-resolved DB
      // calls; it can once the body awaits a worker thread.
      const t = setImmediate(() => { yielded = true; });
      try { return await fn(); } finally { clearImmediate(t); }
    });

    const r = await supertest(server).post('/setup/initial-admin').send({ token: stored.token, email: 'first@x', password: 'first-admin-pw-1' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(yielded).toBe(false);
    expect((await login('first@x', 'first-admin-pw-1')).status).toBe(200);
  });
});

describe('the event loop stays available while passwords are being checked', () => {
  const REAL_COST = '11';
  let savedRounds: string | undefined;
  beforeEach(() => { savedRounds = process.env.AGENFK_HUB_BCRYPT_ROUNDS; process.env.AGENFK_HUB_BCRYPT_ROUNDS = REAL_COST; });
  afterEach(() => {
    if (savedRounds === undefined) delete process.env.AGENFK_HUB_BCRYPT_ROUNDS; else process.env.AGENFK_HUB_BCRYPT_ROUNDS = savedRounds;
  });

  it('p95 latency of a trivial route stays under 50 ms during 6 concurrent failed logins at production cost', async () => {
    await createPasswordUser(ctx.db, 'org', 'victim@x', 'correct-horse-1', 'viewer');
    expect(Number.parseInt((await ctx.db.get('SELECT password_hash FROM users WHERE email = ?', ['victim@x'])).password_hash.split('$')[2], 10)).toBe(11);

    const url = `http://127.0.0.1:${port()}/auth/providers`;
    await fetch(url);   // warm the route and the connection path

    const samples: number[] = [];
    let running = true;
    const poller = (async () => {
      while (running) {
        const t = process.hrtime.bigint();
        const r = await fetch(url);
        await r.arrayBuffer();
        samples.push(Number(process.hrtime.bigint() - t) / 1e6);
        await new Promise(res => setTimeout(res, 5));
      }
    })();

    // Same email, all started before any failure is recorded, so every one of
    // them reaches the hash (the lockout only refuses once failures are counted).
    const attempts = await Promise.all(Array.from({ length: 6 }, (_, i) => login('victim@x', `wrong-${i}-password`)));
    running = false;
    await poller;

    // The latency is the assertion this test exists for, so it comes first: the
    // old behaviours fail it (a starved poller records few, slow samples) rather
    // than tripping a side condition.
    samples.sort((a, b) => a - b);
    const p95 = samples.length ? samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] : Infinity;
    // With the synchronous compare this was ~400 ms (every sample queued behind
    // the hashes); with bcryptjs's own async API ~600 ms (see the file header).
    expect(p95, `p95 ${p95.toFixed(1)} ms over ${samples.length} samples (max ${samples.length ? samples[samples.length - 1].toFixed(1) : 'n/a'} ms)`).toBeLessThan(50);
    // And the measurement means something: the hashing alone takes several hundred ms.
    expect(samples.length).toBeGreaterThan(20);
    expect(attempts.map(a => a.status)).toEqual([401, 401, 401, 401, 401, 401]);
  }, 60_000);
});

describe('the worker pool is bounded', () => {
  it('refuses work with a 429-status error once its queue is full, and finishes what it accepted', async () => {
    vi.resetModules();
    process.env.AGENFK_HUB_BCRYPT_WORKERS = '1';
    process.env.AGENFK_HUB_BCRYPT_QUEUE_MAX = '2';
    try {
      const pool = await import('../auth/bcryptPool');
      const hash = bcrypt.hashSync('pw-for-queue', 10);
      const results = await Promise.allSettled(Array.from({ length: 12 }, () => pool.bcryptCompare('pw-for-queue', hash)));
      const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
      const fulfilled = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<boolean>[];
      expect(rejected.length).toBeGreaterThan(0);
      expect(rejected.every(r => (r.reason as { status?: number }).status === 429)).toBe(true);
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(fulfilled.every(r => r.value === true)).toBe(true);
      await pool.shutdownBcryptPool();
    } finally {
      delete process.env.AGENFK_HUB_BCRYPT_WORKERS;
      delete process.env.AGENFK_HUB_BCRYPT_QUEUE_MAX;
    }
  }, 60_000);

  it('survives a worker that dies: the job it held is rejected and the next one still runs', async () => {
    vi.resetModules();
    process.env.AGENFK_HUB_BCRYPT_WORKERS = '1';
    try {
      const pool = await import('../auth/bcryptPool');
      const hash = bcrypt.hashSync('pw-for-crash', 4);
      expect(await pool.bcryptCompare('pw-for-crash', hash)).toBe(true);   // worker is up
      await expect(pool.__killWorkersForTest()).resolves.toBeUndefined();
      expect(await pool.bcryptCompare('pw-for-crash', hash)).toBe(true);   // replaced on demand
      await pool.shutdownBcryptPool();
    } finally {
      delete process.env.AGENFK_HUB_BCRYPT_WORKERS;
    }
  }, 60_000);
});
