// CGLAB-613 — the hub rolls flow adherence up from the stamped
// step.transitioned payloads CGLAB-612 emits.
//
// The JSON boolean is the trap. SQLite's json_extract returns 1/0 for a JSON
// true/false, while the Postgres translation (jsonb_extract_path_text, see
// db/dialect.ts) returns the TEXT 'true'/'false'. Comparing as text
// ('true'/'1') is the one spelling both backends agree on, and the pg-mem case
// below is what pins it — a SQLite-only test would pass with a predicate that
// is wrong on Postgres.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openSqliteDb } from '../db/sqlite';
import { openPgMemDb } from '../db/postgres';
import { recomputeRollups } from '../rollup';

const TEST_DB = path.join(os.tmpdir(), `agenfk-rollup-adherence-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = TEST_DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };

const EVENT_SQL = `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
  VALUES (?, 'org-a', 'inst-1', ?, ?, ?, ?, ?)`;

const envelope = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload });

describe('recomputeRollups counts flow adherence (SQLite)', () => {
  let db: any;
  beforeEach(async () => {
    cleanup();
    db = await openSqliteDb(TEST_DB);
    await db.run("INSERT INTO orgs (id, name) VALUES ('org-a', 'A')");
  });
  afterEach(async () => { await db.close(); cleanup(); });

  const transition = (id: string, day: string, payload: Record<string, unknown>, user = 'dev@acme.com') =>
    db.run(EVENT_SQL, [id, user, `${day}T09:00:00Z`, `${day}T09:00:00Z`, 'step.transitioned', envelope('step.transitioned', payload)]);

  const row = (day: string, user = 'dev@acme.com') =>
    db.get('SELECT transitions_judged, transitions_compliant FROM rollups_daily WHERE org_id = ? AND user_key = ? AND day = ?', ['org-a', user, day]);

  it('counts judged and compliant from the stamped payload, rollbacks included', async () => {
    await transition('e1', '2026-05-01', { fromStatus: 'PLAN', toStatus: 'WORK', flowId: 'f1', flowRevision: 1, compliant: true });
    // A ROLLBACK between two steps of the same revision: judged AND compliant.
    await transition('e2', '2026-05-01', { fromStatus: 'WORK', toStatus: 'PLAN', flowId: 'f1', flowRevision: 1, compliant: true });
    await transition('e3', '2026-05-01', { fromStatus: 'WORK', toStatus: 'PAUSED', flowId: 'f1', flowRevision: 1, compliant: false });
    await transition('e4', '2026-05-01', { fromStatus: 'TODO', toStatus: 'PLAN' }); // unstamped

    await recomputeRollups(db, { full: true });

    const r = await row('2026-05-01');
    expect(Number(r.transitions_judged)).toBe(3);
    expect(Number(r.transitions_compliant)).toBe(2);
  });

  it('does not judge an event with no flowRevision, even when it carries compliant:true', async () => {
    await transition('e1', '2026-05-02', { fromStatus: 'A', toStatus: 'B', compliant: true });
    await recomputeRollups(db, { full: true });
    const r = await row('2026-05-02');
    expect(Number(r.transitions_judged)).toBe(0);
    expect(Number(r.transitions_compliant)).toBe(0);
  });

  it('counts only step.transitioned, not another event that happens to carry the fields', async () => {
    await transition('e1', '2026-05-03', { fromStatus: 'A', toStatus: 'B', flowId: 'f1', flowRevision: 1, compliant: true });
    await db.run(EVENT_SQL, [
      'v1', 'dev@acme.com', '2026-05-03T10:00:00Z', '2026-05-03T10:00:00Z', 'validate.passed',
      envelope('validate.passed', { flowId: 'f1', flowRevision: 1, compliant: true }),
    ]);
    await recomputeRollups(db, { full: true });
    const r = await row('2026-05-03');
    expect(Number(r.transitions_judged)).toBe(1);
    expect(Number(r.transitions_compliant)).toBe(1);
  });

  it('is idempotent — recomputing twice gives the same counters', async () => {
    await transition('e1', '2026-05-04', { fromStatus: 'A', toStatus: 'B', flowId: 'f1', flowRevision: 2, compliant: true });
    await transition('e2', '2026-05-04', { fromStatus: 'B', toStatus: 'A', flowId: 'f1', flowRevision: 2, compliant: true });
    await recomputeRollups(db, { full: true });
    const first = await row('2026-05-04');
    await recomputeRollups(db, { full: true });
    const second = await row('2026-05-04');
    expect(Number(second.transitions_judged)).toBe(Number(first.transitions_judged));
    expect(Number(second.transitions_compliant)).toBe(Number(first.transitions_compliant));
    expect(Number(second.transitions_judged)).toBe(2);
  });

  it('overwrites a drifted counter on recompute (the ON CONFLICT SET clause)', async () => {
    // A re-run over UNCHANGED events would keep whatever the first insert wrote
    // even if the SET clause omitted these columns, so corrupt them first: the
    // upsert must REPLACE the stored value, not merely agree with it.
    await transition('e1', '2026-05-05', { fromStatus: 'A', toStatus: 'B', flowId: 'f1', flowRevision: 1, compliant: true });
    await recomputeRollups(db, { full: true });
    await db.run("UPDATE rollups_daily SET transitions_judged = 99, transitions_compliant = 99 WHERE day = '2026-05-05'");

    await recomputeRollups(db, { full: true });

    const r = await row('2026-05-05');
    expect(Number(r.transitions_judged)).toBe(1);
    expect(Number(r.transitions_compliant)).toBe(1);
  });
});

describe('recomputeRollups counts flow adherence (Postgres parity)', () => {
  let db: any;
  afterEach(async () => { try { await db.close(); } catch { /* ignore */ } });

  it('agrees with SQLite on the JSON-boolean comparison', async () => {
    db = await openPgMemDb();
    await db.run("INSERT INTO orgs (id, name) VALUES ('org-pg', 'PG')");
    const ev = (id: string, payload: Record<string, unknown>) =>
      db.run(
        `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
         VALUES (?, 'org-pg', 'inst-1', 'dev@acme.com', ?, ?, 'step.transitioned', ?)`,
        [id, '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z', envelope('step.transitioned', payload)],
      );
    await ev('e1', { fromStatus: 'PLAN', toStatus: 'WORK', flowId: 'f1', flowRevision: 1, compliant: true });
    await ev('e2', { fromStatus: 'WORK', toStatus: 'PLAN', flowId: 'f1', flowRevision: 1, compliant: true });
    await ev('e3', { fromStatus: 'WORK', toStatus: 'PAUSED', flowId: 'f1', flowRevision: 1, compliant: false });
    await ev('e4', { fromStatus: 'TODO', toStatus: 'PLAN' });

    await recomputeRollups(db, { full: true });

    const r = await db.get<any>(
      'SELECT transitions_judged, transitions_compliant FROM rollups_daily WHERE org_id = ? AND user_key = ? AND day = ?',
      ['org-pg', 'dev@acme.com', '2026-05-01'],
    );
    expect(Number(r.transitions_judged)).toBe(3);
    expect(Number(r.transitions_compliant)).toBe(2);
  });
});
