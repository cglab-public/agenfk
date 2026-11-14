// BUG ba7880e0: the hub's day and hour keys must be UTC whatever TimeZone the
// Postgres session runs in. pg-mem has no session zone, so this needs a REAL
// server: set AGENFK_TEST_PG_URL to a DISPOSABLE database whose name contains
// 'test' (the hub schema is bootstrapped into it and its events and rollups
// tables are emptied; any other name is refused). Skipped without it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openPgDb } from '../db/postgres';
import { recomputeRollups } from '../rollup';
import type { HubDb } from '../db/types';

const PG_URL = process.env.AGENFK_TEST_PG_URL;

/** The same database, with the session pinned to a zone west of UTC. */
function inZone(url: string, zone: string): string {
  const u = new URL(url);
  // Every events row is deleted below: never on a database that holds history.
  if (!/(^|[_-])test([_-]|$)/i.test(u.pathname.slice(1))) {
    throw new Error(`AGENFK_TEST_PG_URL must name a disposable *test* database, got '${u.pathname.slice(1)}'`);
  }
  u.searchParams.set('options', `-c TimeZone=${zone}`);
  return u.toString();
}

describe.skipIf(!PG_URL)('day and hour keys on a Postgres session that is not UTC', () => {
  let db: HubDb | undefined;

  /** The open database; only reached after beforeEach opened it. */
  const pg = () => db!;

  /** The hour key of the one event, shifted by `modifier` when given. */
  const hourKey = async (modifier?: string) => (await pg().get<{ hr: string }>(
    `SELECT strftime('%Y-%m-%dT%H:00', occurred_at${modifier ? ', ?' : ''}) AS hr FROM events`,
    modifier ? [modifier] : [],
  ))?.hr;

  beforeEach(async () => {
    // 01:30Z on Oct 1 is 22:30 on Sep 30 in São Paulo.
    db = await openPgDb(inZone(PG_URL!, 'America/Sao_Paulo'));
    await db.exec('DELETE FROM events; DELETE FROM rollups_daily');
    await db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
       VALUES (?, 'org', 'inst', 'alice', ?, ?, 'item.closed', '{}')`,
      ['e1', '2026-10-01T01:30:00.000Z', '2026-10-01T01:30:00.000Z'],
    );
  });

  afterEach(async () => {
    if (!db) return;
    await db.exec('DELETE FROM events; DELETE FROM rollups_daily');
    await db.close();
    db = undefined;
  });

  it('runs in the zone it was asked for, so the test can fail', async () => {
    const row = await pg().get<{ tz: string }>("SELECT current_setting('TimeZone') AS tz");
    expect(row?.tz).toBe('America/Sao_Paulo');
  });

  it('keys the day by its UTC date', async () => {
    const row = await pg().get<{ day: string }>('SELECT date(occurred_at) AS day FROM events');
    expect(row?.day).toBe('2026-10-01');
  });

  it('keys the hour by its UTC hour', async () => {
    expect(await hourKey()).toBe('2026-10-01T01:00');
  });

  it('shifts by the requested offset from UTC, not from the session zone', async () => {
    expect(await hourKey('120 minutes')).toBe('2026-10-01T03:00');
  });

  it('shifts back across UTC midnight, and by part of an hour', async () => {
    expect(await hourKey('-120 minutes')).toBe('2026-09-30T23:00');
    expect(await hourKey('45 minutes')).toBe('2026-10-01T02:00');
  });

  it('rolls the event up onto its UTC day', async () => {
    await recomputeRollups(pg(), { full: true });
    const rows = await pg().all<{ day: string }>('SELECT day FROM rollups_daily');
    expect(rows.map(r => r.day)).toEqual(['2026-10-01']);
  });
});
