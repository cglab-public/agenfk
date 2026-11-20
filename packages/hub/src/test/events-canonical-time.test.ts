// GH-391 (BUG 4f507284): the hub stored an event's occurredAt exactly as sent.
//
// SQLite keeps events.occurred_at as TEXT, so every window filter and ORDER BY
// compares strings; Postgres keeps TIMESTAMPTZ and compares instants. Two
// spellings of one instant ('...10:00:00Z' vs '...10:00:00.000Z'), or an offset
// timestamp ('09:30:00-03:00' is 12:30Z), then filter and sort differently on
// the two databases. The fix stores ONE form, `Date#toISOString()`, at ingest,
// refuses a timestamp that does not parse, and rewrites the rows already stored.
//
// The machine running this suite need not be on UTC: a timestamp with no offset
// is read as UTC (as SQLite's date() and the rollups' utcDayOf read it), never
// as the host's local time, and the expectations below only hold if it is.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { issueApiKey } from '../auth/apiKey';
import { createPasswordUser } from '../auth/password';
import { canonicalOccurredAt } from '../util/occurredAt';
import { canonicaliseEventTimes, CANONICAL_EVENT_TIMES_MIGRATION, CANONICAL_EVENT_TIMES_PENDING_DAYS } from '../services/canonicaliseEventTimes';
import { recomputeRollups } from '../rollup';
import { OS_USER_KEY_MIGRATION } from '../services/migrateOsUserKeys';
import { drainApp } from './helpers/drainApp';

describe('canonicalOccurredAt', () => {
  it('turns an offset timestamp into the UTC instant it names', () => {
    expect(canonicalOccurredAt('2026-11-19T09:30:00-03:00')).toBe('2026-11-19T12:30:00.000Z');
    expect(canonicalOccurredAt('2026-11-19T23:30:00+0530')).toBe('2026-11-19T18:00:00.000Z');
  });

  it('gives one spelling to one instant, with or without milliseconds', () => {
    expect(canonicalOccurredAt('2026-11-19T10:00:00Z')).toBe('2026-11-19T10:00:00.000Z');
    expect(canonicalOccurredAt('2026-11-19T10:00:00.000Z')).toBe('2026-11-19T10:00:00.000Z');
    expect(canonicalOccurredAt('2026-11-19T10:00:00.5z')).toBe('2026-11-19T10:00:00.500Z');
  });

  it('reads a timestamp with no offset as UTC, not as the host clock\'s zone', () => {
    expect(canonicalOccurredAt('2026-11-19T10:00:00')).toBe('2026-11-19T10:00:00.000Z');
    expect(canonicalOccurredAt('2026-11-19 10:00:00')).toBe('2026-11-19T10:00:00.000Z');
    expect(canonicalOccurredAt('2026-11-19')).toBe('2026-11-19T00:00:00.000Z');
  });

  it('reads a lowercase separator as UTC too, whatever the host zone', () => {
    expect(canonicalOccurredAt('2026-11-19t10:00:00')).toBe('2026-11-19T10:00:00.000Z');
  });

  it('refuses a non-ISO string Date.parse would read in the host zone', () => {
    expect(canonicalOccurredAt('Thu, 19 Nov 2026 10:00:00')).toBeNull();
    expect(canonicalOccurredAt('11/19/2026 10:00')).toBeNull();
    expect(canonicalOccurredAt('2026-11-19T10:00:00Z ')).toBeNull();
  });

  it('refuses what does not parse, and a year text order cannot sort', () => {
    expect(canonicalOccurredAt('not a date')).toBeNull();
    expect(canonicalOccurredAt('')).toBeNull();
    expect(canonicalOccurredAt(undefined)).toBeNull();
    expect(canonicalOccurredAt(1763546400000)).toBeNull();
    // A six-digit year is a valid Date but its ISO string starts with '+', which
    // sorts before every four-digit year in a TEXT column.
    expect(canonicalOccurredAt('+010000-01-01T00:00:00Z')).toBeNull();
    // Postgres has no year 0: one such event would fail the whole batch's insert.
    expect(canonicalOccurredAt('0000-01-01T00:00:00Z')).toBeNull();
    expect(canonicalOccurredAt('0001-01-01T00:00:00Z')).toBe('0001-01-01T00:00:00.000Z');
    expect(canonicalOccurredAt('2026-13-45T10:00:00Z')).toBeNull();
    // Judged on the UTC year: an offset can carry an in-range year out of range.
    expect(canonicalOccurredAt('0001-01-01T00:00:00+01:00')).toBeNull();
    expect(canonicalOccurredAt('9999-12-31T23:00:00-02:00')).toBeNull();
    expect(canonicalOccurredAt('9999-12-31T23:00:00Z')).toBe('9999-12-31T23:00:00.000Z');
  });
});

