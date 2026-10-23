/** bcrypt must run on a worker pool, not the request thread (bcryptjs's own async API still starves the loop). */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { createRequire } from 'module';
import ts from 'typescript';
import bcrypt from 'bcryptjs';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser, hashPassword, verifyPassword, getBcryptRounds } from '../auth/password';
import * as livePool from '../auth/bcryptPool';
import { shutdownBcryptPool, __poolStatsForTest } from '../auth/bcryptPool';
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
  // SQLite's transaction() is a bare BEGIN on one shared connection: an await inside it lets other
  // requests write in the open transaction, and a ROLLBACK would discard those too.
  it('/setup/initial-admin: the transaction body never yields to the event loop', async () => {
    const stored = await ctx.db.get('SELECT token FROM bootstrap_tokens LIMIT 1');
    expect(stored?.token, 'a fresh hub mints a bootstrap token').toBeTruthy();

    const original = ctx.db.transaction.bind(ctx.db);
    let yielded = false;
    ctx.db.transaction = (fn: () => Promise<unknown>) => original(async () => {
      // A macrotask can only run if the body awaits a worker thread.
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
  const REAL_COST = '12';
  let savedRounds: string | undefined;
  beforeEach(() => { savedRounds = process.env.AGENFK_HUB_BCRYPT_ROUNDS; process.env.AGENFK_HUB_BCRYPT_ROUNDS = REAL_COST; });
  afterEach(() => {
    if (savedRounds === undefined) delete process.env.AGENFK_HUB_BCRYPT_ROUNDS; else process.env.AGENFK_HUB_BCRYPT_ROUNDS = savedRounds;
  });

  // Ordering, not a stopwatch: while the workers are busy with slow hashes an unrelated request must
  // finish first. On the request thread it cannot be answered until the hashing is done.
  it('an unrelated route answers before six failed logins at production cost have finished', async () => {
    await createPasswordUser(ctx.db, 'org', 'victim@x', 'correct-horse-1', 'viewer');
    expect(Number.parseInt((await ctx.db.get('SELECT password_hash FROM users WHERE email = ?', ['victim@x'])).password_hash.split('$')[2], 10)).toBe(12);

    const url = `http://127.0.0.1:${port()}/auth/providers`;
    await fetch(url);   // warm up

    // Same email, all started before any failure is counted, so every one reaches the hash.
    const attempts = Promise.all(Array.from({ length: 6 }, (_, i) => login('victim@x', `wrong-${i}-password`)));
    for (const deadline = Date.now() + 5_000; __poolStatsForTest().busy === 0 && Date.now() < deadline;) await new Promise(res => setTimeout(res, 5));
    expect(__poolStatsForTest().busy, 'the logins reached the worker pool').toBeGreaterThan(0);

    const first = await Promise.race([
      fetch(url).then(r => r.arrayBuffer()).then(() => 'route'),
      attempts.then(() => 'logins'),
    ]);
    expect(first).toBe('route');
    expect((await attempts).map(a => a.status)).toEqual([401, 401, 401, 401, 401, 401]);
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

  it('a worker killed while busy rejects the job it held, and queued work still finishes', async () => {
    vi.resetModules();
    process.env.AGENFK_HUB_BCRYPT_WORKERS = '1';
    try {
      const pool = await import('../auth/bcryptPool');
      const hash = bcrypt.hashSync('pw-for-busy-crash', 10);
      const outcome = (p: Promise<boolean>) => Promise.race([
        p.then(() => 'resolved', () => 'rejected'),
        new Promise<string>(res => setTimeout(() => res('never settled'), 10_000)),
      ]);
      const busyJob = outcome(pool.bcryptCompare('pw-for-busy-crash', hash));   // handed to the only worker
      const queued = [pool.bcryptCompare('pw-for-busy-crash', hash), pool.bcryptCompare('some-other-password', hash)];
      expect(pool.__poolStatsForTest()).toMatchObject({ busy: 1, queued: 2 });
      await pool.__killWorkersForTest();
      expect(await busyJob).toBe('rejected');
      expect(await Promise.all(queued)).toEqual([true, false]);
      await pool.shutdownBcryptPool();
    } finally {
      delete process.env.AGENFK_HUB_BCRYPT_WORKERS;
    }
  }, 60_000);
});

describe('a worker that cannot start', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('worker_threads');
    delete process.env.AGENFK_HUB_BCRYPT_WORKERS;
    delete process.env.AGENFK_HUB_BCRYPT_QUEUE_MAX;
  });

  it('answers a retryable 503 instead of hashing on the request thread, and starts workers again later', async () => {
    vi.resetModules();
    let failSpawns = true;
    vi.doMock('worker_threads', async () => {
      const actual = await vi.importActual<typeof import('worker_threads')>('worker_threads');
      class FlakyWorker extends actual.Worker {
        constructor(...args: ConstructorParameters<typeof actual.Worker>) {
          if (failSpawns) throw new Error('ERR_WORKER_INIT_FAILED');
          super(...args);
        }
      }
      return { ...actual, Worker: FlakyWorker };
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    process.env.AGENFK_HUB_BCRYPT_WORKERS = '1';
    process.env.AGENFK_HUB_BCRYPT_QUEUE_MAX = '2';
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const real = (await import('bcryptjs')).default;
      const onRequestThread = [vi.spyOn(real, 'compare'), vi.spyOn(real, 'hash')];
      const pool = await import('../auth/bcryptPool');
      const hash = bcrypt.hashSync('pw-for-spawn', 4);

      const during = await Promise.allSettled(Array.from({ length: 20 }, () => pool.bcryptCompare('pw-for-spawn', hash)));
      expect(during.every(r => r.status === 'rejected' && (r.reason as { status?: number }).status === 503), JSON.stringify(during.map(r => r.status))).toBe(true);
      expect(onRequestThread.every(spy => spy.mock.calls.length === 0), 'nothing was hashed on the request thread').toBe(true);

      failSpawns = false;
      vi.setSystemTime(Date.now() + 5 * 60_000);
      expect(await pool.bcryptCompare('pw-for-spawn', hash)).toBe(true);
      await pool.shutdownBcryptPool();
    } finally {
      quiet.mockRestore();
    }
  }, 60_000);

  it('POST /auth/login reports it as 503 with Retry-After, not a generic 500', async () => {
    await createPasswordUser(ctx.db, 'org', 'user@x', 'correct-horse-1', 'viewer');
    // The static import: earlier tests reset the module registry, and only this copy is the server's.
    const unavailable = vi.spyOn(livePool, 'bcryptCompare').mockRejectedValueOnce(new livePool.PoolUnavailableError());
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await login('user@x', 'correct-horse-1');
      expect(r.status, JSON.stringify(r.body)).toBe(503);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      expect(r.body.error).toMatch(/try again/i);
    } finally { unavailable.mockRestore(); quiet.mockRestore(); }
  });
});

describe('the worker pool does not keep the process alive', () => {
  it('a process that used the pool and never shut it down exits on its own', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-pool-unref-'));
    try {
      const src = fs.readFileSync(path.join(__dirname, '../auth/bcryptPool.ts'), 'utf8');
      const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
      fs.writeFileSync(path.join(dir, 'pool.cjs'), js);
      const hash = bcrypt.hashSync('pw-for-exit', 4);
      fs.writeFileSync(path.join(dir, 'main.cjs'),
        // The timer stands in for the HTTP server that keeps a real hub up until the answer is in.
        `const keepAlive = setInterval(() => {}, 1000);\n` +
        `require('./pool.cjs').bcryptCompare('pw-for-exit', ${JSON.stringify(hash)}).then(ok => { process.stdout.write(String(ok)); clearInterval(keepAlive); });\n`);
      const resolved = createRequire(__filename).resolve('bcryptjs');
      const nodeModules = resolved.slice(0, resolved.lastIndexOf('node_modules') + 'node_modules'.length);

      const run = await new Promise<{ hung: boolean; stdout: string }>(resolve => {
        execFile(process.execPath, [path.join(dir, 'main.cjs')], { env: { ...process.env, NODE_PATH: nodeModules }, timeout: 20_000 },
          (err, stdout) => resolve({ hung: !!(err as { killed?: boolean } | null)?.killed, stdout }));
      });
      expect(run.hung, 'the process was still running after its work finished: an idle worker keeps the event loop alive').toBe(false);
      expect(run.stdout.trim()).toBe('true');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
