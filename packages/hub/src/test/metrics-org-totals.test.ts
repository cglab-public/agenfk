// BUG 72c309df: the Org tiles summed /v1/metrics' rollup series (from cut to
// its UTC day, closures distinct per day and then added up) while the
// per-person rows beside them count live events (the exact `from`, closures
// distinct over the window). /v1/metrics now also answers `totals`, from the
// same live events and the same rules as /v1/users, so the two agree.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

const SECRET = 'a'.repeat(64);
const API = 'git@github.com:acme/api.git';
const WEB = 'git@github.com:acme/web.git';
let n = 0;
const ev = (who: string, type: string, at: string, over: any = {}) => ({
  eventId: `e-${n++}`,
  installationId: `inst-${who}`,
  orgId: 'org',
  occurredAt: at,
  actor: { osUser: who, gitName: who, gitEmail: `${who}@acme.com` },
  type,
  projectId: 'p1',
  itemId: over.itemId ?? `i-${n}`,
  payload: over.payload ?? {},
  remoteUrl: over.remoteUrl ?? API,
});

/** The window every test asks for: from midday, not midnight. */
const FROM = '2026-05-01T12:00:00.000Z';

describe('GET /v1/metrics totals agree with the per-person rows', () => {
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
    const token = await issueApiKey(db, 'org', 't');
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events: [
      // Before FROM, on the window's first UTC day: outside the period.
      ev('bob', 'item.closed', '2026-05-01T08:00:00.000Z', { itemId: 'early' }),
      ev('bob', 'validate.passed', '2026-05-01T09:00:00.000Z'),
      // b1 is closed, reopened and closed again on the next day: one item.
      ev('bob', 'item.closed', '2026-05-01T15:00:00.000Z', { itemId: 'b1' }),
      ev('bob', 'item.closed', '2026-05-02T10:00:00.000Z', { itemId: 'b1' }),
      // Closed through the board.
      ev('bob', 'step.transitioned', '2026-05-02T11:00:00.000Z', { itemId: 'b2', payload: { toStatus: 'DONE' } }),
      ev('bob', 'validate.passed', '2026-05-02T12:00:00.000Z'),
      ev('bob', 'validate.failed', '2026-05-02T13:00:00.000Z'),
      ev('alice', 'pr.opened', '2026-05-03T10:00:00.000Z', { remoteUrl: WEB }),
      ev('alice', 'item.closed', '2026-05-03T11:00:00.000Z', { itemId: 'a1', remoteUrl: WEB }),
      ev('alice', 'item.created', '2026-05-03T12:00:00.000Z', { remoteUrl: WEB }),
    ] });
  });

  afterEach(async () => { await drainApp(app); await db.close(); });

  const get = async (path: string) => {
    const r = await supertest(app).get(path).set('Cookie', cookie);
    expect(r.status).toBe(200);
    return r.body;
  };

  it('counts an item closed on two days once, as the person row does', async () => {
    const m = await get(`/v1/metrics?from=${FROM}`);
    const rows = await get(`/v1/users?from=${FROM}`);
    const bob = rows.find((u: any) => u.user_key === 'bob@acme.com');
    expect(bob.items_closed).toBe(2);
    // b1, b2 and a1.
    expect(m.totals.items_closed).toBe(3);
  });

  it('starts at the exact from, not at the start of its UTC day', async () => {
    const m = await get(`/v1/metrics?from=${FROM}`);
    // 'early' and the 09:00 check are before FROM.
    expect(m.totals).toMatchObject({ events_count: 8, validate_passes: 1, validate_fails: 1, prs_opened: 1 });
  });

  // Without a type filter, and with no item closed by two people: the Org
  // page's Users list follows its event-type filter on purpose (the tiles say
  // they do not), and a shared item is one item to the org but one per person.
  it('equals the person rows added up, without a type filter or a shared item', async () => {
    const m = await get(`/v1/metrics?from=${FROM}`);
    const rows = await get(`/v1/users?from=${FROM}`);
    const sum = (k: string) => rows.reduce((a: number, u: any) => a + u[k], 0);
    expect(m.totals).toEqual({
      events_count: sum('events_count'),
      items_closed: sum('items_closed'),
      validate_passes: sum('validate_passes'),
      validate_fails: sum('validate_fails'),
      prs_opened: sum('prs_opened'),
    });
  });

  it('counts an item two people closed once, while each of their rows counts it', async () => {
    const token = await issueApiKey(db, 'org', 't2');
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events: [
      ev('alice', 'item.closed', '2026-05-04T10:00:00.000Z', { itemId: 'b1' }),
    ] });
    const m = await get(`/v1/metrics?from=${FROM}`);
    const rows = await get(`/v1/users?from=${FROM}`);
    expect(m.totals.items_closed).toBe(3);
    expect(rows.reduce((a: number, u: any) => a + u.items_closed, 0)).toBe(4);
  });

  it('follows the same filters as the series', async () => {
    const byProject = await get(`/v1/metrics?from=${FROM}&projects=${encodeURIComponent(WEB)}`);
    expect(byProject.totals).toEqual({ events_count: 3, items_closed: 1, validate_passes: 0, validate_fails: 0, prs_opened: 1 });
    const byUser = await get(`/v1/metrics?from=${FROM}&users=bob@acme.com`);
    expect(byUser.totals).toMatchObject({ events_count: 5, items_closed: 2 });
    const until = await get(`/v1/metrics?from=${FROM}&to=2026-05-01T23:59:59.999Z`);
    expect(until.totals).toMatchObject({ events_count: 1, items_closed: 1 });
  });

  it('is all zeros for an empty period, and the series is still there', async () => {
    const m = await get('/v1/metrics?from=2027-01-01T00:00:00.000Z');
    expect(m.totals).toEqual({ events_count: 0, items_closed: 0, validate_passes: 0, validate_fails: 0, prs_opened: 0 });
    expect(m).toMatchObject({ bucket: 'day', series: [] });
  });
});
