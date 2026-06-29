// Engine-level read-only enforcement for HubDb.readonlyAll. These bypass the
// route/keyword guard entirely and prove the database itself refuses writes —
// the authoritative read-only boundary for the admin DB console (HIGH-1).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openSqliteDb } from '../db/sqlite';
import type { HubDb } from '../db/types';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-ro-test-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('readonlyAll engine-level enforcement (SQLite)', () => {
  let db: HubDb;
  beforeEach(async () => {
    cleanup();
    db = await openSqliteDb(TEST_DB);
    await db.run("INSERT INTO orgs (id, name) VALUES ('org', 'Org')");
  });
  afterEach(async () => { await db.close(); cleanup(); });

  it('allows a SELECT and returns rows', async () => {
    const rows = await db.readonlyAll<{ id: string }>('SELECT id FROM orgs');
    expect(rows.map(r => r.id)).toContain('org');
  });

  it('rejects a write even when it slips past the keyword guard', async () => {
    await expect(db.readonlyAll("DELETE FROM orgs")).rejects.toThrow();
    await expect(db.readonlyAll("INSERT INTO orgs (id) VALUES ('x')")).rejects.toThrow();
    await expect(db.readonlyAll("CREATE TABLE evil (x TEXT)")).rejects.toThrow();
    // data untouched
    const rows = await db.all('SELECT id FROM orgs');
    expect(rows.length).toBe(1);
  });

  it('restores write capability after a read-only query (query_only toggled back off)', async () => {
    await db.readonlyAll('SELECT 1');
    await expect(db.run("INSERT INTO orgs (id, name) VALUES ('org2', 'Org2')")).resolves.toBeTruthy();
    const rows = await db.all('SELECT id FROM orgs');
    expect(rows.length).toBe(2);
  });
});
