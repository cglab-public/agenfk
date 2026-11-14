// The activity histogram buckets by the viewer's time zone, by each date's own
// offset (BUG 27ede354). A single offset — today's — put a January range an
// hour off for a viewer in summer time.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { rebucketToZone, subHourShift, zoneOffsetMin } from '../queries/histogram-zone';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

describe('subHourShift', () => {
  it('is the part of the offset below a whole hour, as a positive number of minutes', () => {
    expect(subHourShift(120)).toBe(0);
    expect(subHourShift(330)).toBe(30);   // India
    expect(subHourShift(345)).toBe(45);   // Nepal
    expect(subHourShift(-210)).toBe(30);  // Newfoundland −3:30
    expect(subHourShift(-180)).toBe(0);
  });
});

describe('zoneOffsetMin', () => {
  it('reads the zone’s own offset at an instant, DST included', () => {
    expect(zoneOffsetMin('Europe/Berlin', Date.parse('2026-01-15T12:00:00Z'))).toBe(60);
    expect(zoneOffsetMin('Europe/Berlin', Date.parse('2026-07-15T12:00:00Z'))).toBe(120);
    expect(zoneOffsetMin('Asia/Kolkata', Date.parse('2026-07-15T12:00:00Z'))).toBe(330);
    expect(zoneOffsetMin('America/St_Johns', Date.parse('2026-01-15T12:00:00Z'))).toBe(-210);
    expect(zoneOffsetMin('UTC', Date.now())).toBe(0);
  });
});

describe('rebucketToZone', () => {
  it('files each UTC hour under its local day, by the date’s own offset', () => {
    // 23:00 UTC is 00:00 the next day in Berlin winter (UTC+1) and 01:00 in summer (UTC+2);
    // 22:00 UTC is 23:00 the same day in winter but 00:00 the next day in summer.
    const rows = [
      { time: '2026-01-12T22:00', type: 'item.closed', n: 1 },
      { time: '2026-01-12T23:00', type: 'item.closed', n: 2 },
      { time: '2026-07-12T22:00', type: 'item.closed', n: 4 },
    ];
    expect(rebucketToZone(rows, 'Europe/Berlin', 0, 'day')).toEqual([
      { time: '2026-01-12', type: 'item.closed', n: 1 },
      { time: '2026-01-13', type: 'item.closed', n: 2 },
      { time: '2026-07-13', type: 'item.closed', n: 4 },
    ]);
  });

  it('files hours under local hours, merging what lands together', () => {
    const rows = [
      { time: '2026-03-01T10:00', type: 'a', n: 1 },
      { time: '2026-03-01T10:00', type: 'b', n: '2' },
    ];
    expect(rebucketToZone(rows, 'Europe/Berlin', 0, 'hour')).toEqual([
      { time: '2026-03-01T11:00', type: 'a', n: 1 },
      { time: '2026-03-01T11:00', type: 'b', n: 2 },
    ]);
  });

  it('undoes the sub-hour shift the SQL applied, for a :30 zone', () => {
    // SQL shifted by +30 min so 04:30 UTC (10:00 IST) grouped as '05:00'.
    const rows = [{ time: '2026-03-01T05:00', type: 'a', n: 3 }];
    expect(rebucketToZone(rows, 'Asia/Kolkata', 30, 'hour')).toEqual([{ time: '2026-03-01T10:00', type: 'a', n: 3 }]);
  });

  it('sums counts that fall in one local day, and orders by time', () => {
    const rows = [
      { time: '2026-01-13T05:00', type: 'a', n: 1 },
      { time: '2026-01-12T23:00', type: 'a', n: 2 },
      { time: '2026-01-13T10:00', type: 'a', n: 3 },
    ];
    expect(rebucketToZone(rows, 'Europe/Berlin', 0, 'day')).toEqual([{ time: '2026-01-13', type: 'a', n: 6 }]);
  });
});

describe('GET /v1/histogram?tz=', () => {
  const SECRET = 'a'.repeat(64);
  let app: any; let db: HubDb; let cookie: string;
  const ev = (id: string, at: string) => ({
    eventId: id, installationId: 'i', orgId: 'org', occurredAt: at,
    actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' }, type: 'item.closed', projectId: 'p', itemId: id, payload: {},
  });
  beforeEach(async () => {
    db = await openSqliteDb(':memory:');
    const out = await createHubApp({ dbPath: ':memory:', secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org', db });
    app = out.app;
    await createPasswordUser(out.ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    const token = await issueApiKey(db, 'org', 't');
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events: [
      ev('w', '2026-01-12T22:30:00.000Z'), // 23:30 in Berlin, Jan 12
      ev('s', '2026-07-12T22:30:00.000Z'), // 00:30 in Berlin, Jul 13
      ev('k', '2026-03-01T18:40:00.000Z'), // 00:10 IST, Mar 2
    ] });
  });
  afterEach(async () => { await drainApp(app); await db.close(); });

  it('puts both sides of a DST change on their right local day', async () => {
    // The browser in summer sends +120; the zone still files January at +60.
    const r = await supertest(app).get('/v1/histogram?bucket=day&tz=Europe%2FBerlin&tzOffsetMin=120&from=2026-01-01T00:00:00Z').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.buckets.map((b: any) => b.time)).toEqual(['2026-01-12', '2026-03-01', '2026-07-13']);
  });

  it('takes a :30 zone’s alignment from the zone, whatever offset the client sent', async () => {
    for (const q of ['', '&tzOffsetMin=0', '&tzOffsetMin=garbage']) {
      const r = await supertest(app).get(`/v1/histogram?bucket=hour&tz=Asia%2FKolkata${q}&from=2026-03-01T00:00:00Z&to=2026-03-02T00:00:00Z`).set('Cookie', cookie);
      expect(r.status).toBe(200);
      expect(r.body.buckets.map((b: any) => b.time)).toEqual(['2026-03-02T00:00']);
    }
  });

  it('falls back to the offset for a zone it does not know', async () => {
    const r = await supertest(app).get('/v1/histogram?bucket=day&tz=Not%2FAZone&tzOffsetMin=120&from=2026-01-01T00:00:00Z').set('Cookie', cookie);
    // One offset for every date: 18:40 UTC at +120 is 20:40 on Mar 1.
    expect(r.body.buckets.map((b: any) => b.time)).toEqual(['2026-01-13', '2026-03-01', '2026-07-13']);
  });
});
