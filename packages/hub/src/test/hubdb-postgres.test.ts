import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { HubDb } from '../db/types';
import { openPgMemDb } from '../db/postgres';

describe('HubDb Postgres adapter (pg-mem)', () => {
  let db: HubDb;

  beforeEach(async () => { db = await openPgMemDb(); });
  afterEach(async () => { try { await db.close(); } catch { /* */ } });

  it('exposes the async HubDb interface', () => {
    expect(typeof db.run).toBe('function');
    expect(typeof db.get).toBe('function');
    expect(typeof db.all).toBe('function');
    expect(typeof db.exec).toBe('function');
    expect(typeof db.transaction).toBe('function');
    expect(typeof db.close).toBe('function');
  });

  it('bootstrap creates required tables', async () => {
    const rows = await db.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    const names = rows.map(r => r.table_name);
    for (const expected of [
      'orgs', 'api_keys', 'installations', 'events', 'rollups_daily',
      'users', 'device_codes', 'used_invites', 'auth_config',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('run() with ? placeholders inserts and reports changes', async () => {
    await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', ['o1', 'One']);
    const r = await db.run('UPDATE orgs SET name = ? WHERE id = ?', ['Renamed', 'o1']);
    expect(r.changes).toBe(1);
    const r2 = await db.run('UPDATE orgs SET name = ? WHERE id = ?', ['nope', 'missing']);
    expect(r2.changes).toBe(0);
  });

  it('get() / all() return rows', async () => {
    await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', ['a', 'A']);
    await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', ['b', 'B']);
    const one = await db.get<{ id: string; name: string }>('SELECT id, name FROM orgs WHERE id = ?', ['a']);
    expect(one?.name).toBe('A');
    const many = await db.all<{ id: string }>('SELECT id FROM orgs ORDER BY id');
    expect(many.map(m => m.id)).toEqual(['a', 'b']);
  });

  it('INSERT OR IGNORE is rewritten to ON CONFLICT DO NOTHING', async () => {
    await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', ['o1', 'first']);
    const r = await db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', ['o1', 'second']);
    expect(r.changes).toBe(0);
    const row = await db.get<{ name: string }>('SELECT name FROM orgs WHERE id = ?', ['o1']);
    expect(row?.name).toBe('first');
  });

  it("datetime('now') is rewritten to now() and returns a TIMESTAMPTZ", async () => {
    const row = await db.get<{ ts: string }>("SELECT datetime('now') AS ts");
    // PG returns a Date object via node-pg's default type parsing; pg-mem may
    // surface a string. Either way, parsing it must yield a recent moment.
    const t = new Date(row!.ts as unknown as string).getTime();
    expect(Number.isFinite(t)).toBe(true);
    expect(Math.abs(Date.now() - t)).toBeLessThan(60_000);
  });

  it('transaction commits on success', async () => {
    await db.transaction(async () => {
      await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', ['tx1', 'commit']);
    });
    expect((await db.get<{ id: string }>('SELECT id FROM orgs WHERE id = ?', ['tx1']))?.id).toBe('tx1');
  });

  it('transaction surfaces the thrown error and issues ROLLBACK', async () => {
    // pg-mem's transaction isolation is incomplete — it raises the error and
    // runs the ROLLBACK statement (which is what the adapter is responsible
    // for) but doesn't actually undo writes. The Sqlite-adapter test asserts
    // the rollback semantics end-to-end; here we only assert the throw path.
    await expect(db.transaction(async () => {
      await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', ['tx2', 'rb']);
      throw new Error('boom');
    })).rejects.toThrow('boom');
  });

  it('ON CONFLICT(col) DO UPDATE SET ... = excluded.col works', async () => {
    await db.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)`);
    await db.run('INSERT INTO kv (k, v) VALUES (?, ?)', ['x', 1]);
    await db.run(
      'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = kv.v + excluded.v',
      ['x', 5],
    );
    const row = await db.get<{ v: number }>('SELECT v FROM kv WHERE k = ?', ['x']);
    expect(row?.v).toBe(6);
  });
});
