// GET /v1/timeline reports how many events match, not just the page it
// returns, so the user page can say "Showing latest 200 of 1,059" and offer
// Load more (story f15fb3a6). In-memory sqlite, like the PR search route spec.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

const SECRET = 'a'.repeat(64);

const ev = (i: number, over: any = {}) => ({
  eventId: `e-${i}`,
  installationId: 'inst-1',
  orgId: 'org',
  occurredAt: new Date(Date.UTC(2026, 4, 1, 0, i)).toISOString(),
  actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
  type: 'item.created',
  projectId: 'p1',
  itemId: `i${i}`,
  payload: {},
  ...over,
});

describe('GET /v1/timeline — total', () => {
  let app: any;
  let db: HubDb;
  let cookie: string;

  beforeEach(async () => {
    db = await openSqliteDb(':memory:');
    const out = await createHubApp({ dbPath: ':memory:', secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org', db });
    app = out.app;
    await createPasswordUser(out.ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookie = login.headers['set-cookie']?.[0] ?? '';
    const token = await issueApiKey(out.ctx.db, 'org', 'test');
    const events = [
      ...Array.from({ length: 7 }, (_, i) => ev(i)),
      ...Array.from({ length: 3 }, (_, i) => ev(100 + i, { type: 'item.closed' })),
    ];
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });
  });

  afterEach(async () => { await drainApp(app); await db.close(); });

  it('counts every matching event, whatever the page size', async () => {
    const r = await supertest(app).get('/v1/timeline?limit=4').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.events).toHaveLength(4);
    expect(r.body.total).toBe(10);
  });

  it('counts under the same filters as the page', async () => {
    const r = await supertest(app).get('/v1/timeline?limit=2&types=item.closed').set('Cookie', cookie);
    expect(r.body.events).toHaveLength(2);
    expect(r.body.total).toBe(3);
  });

  it('pages with offset, newest first, without overlap', async () => {
    const a = await supertest(app).get('/v1/timeline?limit=6').set('Cookie', cookie);
    const b = await supertest(app).get('/v1/timeline?limit=6&offset=6').set('Cookie', cookie);
    const ids = [...a.body.events, ...b.body.events].map((e: any) => e.event_id);
    expect(new Set(ids).size).toBe(10);
    expect(b.body.total).toBe(10);
  });

  it('pages by cursor across tied timestamps without a skip or a repeat', async () => {
    const token = await issueApiKey(db, 'org', 'tie');
    const at = '2026-06-01T00:00:00.000Z';
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`)
      // Inserted out of id order, so storage order cannot stand in for the
      // event_id tie-break.
      .send({ events: [503, 500, 504, 501, 502].map(i => ev(i, { occurredAt: at })) });
    const seen: string[] = [];
    let before: string | undefined;
    let first: any;
    for (let guard = 0; guard < 10; guard++) {
      const q = before ? `?limit=3&before=${encodeURIComponent(before)}` : '?limit=3';
      const r = await supertest(app).get(`/v1/timeline${q}`).set('Cookie', cookie);
      first ??= r.body;
      seen.push(...r.body.events.map((e: any) => e.event_id));
      before = r.body.nextBefore;
      if (!before) break;
    }
    expect(seen).toHaveLength(15);
    expect(new Set(seen).size).toBe(15);
    expect(first.total).toBe(15);
  });

  it('does not repeat events when newer ones arrive between pages', async () => {
    const p1 = await supertest(app).get('/v1/timeline?limit=4').set('Cookie', cookie);
    const token = await issueApiKey(db, 'org', 'late');
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`)
      .send({ events: [ev(900, { occurredAt: '2027-01-01T00:00:00.000Z' }), ev(901, { occurredAt: '2027-01-02T00:00:00.000Z' })] });
    const p2 = await supertest(app).get(`/v1/timeline?limit=20&before=${encodeURIComponent(p1.body.nextBefore)}`).set('Cookie', cookie);
    const ids = [...p1.body.events, ...p2.body.events].map((e: any) => e.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(10);
    // A cursor page does not pay for the count again.
    expect(p2.body.total).toBeUndefined();
  });

  it('refuses a cursor it cannot read', async () => {
    const r = await supertest(app).get('/v1/timeline?before=nonsense').set('Cookie', cookie);
    expect(r.status).toBe(400);
  });
});
