// A hub whose database predates the reporting bookkeeping (CGLAB-183 task 3).
//
// CREATE TABLE IF NOT EXISTS never adds a column to a table that already
// exists, so the tables tasks 1 and 2 created keep their old shape on any hub
// that ran an earlier commit. Every progress path then throws "no such column:
// seq" — and on the parent that happens inside the /deliver transaction, which
// takes the reporting child's whole delivery batch down with it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../db';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-updispmig-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

/** The shapes exactly as tasks 1 and 2 shipped them, without the new columns. */
const writeOldShape = () => {
  const raw = new DatabaseSync(TEST_DB);
  raw.exec(`CREATE TABLE upgrade_dispatch_targets (
    dispatch_id TEXT NOT NULL, child_hub_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', detail TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (dispatch_id, child_hub_id));`);
  raw.exec(`CREATE TABLE upgrade_dispatch_fanout (
    dispatch_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, outcome TEXT NOT NULL,
    upgraded INTEGER NOT NULL DEFAULT 0, skipped_json TEXT NOT NULL DEFAULT '[]',
    directive_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  raw.exec(`INSERT INTO upgrade_dispatch_targets (dispatch_id, child_hub_id, state)
            VALUES ('d-1', 'ch-1', 'pending');`);
  raw.exec(`INSERT INTO upgrade_dispatch_fanout (dispatch_id, org_id, outcome, upgraded, skipped_json)
            VALUES ('d-1', 'org', 'applied', 2, '[]');`);
  raw.close();
};

beforeEach(cleanup);
afterEach(cleanup);

describe('opening a database that predates the reporting columns', () => {
  it('adds them, without disturbing the rows already there', async () => {
    writeOldShape();
    const db = await openDb(TEST_DB);

    const cols = async (t: string) =>
      (await db.all<any>(`SELECT name FROM pragma_table_info('${t}')`)).map(r => r.name);
    expect(await cols('upgrade_dispatch_targets')).toContain('seq');
    expect(await cols('upgrade_dispatch_fanout')).toEqual(
      expect.arrayContaining(['reported_seq', 'reported_json']),
    );

    // The existing rows survive, and the new columns default sanely — a target
    // defaulting to anything but 0 would fail `seq < ?` against a first report
    // of 1 and never move again.
    const t = await db.get<any>('SELECT state, seq FROM upgrade_dispatch_targets WHERE dispatch_id = ?', ['d-1']);
    expect(t.state).toBe('pending');
    expect(Number(t.seq)).toBe(0);
    const f = await db.get<any>('SELECT upgraded, reported_seq, reported_json FROM upgrade_dispatch_fanout WHERE dispatch_id = ?', ['d-1']);
    expect(Number(f.upgraded)).toBe(2);
    expect(Number(f.reported_seq)).toBe(0);
    expect(f.reported_json).toBeNull();
    await db.close();
  });

  it('is idempotent — opening again does not fail on the columns it added', async () => {
    writeOldShape();
    await (await openDb(TEST_DB)).close();
    const db = await openDb(TEST_DB);
    expect((await db.all<any>("SELECT name FROM pragma_table_info('upgrade_dispatch_targets')"))
      .filter(r => r.name === 'seq')).toHaveLength(1);
    await db.close();
  });
});
