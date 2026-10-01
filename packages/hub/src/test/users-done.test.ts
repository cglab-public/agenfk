// GET /v1/users reports what each listed person got done in the period,
// computed in the same request from the same events (story f355efe4): items
// closed, checks passed/failed, PRs opened and items closed per day. The list
// itself follows the Event type filter; these counts deliberately do not, so
// a person listed for one type still shows everything they closed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

const SECRET = 'a'.repeat(64);
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
  remoteUrl: over.remoteUrl,
});

describe('GET /v1/users — what each person got done', () => {
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
      ev('bob', 'item.closed', '2026-05-01T10:00:00.000Z', { itemId: 'b1' }),
      // Closed through the board: counts as a closed item too.
      ev('bob', 'step.transitioned', '2026-05-02T10:00:00.000Z', { itemId: 'b2', payload: { toStatus: 'DONE' } }),
      ev('bob', 'validate.passed', '2026-05-02T11:00:00.000Z'),
      ev('bob', 'validate.failed', '2026-05-02T12:00:00.000Z'),
      ev('bob', 'validate.failed', '2026-05-02T13:00:00.000Z'),
      ev('bob', 'pr.opened', '2026-05-02T14:00:00.000Z'),
      ev('bob', 'item.created', '2026-05-02T15:00:00.000Z'),
      ev('alice', 'item.created', '2026-05-03T10:00:00.000Z'),
      // Outside the window asked for below.
      ev('bob', 'item.closed', '2026-04-01T10:00:00.000Z', { itemId: 'b0' }),
    ] });
  });

  afterEach(async () => { await drainApp(app); await db.close(); });

  const users = async (q: string) => {
    const r = await supertest(app).get(`/v1/users?from=2026-04-15T00:00:00.000Z${q}`).set('Cookie', cookie);
    expect(r.status).toBe(200);
    return Object.fromEntries(r.body.map((u: any) => [u.user_key, u]));
  };

  it('counts closed items, checks and PRs per person, with closed items per day', async () => {
    const u = await users('');
    expect(u['bob@acme.com']).toMatchObject({
      events_count: 7, items_closed: 2, validate_passes: 1, validate_fails: 2, prs_opened: 1,
      closed_daily: { '2026-05-01': 1, '2026-05-02': 1 },
    });
    expect(u['alice@acme.com']).toMatchObject({ items_closed: 0, validate_passes: 0, validate_fails: 0, prs_opened: 0, closed_daily: {} });
  });

  it('keeps the counts whole under an event-type filter, while the list follows it', async () => {
    const u = await users('&types=item.closed');
    expect(Object.keys(u)).toEqual(['bob@acme.com']);
    // events_count is the matching events; the rest still count every type.
    expect(u['bob@acme.com']).toMatchObject({ events_count: 1, items_closed: 2, validate_fails: 2, prs_opened: 1 });
  });

  it('applies the other filters to the counts', async () => {
    const u = await users('&to=2026-05-01T23:59:59.999Z');
    expect(u['bob@acme.com']).toMatchObject({ items_closed: 1, validate_passes: 0, prs_opened: 0 });
  });

  it('files closures per day in the viewer zone when given one', async () => {
    const token = await issueApiKey(db, 'org', 'z');
    // 23:30 UTC on May 4 is 01:30 on May 5 in Berlin (CEST).
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events: [
      ev('carol', 'item.closed', '2026-05-04T23:30:00.000Z', { itemId: 'c1' }),
    ] });
    const utc = await users('');
    expect(utc['carol@acme.com'].closed_daily).toEqual({ '2026-05-04': 1 });
    const local = await users('&tz=Europe%2FBerlin');
    expect(local['carol@acme.com'].closed_daily).toEqual({ '2026-05-05': 1 });
    expect(local['carol@acme.com'].items_closed).toBe(1);
  });

  it('counts an item once per local day, even closed in two different hours', async () => {
    const token = await issueApiKey(db, 'org', 'twice');
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events: [
      ev('dan', 'item.closed', '2026-05-06T08:00:00.000Z', { itemId: 'd1' }),
      ev('dan', 'item.closed', '2026-05-06T12:00:00.000Z', { itemId: 'd1' }),
      ev('dan', 'item.closed', '2026-05-06T13:00:00.000Z', { itemId: 'd2' }),
    ] });
    for (const q of ['', '&tz=Europe%2FBerlin', '&tz=Asia%2FKolkata']) {
      const u = await users(q);
      expect(u['dan@acme.com'].closed_daily, q).toEqual({ '2026-05-06': 2 });
    }
  });
});
