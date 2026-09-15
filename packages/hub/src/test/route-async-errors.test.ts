// A DB error must FAIL the request, not hang it (BUG 5d98dd55).
//
// The hub runs express 4, which does not route a rejected promise to the error
// middleware. An `async (req, res) => { ... }` handler that throws therefore
// sends no response at all: the client waits for its own timeout, the dashboard
// spins forever, and nothing reaches the hub error log.
//
// Every test here forces the SAME failure — the database rejects — and asserts
// the endpoint answers 500. Note the short per-request deadline: without it a
// regression does not fail these tests, it HANGS them until the suite timeout,
// which is the very symptom being pinned.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const DB = path.join(os.tmpdir(), `agenfk-hub-asyncerr-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };

/** Long enough for a healthy answer, far short of the suite timeout. */
const DEADLINE_MS = 4000;

describe('a database error answers 500 instead of hanging the client', () => {
  let app: any; let ctx: any; let cookie: string;
  let real: { all: any; get: any; run: any };

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' }))
      .headers['set-cookie']?.[0] ?? '';
    real = { all: ctx.db.all, get: ctx.db.get, run: ctx.db.run };
  });

  afterEach(async () => {
    Object.assign(ctx.db, real);
    ctx.stopWorkers?.(); await drainApp(app); await ctx.db.close(); cleanup();
  });

  /** Every read and write from now on rejects, the way a broken query does. */
  const breakTheDatabase = () => {
    const boom = async () => { throw new Error('database is on fire'); };
    ctx.db.all = boom; ctx.db.get = boom; ctx.db.run = boom;
  };

  const QUERY_ENDPOINTS = [
    '/v1/users',
    '/v1/timeline',
    '/v1/metrics',
    '/v1/event-types',
    '/v1/projects',
    '/v1/item-types',
    '/v1/child-hubs',
    '/v1/histogram',
    '/v1/prs/overview',
  ];

  for (const url of QUERY_ENDPOINTS) {
    it(`GET ${url} answers 500`, async () => {
      breakTheDatabase();
      const r = await supertest(app).get(url).set('Cookie', cookie).timeout({ deadline: DEADLINE_MS });
      expect(r.status).toBe(500);
    });
  }

  // connect.ts: the same class, reported alongside. /invite/redeem was already
  // fixed under CGLAB-181; these three were not.
  const CONNECT_ENDPOINTS: Array<[string, Record<string, unknown>, boolean]> = [
    ['/hub/device/start', {}, false],
    ['/hub/device/poll', { deviceCode: 'whatever' }, false],
    ['/hub/device/approve', { userCode: 'ABCD-EFGH' }, true],
  ];

  for (const [url, body, needsAdmin] of CONNECT_ENDPOINTS) {
    it(`POST ${url} answers 500`, async () => {
      breakTheDatabase();
      const req = supertest(app).post(url).timeout({ deadline: DEADLINE_MS });
      if (needsAdmin) req.set('Cookie', cookie);
      const r = await req.send(body);
      expect(r.status).toBe(500);
    });
  }
});