const DB_PATH = path.join(os.tmpdir(), `agenfk-hub-canonical-time-${process.pid}.sqlite`);
const cleanup = () => {
  for (const s of ['', '-wal', '-shm']) { const f = DB_PATH + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
};

const sample = (over: Record<string, unknown> = {}) => ({
  eventId: 'e-' + Math.random().toString(36).slice(2),
  installationId: 'inst-1',
  orgId: 'org',
  occurredAt: '2026-11-19T10:00:00.000Z',
  actor: { osUser: 'alice', gitName: 'Alice', gitEmail: 'alice@example.com' },
  type: 'item.created',
  projectId: 'p1',
  itemId: 'i1',
  payload: { title: 'demo' },
  ...over,
});

describe('hub /v1/events stores one form of occurredAt (GH-391)', () => {
  let app: any; let ctx: any; let token: string; let cookie: string; let server: any;

  const post = (events: unknown[]) =>
    supertest(server).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });
  const stored = async (id: string) =>
    ctx.db.get<{ occurred_at: string; payload: string }>('SELECT occurred_at, payload FROM events WHERE event_id = ?', [id]);

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: DB_PATH, secretKey: '0'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    server = app.listen(0);
    token = await issueApiKey(ctx.db, 'org', 'test');
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(server).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => { ctx.stopWorkers?.(); await drainApp(server); await ctx.db.close(); cleanup(); });

  it('stores an offset timestamp as the UTC instant, in the column and in the stored event', async () => {
    const r = await post([sample({ eventId: 'off', occurredAt: '2026-11-19T09:30:00-03:00' })]);
    expect(r.body).toMatchObject({ ingested: 1, rejected: 0 });
    const row = await stored('off');
    expect(row!.occurred_at).toBe('2026-11-19T12:30:00.000Z');
    expect(JSON.parse(row!.payload).occurredAt).toBe('2026-11-19T12:30:00.000Z');
  });

  it('stores a timestamp without milliseconds or offset in the same form', async () => {
    await post([
      sample({ eventId: 'noms', occurredAt: '2026-11-19T10:00:00Z' }),
      sample({ eventId: 'nooff', occurredAt: '2026-11-19T11:00:00' }),
    ]);
    expect((await stored('noms'))!.occurred_at).toBe('2026-11-19T10:00:00.000Z');
    expect((await stored('nooff'))!.occurred_at).toBe('2026-11-19T11:00:00.000Z');
  });

  it('refuses an occurredAt that does not parse, as invalid, and keeps the rest of the batch', async () => {
    const r = await post([
      sample({ eventId: 'junk', occurredAt: 'yesterday-ish' }),
      sample({ eventId: 'far', occurredAt: '+010000-01-01T00:00:00Z' }),
      sample({ eventId: 'fine' }),
    ]);
    expect(r.body).toMatchObject({ ingested: 1, rejected: 2 });
    expect(r.body.rejections).toEqual([
      { eventId: 'junk', reason: 'invalid' },
      { eventId: 'far', reason: 'invalid' },
    ]);
    expect(await stored('junk')).toBeUndefined();
  });

  it('orders and windows the timeline by instant, whatever spelling each event was sent in', async () => {
    await post([
      // 12:30Z, sent with an offset: as text it sorts BEFORE 10:00Z.
      sample({ eventId: 'a-offset', occurredAt: '2026-11-19T09:30:00-03:00' }),
      sample({ eventId: 'b-ten', occurredAt: '2026-11-19T10:00:00Z' }),
      sample({ eventId: 'c-eleven', occurredAt: '2026-11-19T11:00:00.000Z' }),
    ]);
    const all = await supertest(server).get('/v1/timeline').set('Cookie', cookie);
    expect(all.body.events.map((e: any) => e.event_id)).toEqual(['a-offset', 'c-eleven', 'b-ten']);

    // A bound without milliseconds is the same instant as the stored 10:00:00.000Z.
    const from = await supertest(server)
      .get(`/v1/timeline?from=${encodeURIComponent('2026-11-19T10:00:00Z')}`).set('Cookie', cookie);
    expect(from.body.events.map((e: any) => e.event_id).sort()).toEqual(['a-offset', 'b-ten', 'c-eleven']);

    // An offset bound: 08:00-03:00 is 11:00Z, so 10:00Z falls outside it.
    const offFrom = await supertest(server)
      .get(`/v1/timeline?from=${encodeURIComponent('2026-11-19T08:00:00-03:00')}`).set('Cookie', cookie);
    expect(offFrom.body.events.map((e: any) => e.event_id).sort()).toEqual(['a-offset', 'c-eleven']);
  });
});

