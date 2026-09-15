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
import { createHubApp, hubErrorHandler } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';
import { asyncRoute } from '../util/asyncRoute';

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

  // The card scoped the fix to the two routers above, but the same hole was
  // open in every other one — 60 more handlers in admin.ts, flows.ts, auth.ts,
  // events.ts and orgRename.ts. A sample from each, so the sweep is pinned by
  // behaviour rather than by a grep over the source.
  const SWEPT: Array<[string, string, Record<string, unknown> | null, boolean]> = [
    ['get', '/v1/admin/api-keys', null, true],
    ['get', '/v1/admin/installations', null, true],
    ['get', '/v1/admin/flows', null, true],
    ['put', '/v1/admin/auth-config', { passwordEnabled: true }, true],
    ['get', '/v1/admin/system/pending', null, true],
    ['get', '/auth/providers', null, false],
    ['post', '/auth/login', { email: 'admin@x', password: 'longenough1' }, false],
  ];

  for (const [verb, url, body, needsAdmin] of SWEPT) {
    it(`${verb.toUpperCase()} ${url} answers 500`, async () => {
      breakTheDatabase();
      const req = (supertest(app) as any)[verb](url).timeout({ deadline: DEADLINE_MS });
      if (needsAdmin) req.set('Cookie', cookie);
      const r = body ? await req.send(body) : await req;
      expect(r.status).toBe(500);
    });
  }

  // The SSO routers were not in the card's scope and the first sweep missed
  // them — an unauthenticated front door that hangs the browser on a DB blip is
  // the worst placement of this bug in the whole hub. Found by the adversarial
  // review of this card.
  const SSO_ENDPOINTS = [
    '/auth/google/start',
    '/auth/google/callback',
    '/auth/entra/start',
    '/auth/entra/callback',
  ];

  for (const url of SSO_ENDPOINTS) {
    it(`GET ${url} answers 500`, async () => {
      breakTheDatabase();
      const r = await supertest(app).get(url).timeout({ deadline: DEADLINE_MS });
      expect(r.status).toBe(500);
    });
  }

  // A key-guarded router needs a live key to reach the handler at all — and
  // requireKey does its OWN db.get, which already answers 500 when everything
  // is broken. Breaking only db.all therefore gets past the guard and fails
  // inside the handler, which is the code under test. Without this the test
  // passes against the unfixed router and pins nothing.
  it('GET /v1/flows/available answers 500', async () => {
    const key = await supertest(app).post('/v1/admin/api-keys').set('Cookie', cookie).send({ label: 'k' });
    expect(key.status).toBeLessThan(300);
    ctx.db.all = async () => { throw new Error('database is on fire'); };
    const r = await supertest(app).get('/v1/flows/available')
      .set('Authorization', `Bearer ${key.body.token}`)
      .timeout({ deadline: DEADLINE_MS });
    expect(r.status).toBe(500);
  });
});

// ── The wrapper itself, and what the error handler does with what it gets ────
//
// Three findings from the adversarial review of this card, each pinned here
// rather than left as a claim in a commit message.
describe('the wrapper hands express something express reads as an error', () => {
  const build = async (handler: (req: any, res: any) => Promise<unknown>) => {
    const express = (await import('express')).default;
    const app = express();
    app.get('/boom', asyncRoute(handler));
    // The same shape as the hub's own fallback: a request that falls THROUGH
    // the route answers 200 HTML, which is the failure this pins.
    app.use((_req: any, res: any) => res.status(200).send('<html>spa</html>'));
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(500).json({ error: err?.message ?? 'internal error' });
    });
    return app;
  };

  it('a rejection with undefined is an error, not "carry on"', async () => {
    // next(undefined) means "no error, continue" to express, so a handler that
    // rejects with a falsy value would fall through to the SPA fallback and
    // answer 200 HTML for an API path.
    const app = await build(async () => { throw undefined; });
    const r = await supertest(app).get('/boom').timeout({ deadline: DEADLINE_MS });
    expect(r.status).toBe(500);
  });

  it("a rejection with the string 'route' is an error, not a routing directive", async () => {
    // next('route') and next('router') are directives express acts on.
    const app = await build(async () => { throw 'route'; });
    const r = await supertest(app).get('/boom').timeout({ deadline: DEADLINE_MS });
    expect(r.status).toBe(500);
  });
});

describe('the hub error handler', () => {
  let app: any; let ctx: any; let cookie: string;
  const env = process.env.NODE_ENV;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' }))
      .headers['set-cookie']?.[0] ?? '';
  });
  afterEach(async () => {
    process.env.NODE_ENV = env;
    ctx.stopWorkers?.(); await drainApp(app); await ctx.db.close(); cleanup();
  });

  it('logs an error even when the response has already gone out', async () => {
    // The one case the client can never see. The headersSent guard used to
    // return BEFORE the log line, so exactly these errors vanished. Driven
    // against the real handler, because a route registered after createHubApp
    // lands behind the SPA fallback and never runs.
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { seen.push(a.map(String).join(' ')); });
    try {
      const res: any = { headersSent: true, status: () => { throw new Error('must not answer twice'); } };
      hubErrorHandler(new Error('thrown after the send'), {} as any, res, (() => {}) as any);
      expect(seen.some(l => l.includes('thrown after the send'))).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('does not echo a driver error message to an anonymous caller in production', async () => {
    process.env.NODE_ENV = 'production';
    ctx.db.get = async () => { throw new Error('relation "auth_config" does not exist'); };
    const r = await supertest(app).get('/auth/providers').timeout({ deadline: DEADLINE_MS });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('auth_config');
  });
});
