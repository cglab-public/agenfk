// Upgrade path for rollups_daily.child_hub_id (CGLAB-184).
//
// The column joins the PRIMARY KEY, which SQLite cannot ALTER, so the table is
// rebuilt. Two ways that went wrong and must stay fixed:
//  - the supporting index was added to the always-run schema block, which runs
//    BEFORE migrations, so an upgraded hub died on "no such column" before it
//    could ever repair itself;
//  - the rebuild copied rows, which made it depend on whichever other columns
//    that vintage of the table happened to have.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb } from '../db';

const DB = path.join(os.tmpdir(), `agenfk-hub-rollup-migration-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };
afterEach(cleanup);

/** The shape a hub had before this change, including a pre-prs_opened vintage. */
function seedOldSchema(withPrsOpened: boolean): void {
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(DB);
  raw.exec(`CREATE TABLE rollups_daily (
    org_id TEXT NOT NULL, user_key TEXT NOT NULL, day TEXT NOT NULL,
    events_count INTEGER NOT NULL DEFAULT 0, items_closed INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
    validate_passes INTEGER NOT NULL DEFAULT 0, validate_fails INTEGER NOT NULL DEFAULT 0
    ${withPrsOpened ? ', prs_opened INTEGER NOT NULL DEFAULT 0' : ''},
    PRIMARY KEY (org_id, user_key, day)
  );`);
  raw.exec("INSERT INTO rollups_daily (org_id, user_key, day, events_count) VALUES ('org','a@x','2026-09-01',3)");
  // An events table from before federation: no child_hub_id. `CREATE TABLE IF
  // NOT EXISTS` in the schema block will leave this shape alone, so any index
  // over child_hub_id placed there — rather than after the ALTER — kills boot.
  raw.exec(`CREATE TABLE events (
    event_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, installation_id TEXT NOT NULL,
    user_key TEXT NOT NULL, occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
    type TEXT NOT NULL, project_id TEXT, item_id TEXT, item_type TEXT,
    remote_url TEXT, item_title TEXT, external_id TEXT, reporting_version TEXT,
    payload TEXT NOT NULL
  );`);
  raw.close();
}

/** A hub from AFTER federation but BEFORE CGLAB-613: child_hub_id is present
 *  (so no rebuild fires) and the adherence counters are absent. */
function seedPostFederationSchema(): void {
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(DB);
  raw.exec(`CREATE TABLE rollups_daily (
    org_id TEXT NOT NULL, user_key TEXT NOT NULL, day TEXT NOT NULL,
    events_count INTEGER NOT NULL DEFAULT 0, items_closed INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
    validate_passes INTEGER NOT NULL DEFAULT 0, validate_fails INTEGER NOT NULL DEFAULT 0,
    prs_opened INTEGER NOT NULL DEFAULT 0, child_hub_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (org_id, child_hub_id, user_key, day)
  );`);
  raw.exec("INSERT INTO rollups_daily (org_id, user_key, day, events_count) VALUES ('org','a@x','2026-09-01',3)");
  raw.exec(`CREATE TABLE events (
    event_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, installation_id TEXT NOT NULL,
    user_key TEXT NOT NULL, occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
    type TEXT NOT NULL, project_id TEXT, item_id TEXT, item_type TEXT,
    remote_url TEXT, item_title TEXT, external_id TEXT, reporting_version TEXT,
    payload TEXT NOT NULL, child_hub_id TEXT
  );`);
  raw.close();
}

describe('rollups_daily gains child_hub_id on an existing hub', () => {
  it('boots and adds the column to the primary key', async () => {
    cleanup();
    seedOldSchema(true);
    const db = await openDb(DB);
    const cols = await db.all<{ name: string }>("SELECT name FROM pragma_table_info('rollups_daily')");
    expect(cols.map(c => c.name)).toContain('child_hub_id');
    const pk = await db.all<{ name: string; pk: number }>("SELECT name, pk FROM pragma_table_info('rollups_daily')");
    expect(pk.filter(c => c.pk > 0).map(c => c.name).sort()).toEqual(['child_hub_id', 'day', 'org_id', 'user_key']);
    await db.close();
  });

  it('boots on a hub old enough to predate prs_opened, too', async () => {
    // The rebuild used to SELECT prs_opened out of the old table, which fails
    // at prepare time on a vintage that never had it — with BEGIN already
    // issued, so the boot died mid-transaction.
    cleanup();
    seedOldSchema(false);
    const db = await openDb(DB);
    const cols = await db.all<{ name: string }>("SELECT name FROM pragma_table_info('rollups_daily')");
    await db.close();
    expect(cols.map(c => c.name)).toEqual(expect.arrayContaining(['child_hub_id', 'prs_opened']));
  });

  it('adds the flow-adherence counters to a pre-existing hub, NOT NULL DEFAULT 0', async () => {
    // CGLAB-613: existing rows must stay out of BOTH sides of the score, so
    // the migration adds the counters NOT NULL DEFAULT 0 rather than leaving
    // them NULL (which would make the score NULL for every historical day).
    // This is the POST-FEDERATION vintage: child_hub_id is already present, so
    // no rebuild fires. The row itself cannot be asserted — every boot runs
    // DELETE FROM rollups_daily and recomputes — so the DEFAULT is what proves
    // the historical-day rule.
    cleanup();
    seedPostFederationSchema();
    const db = await openDb(DB);
    const cols = await db.all<{ name: string; notnull: number; dflt_value: string | null }>(
      "SELECT * FROM pragma_table_info('rollups_daily')",
    );
    const byName = Object.fromEntries(cols.map(c => [c.name, c]));
    for (const col of ['transitions_judged', 'transitions_compliant']) {
      expect(byName[col], `${col} was added`).toBeTruthy();
      expect(Number(byName[col].notnull), `${col} is NOT NULL`).toBe(1);
      expect(String(byName[col].dflt_value), `${col} defaults to 0`).toBe('0');
    }
    await db.close();
  });

  it('indexes events by originating hub on an UPGRADED hub, not just a fresh one', async () => {
    // Placement, not existence: on a hub that predates federation the events
    // table has no child_hub_id until the migration ALTERs it in. An index
    // declared in the always-run schema block would be created first and take
    // the boot down with "no such column" — the same trap the rollups index
    // already carries a comment about. A fresh-DB assertion cannot see that.
    cleanup();
    seedOldSchema(true);
    const db = await openDb(DB);
    const idx = await db.all<{ name: string }>("SELECT name FROM pragma_index_list('events')");
    expect(idx.map(i => i.name)).toContain('idx_events_org_childnorm_time');
    // Definition, not just the name: an index over the PLAIN column would carry
    // this same name and satisfy a name-only assertion, while sending the
    // ?childHubId=local read back to walking the org. What it indexes is the
    // whole point of it. child-hub-index-usage.test.ts pins the consequence.
    const def = await db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_events_org_childnorm_time'",
    );
    expect(def!.sql.replace(/\s+/g, ' ')).toContain("COALESCE(child_hub_id, '')");
    await db.close();
  });

  it('creates the supporting index, and is safe to run twice', async () => {
    cleanup();
    seedOldSchema(true);
    const first = await openDb(DB);
    await first.close();
    const second = await openDb(DB);
    const idx = await second.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_rollups_child'");
    expect(idx).toHaveLength(1);
    await second.close();
  });
});
