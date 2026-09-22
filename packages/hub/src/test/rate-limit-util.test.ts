/**
 * The hub's rateLimit() middleware (CodeQL js/missing-rate-limiting, PR #194).
 *
 * The contract every hub router relies on: `max` requests per window per key,
 * then a 429 carrying a JSON `error` and a Retry-After header. Pinned here
 * because the implementation underneath moved onto express-rate-limit, and a
 * router-level limiter that silently stops limiting is invisible in every
 * route test that never sends enough requests to trip it.
 */
import { describe, it, expect } from 'vitest';
import express, { Request } from 'express';
import supertest from 'supertest';
import { rateLimit } from '../util/rateLimit';

function appWith(mw: express.RequestHandler) {
  const app = express();
  app.get('/x', mw, (req: Request, res) => res.json({ ok: true, info: (req as any).rateLimit ?? null }));
  return app;
}

describe('hub rateLimit()', () => {
  it('lets max requests through, then answers 429 with the JSON error and Retry-After', async () => {
    const app = appWith(rateLimit({ windowMs: 60_000, max: 2, message: 'slow down, test' }));
    expect((await supertest(app).get('/x')).status).toBe(200);
    expect((await supertest(app).get('/x')).status).toBe(200);
    const third = await supertest(app).get('/x');
    expect(third.status).toBe(429);
    expect(third.body).toEqual({ error: 'slow down, test' });
    const retry = Number(third.headers['retry-after']);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
  });

  it('keeps one bucket per key: a custom keyFn separates callers', async () => {
    const app = appWith(rateLimit({ windowMs: 60_000, max: 1, keyFn: (req) => String(req.headers['x-who']) }));
    expect((await supertest(app).get('/x').set('x-who', 'a')).status).toBe(200);
    expect((await supertest(app).get('/x').set('x-who', 'a')).status).toBe(429);
    expect((await supertest(app).get('/x').set('x-who', 'b')).status).toBe(200);
  });

  it('keys by the first X-Forwarded-For hop by default (the hub runs behind a proxy)', async () => {
    const app = appWith(rateLimit({ windowMs: 60_000, max: 1 }));
    expect((await supertest(app).get('/x').set('X-Forwarded-For', '203.0.113.7, 10.0.0.1')).status).toBe(200);
    expect((await supertest(app).get('/x').set('X-Forwarded-For', '203.0.113.7')).status).toBe(429);
    expect((await supertest(app).get('/x').set('X-Forwarded-For', '203.0.113.8')).status).toBe(200);
  });

  it('puts every address of one IPv6 /64 in the same bucket', async () => {
    // A v6 client picks a fresh address out of its /64 whenever it likes; keyed
    // by the exact address, each one gets a private budget and the limit is
    // decorative.
    const app = appWith(rateLimit({ windowMs: 60_000, max: 1 }));
    expect((await supertest(app).get('/x').set('X-Forwarded-For', '2001:db8:1:2::1')).status).toBe(200);
    expect((await supertest(app).get('/x').set('X-Forwarded-For', '2001:db8:1:2::ffff')).status).toBe(429);
    expect((await supertest(app).get('/x').set('X-Forwarded-For', '2001:db8:1:3::1')).status).toBe(200);
  });

  it('reports the budget to the handler on req.rateLimit', async () => {
    const app = appWith(rateLimit({ windowMs: 60_000, max: 5 }));
    const r = await supertest(app).get('/x');
    expect(r.body.info).toMatchObject({ limit: 5, remaining: 4 });
  });
});
