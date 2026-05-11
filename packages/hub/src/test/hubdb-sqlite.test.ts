import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HubDb } from '../db/types';
import { openSqliteDb } from '../db/sqlite';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hubdb-sqlite-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('HubDb SQLite adapter', () => {
  let db: HubDb;

  beforeEach(async () => {
    cleanup();
    db = await openSqliteDb(TEST_DB);
  });

  afterEach(async () => {
    try { await db.close(); } catch { /* already closed */ }
    cleanup();
  });

  it('exposes async run/get/all/exec on the HubDb interface', async () => {
    expect(typeof db.run).toBe('function');
    expect(typeof db.get).toBe('function');
    expect(typeof db.all).toBe('function');
    expect(typeof db.exec).toBe('function');
    expect(typeof db.transaction).toBe('function');
    expect(typeof db.close).toBe('function');
  });

  it('bootstrap creates all required tables', async () => {
    const rows = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const names = rows.map(r => r.name);
    for (const expected of [
      'orgs', 'api_keys', 'installations', 'events', 'rollups_daily',
      'users', 'device_codes', 'used_invites', 'auth_config',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('run() returns a Result with changes count', async () => {
    await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', ['o1', 'Org One']);
    const r = await db.run('UPDATE orgs SET name = ? WHERE id = ?', ['Renamed', 'o1']);
    expect(r.changes).toBe(1);

    const r2 = await db.run('UPDATE orgs SET name = ? WHERE id = ?', ['nope', 'missing']);
    expect(r2.changes).toBe(0);
  });

  it('get() returns first row or undefined', async () => {
    await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', ['o1', 'One']);
    const row = await db.get<{ id: string; name: string }>(
      'SELECT id, name FROM orgs WHERE id = ?', ['o1']
    );
    expect(row?.id).toBe('o1');
    expect(row?.name).toBe('One');

    const missing = await db.get('SELECT id FROM orgs WHERE id = ?', ['nope']);
    expect(missing).toBeUndefined();
  });

  it('all() returns array of rows', async () => {
    await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', ['a', 'A']);
    await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', ['b', 'B']);
    const rows = await db.all<{ id: string }>('SELECT id FROM orgs ORDER BY id');
    expect(rows.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('transaction commits on success and rolls back on throw', async () => {
    await db.transaction(async () => {
      await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', ['tx1', 'committed']);
    });
    expect((await db.get<{ id: string }>('SELECT id FROM orgs WHERE id = ?', ['tx1']))?.id).toBe('tx1');

    await expect(db.transaction(async () => {
      await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', ['tx2', 'rolled-back']);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await db.get('SELECT id FROM orgs WHERE id = ?', ['tx2'])).toBeUndefined();
  });

  it('legacy events table is migrated (item_type/remote_url backfilled)', async () => {
    await db.exec('DROP TABLE IF EXISTS events');
    await db.exec(`
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        user_key TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        type TEXT NOT NULL,
        project_id TEXT,
        item_id TEXT,
        payload TEXT NOT NULL
      )
    `);
    await db.close();

    db = await openSqliteDb(TEST_DB);
    const cols = await db.all<{ name: string }>("PRAGMA table_info(events)");
    const names = new Set(cols.map(c => c.name));
    expect(names.has('item_type')).toBe(true);
    expect(names.has('remote_url')).toBe(true);
    expect(names.has('item_title')).toBe(true);
    expect(names.has('external_id')).toBe(true);
  });

  it('bootstrap purges stored token consumption events and stale rollups', async () => {
    await db.run(
      `INSERT INTO events
       (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['tok-1', 'org', 'inst', 'alice', '2026-05-10T00:00:00Z', '2026-05-10T00:00:01Z', 'tokens.logged', '{}'],
    );
    await db.run(
      `INSERT INTO events
       (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['keep-1', 'org', 'inst', 'alice', '2026-05-10T00:00:00Z', '2026-05-10T00:00:01Z', 'item.created', '{}'],
    );
    await db.run(
      `INSERT INTO rollups_daily
       (org_id, user_key, day, events_count, items_closed, tokens_in, tokens_out, validate_passes, validate_fails, prs_opened)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['org', 'alice', '2026-05-10', 2, 0, 100, 50, 0, 0, 0],
    );
    await db.close();

    db = await openSqliteDb(TEST_DB);
    const eventRows = await db.all<{ type: string }>('SELECT type FROM events ORDER BY event_id');
    expect(eventRows.map(r => r.type)).toEqual(['item.created']);
    const rollupRows = await db.all('SELECT * FROM rollups_daily');
    expect(rollupRows).toEqual([]);
  });

  it('preserves SQLite ON CONFLICT(...) DO UPDATE semantics', async () => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v INTEGER NOT NULL DEFAULT 0
      )
    `);
    await db.run('INSERT INTO kv (k, v) VALUES (?, ?)', ['x', 1]);
    await db.run(
      'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = kv.v + excluded.v',
      ['x', 5]
    );
    const row = await db.get<{ v: number }>('SELECT v FROM kv WHERE k = ?', ['x']);
    expect(row?.v).toBe(6);
  });

  it('preserves SQLite INSERT OR IGNORE semantics', async () => {
    await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', ['o1', 'first']);
    const r = await db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', ['o1', 'second']);
    expect(r.changes).toBe(0);
    const row = await db.get<{ name: string }>('SELECT name FROM orgs WHERE id = ?', ['o1']);
    expect(row?.name).toBe('first');
  });
});