describe('canonicaliseEventTimes: the rows stored before GH-391', () => {
  let ctx: any; let app: any;

  const insertRaw = (id: string, occurredAt: string) =>
    ctx.db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
       VALUES (?, 'org', 'inst-1', 'alice@example.com', ?, '2026-11-19T13:00:00.000Z', 'item.created', ?)`,
      [id, occurredAt, JSON.stringify({ eventId: id, occurredAt, type: 'item.created' })],
    );
  const at = async (id: string) =>
    ctx.db.get<{ occurred_at: string; payload: string }>('SELECT occurred_at, payload FROM events WHERE event_id = ?', [id]);

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: DB_PATH, secretKey: '0'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    // Boot ran the migration on an empty table: forget it, so these rows are "historical".
    await vi.waitFor(async () => {
      expect(await ctx.db.get('SELECT 1 FROM system_state WHERE key = ?', [CANONICAL_EVENT_TIMES_MIGRATION])).toBeTruthy();
    });
    await ctx.db.run('DELETE FROM system_state WHERE key = ?', [CANONICAL_EVENT_TIMES_MIGRATION]);
  });

  afterEach(async () => { ctx.stopWorkers?.(); await drainApp(app); await ctx.db.close(); cleanup(); });

  it('rewrites parseable non-canonical rows, leaves unparseable and canonical rows alone, and says so', async () => {
    await insertRaw('offset', '2026-11-19T09:30:00-03:00');
    await insertRaw('noms', '2026-11-19T10:00:00Z');
    await insertRaw('nooff', '2026-11-19 11:00:00');
    await insertRaw('good', '2026-11-19T12:00:00.000Z');
    await insertRaw('junk', 'not-a-time');

    const r = await canonicaliseEventTimes(ctx.db);
    expect(r).toEqual({ skipped: false, eventsRewritten: 3, unparseable: 1, daysRecomputed: 1 });

    expect((await at('offset'))!.occurred_at).toBe('2026-11-19T12:30:00.000Z');
    expect(JSON.parse((await at('offset'))!.payload).occurredAt).toBe('2026-11-19T12:30:00.000Z');
    expect((await at('noms'))!.occurred_at).toBe('2026-11-19T10:00:00.000Z');
    expect((await at('nooff'))!.occurred_at).toBe('2026-11-19T11:00:00.000Z');
    expect((await at('good'))!.occurred_at).toBe('2026-11-19T12:00:00.000Z');
    // Never deleted: the usage overview already skips and counts these.
    expect((await at('junk'))!.occurred_at).toBe('not-a-time');
  });

  it('lets the event loop run between pages, so a long history does not hold requests at boot', async () => {
    for (let i = 0; i < 5; i++) await insertRaw(`p${i}`, '2026-11-19T10:00:00Z');
    const order: string[] = [];
    const done = canonicaliseEventTimes(ctx.db, { pageSize: 2 }).then(r => { order.push('done'); return r; });
    setImmediate(() => order.push('tick'));
    expect((await done).eventsRewritten).toBe(5);
    expect(order).toEqual(['tick', 'done']);
  });

  it('rebuilds the rollup days a rewrite moves rows out of and into, behind a newer rollup anchor', async () => {
    // SQLite 3.53 files 24:00 on the 19th and 3.54 on the 20th; the stored form is
    // the 20th either way. date() cannot read '+0530' at all, so that row was in no rollup.
    await insertRaw('midnight', '2026-11-19T24:00:00Z');
    await insertRaw('noncolon', '2026-11-19T23:30:00+0530');
    await insertRaw('anchor', '2026-11-25T10:00:00.000Z');
    await recomputeRollups(ctx.db, { full: true });
    const counts = async () => Object.fromEntries(
      (await ctx.db.all<{ day: string; events_count: number }>('SELECT day, events_count FROM rollups_daily ORDER BY day'))
        .map((r: any) => [r.day, Number(r.events_count)]),
    );
    const midnightDay = (await ctx.db.get<{ day: string }>("SELECT date('2026-11-19T24:00:00Z') AS day"))!.day;
    expect(await counts()).toEqual({ [midnightDay]: 1, '2026-11-25': 1 });

    const r = await canonicaliseEventTimes(ctx.db);
    expect(r).toMatchObject({ eventsRewritten: 2, daysRecomputed: 2 });
    // The 19th now holds the +0530 row (18:00Z) only; the midnight row moved to the 20th.
    expect(await counts()).toEqual({ '2026-11-19': 1, '2026-11-20': 1, '2026-11-25': 1 });
    expect((await at('noncolon'))!.occurred_at).toBe('2026-11-19T18:00:00.000Z');
    expect(await ctx.db.get('SELECT 1 FROM system_state WHERE key = ?', [CANONICAL_EVENT_TIMES_PENDING_DAYS])).toBeUndefined();
  });

  it('empties a rollup day the rewrite moved its only event out of', async () => {
    await insertRaw('moved', '2026-11-19T10:00:00.000Z');
    await insertRaw('anchor', '2026-11-25T10:00:00.000Z');
    await recomputeRollups(ctx.db, { full: true });
    const days = async () => (await ctx.db.all<{ day: string }>('SELECT day FROM rollups_daily ORDER BY day')).map((r: any) => r.day);
    expect(await days()).toEqual(['2026-11-19', '2026-11-25']);
    // The state a page leaves between its rewrite and its rebuild: the event is off the 19th,
    // whose bucket still counts it. No SQLite date() reading moves a row off a day on 3.54.
    await ctx.db.run("DELETE FROM events WHERE event_id = 'moved'");
    await ctx.db.run('INSERT INTO system_state (key, value) VALUES (?, ?)', [CANONICAL_EVENT_TIMES_PENDING_DAYS, JSON.stringify(['2026-11-19'])]);

    await canonicaliseEventTimes(ctx.db);
    // The recompute only upserts: without clearing the 19th, its stale bucket would stay forever.
    expect(await days()).toEqual(['2026-11-25']);
  });

  it('rebuilds the days a run cut short left pending, before anything else', async () => {
    await insertRaw('done-already', '2026-11-18T10:00:00.000Z');
    await recomputeRollups(ctx.db, { full: true });
    await ctx.db.run("UPDATE rollups_daily SET events_count = 99 WHERE day = '2026-11-18'");
    await ctx.db.run('INSERT INTO system_state (key, value) VALUES (?, ?)', [CANONICAL_EVENT_TIMES_PENDING_DAYS, JSON.stringify(['2026-11-18'])]);

    const r = await canonicaliseEventTimes(ctx.db);
    expect(r).toMatchObject({ eventsRewritten: 0, daysRecomputed: 1 });
    const row = await ctx.db.get<{ events_count: number }>("SELECT events_count FROM rollups_daily WHERE day = '2026-11-18'");
    expect(Number(row!.events_count)).toBe(1);
    expect(await ctx.db.get('SELECT 1 FROM system_state WHERE key = ?', [CANONICAL_EVENT_TIMES_PENDING_DAYS])).toBeUndefined();
  });

  it('runs once: a second call is skipped until forced', async () => {
    await canonicaliseEventTimes(ctx.db);
    await insertRaw('late', '2026-11-19T10:00:00Z');
    expect((await canonicaliseEventTimes(ctx.db)).skipped).toBe(true);
    expect((await at('late'))!.occurred_at).toBe('2026-11-19T10:00:00Z');
    expect((await canonicaliseEventTimes(ctx.db, { force: true })).eventsRewritten).toBe(1);
  });

  it('finishes at boot alongside the osUser-key migration, which also rebuilds rollups', async () => {
    // Both start at boot and both open per-day rollup transactions on the one
    // SQLite connection: run together, one BEGIN lands inside the other's.
    for (let d = 1; d <= 6; d++) {
      await ctx.db.run(
        `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
         VALUES (?, 'org', 'inst-1', 'bob', ?, '2026-11-19T13:00:00.000Z', 'item.created', '{}')`,
        [`bare-${d}`, `2026-11-0${d}T10:00:00Z`],
      );
    }
    await ctx.db.run('DELETE FROM system_state WHERE key = ?', [OS_USER_KEY_MIGRATION]);
    ctx.stopWorkers?.(); await drainApp(app); await ctx.db.close();

    const errors = vi.spyOn(console, 'error');
    try {
      const out = await createHubApp({ dbPath: DB_PATH, secretKey: '0'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' });
      app = out.app; ctx = out.ctx;
      await vi.waitFor(async () => {
        expect(await ctx.db.get('SELECT 1 FROM system_state WHERE key = ?', [CANONICAL_EVENT_TIMES_MIGRATION])).toBeTruthy();
        expect(await ctx.db.get('SELECT 1 FROM system_state WHERE key = ?', [OS_USER_KEY_MIGRATION])).toBeTruthy();
      });
      expect((await at('bare-3'))!.occurred_at).toBe('2026-11-03T10:00:00.000Z');
      expect(errors.mock.calls.filter(c => String(c[0]).includes('[MIGRATION]'))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('runs at boot, so an upgraded hub repairs its history without an operator', async () => {
    await insertRaw('old', '2026-11-19T09:30:00-03:00');
    ctx.stopWorkers?.(); await drainApp(app); await ctx.db.close();

    const out = await createHubApp({ dbPath: DB_PATH, secretKey: '0'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    await vi.waitFor(async () => {
      expect((await at('old'))!.occurred_at).toBe('2026-11-19T12:30:00.000Z');
    });
  });
});
