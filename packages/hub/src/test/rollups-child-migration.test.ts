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
    expect(cols.map(c => c.name)).toEqual(expect.arrayContaining(['child_hub_id', 'prs_opened']));
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
