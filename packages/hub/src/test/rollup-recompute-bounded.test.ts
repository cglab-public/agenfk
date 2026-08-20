// Bounded historical recompute for rollups_daily (CGLAB-65).
//
// recomputeRollups anchors on MAX(day) FROM rollups_daily, which is right for
// the 5-minute timer — drift only happens in the active window — but means a
// historical day can never be repaired. A user_key merge rewrites events across
// the entire history, so without a bounded/full mode the dashboards stay wrong
// for every day before the anchor.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openSqliteDb } from '../db/sqlite';
import { recomputeRollups } from '../rollup';

const TEST_DB = path.join(os.tmpdir(), `agenfk-rollup-bounded-${process.pid}.sqlite`);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('recomputeRollups bounded modes', () => {
  let db: any;

  const addEvent = (id: string, userKey: string, day: string, type = 'item.created') =>
    db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
       VALUES (?, 'org-a', 'inst-1', ?, ?, ?, ?, '{}')`,
      [id, userKey, `${day}T09:00:00Z`, `${day}T09:00:00Z`, type],
    );

  /**
   * Plant a late rollup row. MAX(day) then anchors the default path there, so
   * any test asserting that history was repaired is genuinely discriminating
   * rather than riding on the fresh-DB case where the anchor is null.
   */
  const anchorAt = (day: string) =>
    db.run(
      `INSERT INTO rollups_daily (org_id, user_key, day, events_count) VALUES ('org-a', 'anchor@acme.com', ?, 0)`,
      [day],
    );

  const rollup = (userKey: string, day: string) =>
    db.get('SELECT events_count FROM rollups_daily WHERE org_id = ? AND user_key = ? AND day = ?', ['org-a', userKey, day]);

  beforeEach(async () => {
    cleanup();
    db = await openSqliteDb(TEST_DB);
    await db.run("INSERT INTO orgs (id, name) VALUES ('org-a', 'A')");
  });

  afterEach(async () => { await db.close(); cleanup(); });

  it('default mode still only rolls forward from the latest rolled-up day', async () => {
    await addEvent('e-old', 'dev@acme.com', '2026-01-10');
    await addEvent('e-new', 'dev@acme.com', '2026-03-20');
    await recomputeRollups(db);                     // seeds both days
    // Rewrite history behind the anchor, as a merge would.
    await db.run("UPDATE events SET user_key = 'moved@acme.com' WHERE event_id = 'e-old'");

    await recomputeRollups(db);

    // The stale January row survives — this is the documented limitation the
    // bounded mode exists to fix, and the reason a merge cannot rely on the
    // default path.
    expect(rollup('dev@acme.com', '2026-01-10')).toBeTruthy();
    expect(await rollup('moved@acme.com', '2026-01-10')).toBeFalsy();
  });

  it('since mode repairs a historical day behind the anchor', async () => {
    await addEvent('e-old', 'dev@acme.com', '2026-01-10');
    await addEvent('e-new', 'dev@acme.com', '2026-03-20');
    await recomputeRollups(db);
    await db.run("UPDATE events SET user_key = 'moved@acme.com' WHERE event_id = 'e-old'");

    const out = await recomputeRollups(db, { since: '2026-01-01' });

    expect(out.days).toBe(2); // both event-days were in range
    expect(Number((await rollup('moved@acme.com', '2026-01-10')).events_count)).toBe(1);
  });

  it('since mode ignores days before the boundary', async () => {
    await addEvent('e-jan', 'dev@acme.com', '2026-01-10');
    await addEvent('e-mar', 'dev@acme.com', '2026-03-20');
    await anchorAt('2026-03-20');

    const out = await recomputeRollups(db, { since: '2026-03-01' });

    expect(out.days).toBe(1);
    expect(await rollup('dev@acme.com', '2026-01-10')).toBeFalsy();
    expect(Number((await rollup('dev@acme.com', '2026-03-20')).events_count)).toBe(1);
  });

  it('full mode recomputes every day in history', async () => {
    await addEvent('e1', 'dev@acme.com', '2025-06-01');
    await addEvent('e2', 'dev@acme.com', '2026-01-10');
    await addEvent('e3', 'dev@acme.com', '2026-03-20');
    await anchorAt('2026-03-20'); // default path would start here and miss the rest

    const out = await recomputeRollups(db, { full: true });

    expect(out.days).toBe(3);
    expect(Number((await rollup('dev@acme.com', '2025-06-01')).events_count)).toBe(1);
  });

  it('full mode wins over since when both are given', async () => {
    await addEvent('e1', 'dev@acme.com', '2025-06-01');
    await addEvent('e2', 'dev@acme.com', '2026-03-20');
    await anchorAt('2026-03-20');

    const out = await recomputeRollups(db, { full: true, since: '2026-03-01' });

    expect(out.days).toBe(2);
  });

  it('is idempotent — recomputing the same range twice gives the same totals', async () => {
    await addEvent('e1', 'dev@acme.com', '2026-02-01');
    await addEvent('e2', 'dev@acme.com', '2026-02-01');
    await anchorAt('2026-02-01');

    await recomputeRollups(db, { full: true });
    const first = Number((await rollup('dev@acme.com', '2026-02-01')).events_count);
    await recomputeRollups(db, { full: true });

    expect(Number((await rollup('dev@acme.com', '2026-02-01')).events_count)).toBe(first);
    expect(first).toBe(2);
  });

  it('returns zero days when there are no events at all', async () => {
    expect((await recomputeRollups(db, { full: true })).days).toBe(0);
  });

  it('recomputes per user_key, so two people on one day stay separate', async () => {
    await anchorAt('2026-02-01');
    await addEvent('e1', 'a@acme.com', '2026-02-01');
    await addEvent('e2', 'b@acme.com', '2026-02-01');
    await addEvent('e3', 'b@acme.com', '2026-02-01');

    await recomputeRollups(db, { full: true });

    expect(Number((await rollup('a@acme.com', '2026-02-01')).events_count)).toBe(1);
    expect(Number((await rollup('b@acme.com', '2026-02-01')).events_count)).toBe(2);
  });
});
