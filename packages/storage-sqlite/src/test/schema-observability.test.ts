import { describe, it, expect, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { DatabaseSync } = require('node:sqlite');

const TEST_DB = path.join(os.tmpdir(), `agenfk-sqlite-observability-${process.pid}.sqlite`);

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function tableColumns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function indexNames(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((i) => i.name);
}

describe('SQLiteStorageProvider observability schema', () => {
  afterEach(cleanup);

  it('creates token_events table with the expected columns and indexes', async () => {
    const storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
    await storage.shutdown();

    const db = new DatabaseSync(TEST_DB);
    const cols = tableColumns(db, 'token_events');
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'ts', 'client', 'session_id', 'turn_id', 'model',
        'input', 'cached_input', 'output', 'reasoning', 'total',
        'item_id', 'project_id', 'source_path', 'source_offset',
      ])
    );

    const idx = indexNames(db, 'token_events');
    expect(idx).toEqual(expect.arrayContaining([
      'idx_token_events_ts',
      'idx_token_events_item',
      'idx_token_events_session',
      'idx_token_events_dedup',
    ]));
    db.close();
  });

  it('token_events dedup index is UNIQUE on (client, source_path, source_offset)', async () => {
    const storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
    await storage.shutdown();

    const db = new DatabaseSync(TEST_DB);
    db.prepare(
      `INSERT INTO token_events
       (id, ts, client, session_id, model, input, cached_input, output, reasoning, total, source_path, source_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('e1', '2026-05-10T00:00:00Z', 'codex', 's1', 'gpt-x', 1, 0, 2, 0, 3, '/p/a.jsonl', 0);

    expect(() => {
      db.prepare(
        `INSERT INTO token_events
         (id, ts, client, session_id, model, input, cached_input, output, reasoning, total, source_path, source_offset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('e2', '2026-05-10T00:00:00Z', 'codex', 's1', 'gpt-x', 1, 0, 2, 0, 3, '/p/a.jsonl', 0);
    }).toThrow(/UNIQUE/i);

    db.close();
  });

  it('creates ingestion_state table with source_path PRIMARY KEY', async () => {
    const storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
    await storage.shutdown();

    const db = new DatabaseSync(TEST_DB);
    const cols = tableColumns(db, 'ingestion_state');
    expect(cols).toEqual(expect.arrayContaining(['source_path', 'last_offset', 'last_run_at']));

    db.prepare('INSERT INTO ingestion_state (source_path, last_offset, last_run_at) VALUES (?, ?, ?)')
      .run('/p/a.jsonl', 100, '2026-05-10T00:00:00Z');
    expect(() =>
      db.prepare('INSERT INTO ingestion_state (source_path, last_offset, last_run_at) VALUES (?, ?, ?)')
        .run('/p/a.jsonl', 200, '2026-05-10T00:00:01Z')
    ).toThrow(/UNIQUE|PRIMARY/i);
    db.close();
  });

  it('creates prs table with the expected columns and indexes', async () => {
    const storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
    await storage.shutdown();

    const db = new DatabaseSync(TEST_DB);
    const cols = tableColumns(db, 'prs');
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'pr_number', 'repo', 'item_id', 'opened_at',
        'sizing_json', 'sizing_declared_at', 'sizing_shadow_json',
        'last_sizing_check_at',
      ])
    );

    const idx = indexNames(db, 'prs');
    expect(idx).toEqual(expect.arrayContaining(['idx_prs_repo_number', 'idx_prs_item']));
    db.close();
  });

  it('prs unique constraint covers (repo, pr_number)', async () => {
    const storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
    await storage.shutdown();

    const db = new DatabaseSync(TEST_DB);
    db.prepare(
      `INSERT INTO prs (id, pr_number, repo, item_id, opened_at, sizing_json, sizing_declared_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('p1', 42, 'foo/bar', 'item-1', '2026-05-10T00:00:00Z', '{"epic":0,"story":1,"task":2,"bug":0}', '2026-05-10T00:00:00Z');

    expect(() =>
      db.prepare(
        `INSERT INTO prs (id, pr_number, repo, item_id, opened_at, sizing_json, sizing_declared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('p2', 42, 'foo/bar', 'item-2', '2026-05-10T01:00:00Z', '{"epic":0,"story":0,"task":1,"bug":0}', '2026-05-10T01:00:00Z')
    ).toThrow(/UNIQUE/i);

    // Same number, different repo — allowed.
    expect(() =>
      db.prepare(
        `INSERT INTO prs (id, pr_number, repo, item_id, opened_at, sizing_json, sizing_declared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('p3', 42, 'baz/qux', 'item-3', '2026-05-10T02:00:00Z', '{"epic":0,"story":0,"task":1,"bug":0}', '2026-05-10T02:00:00Z')
    ).not.toThrow();

    db.close();
  });

  it('init() is idempotent across re-runs (CREATE TABLE IF NOT EXISTS)', async () => {
    const storage1 = new SQLiteStorageProvider();
    await storage1.init({ path: TEST_DB });
    await storage1.shutdown();

    const storage2 = new SQLiteStorageProvider();
    await expect(storage2.init({ path: TEST_DB })).resolves.not.toThrow();
    await storage2.shutdown();

    // After re-init, tables should still be queryable.
    const db = new DatabaseSync(TEST_DB);
    expect(() => db.prepare('SELECT 1 FROM token_events LIMIT 1').all()).not.toThrow();
    expect(() => db.prepare('SELECT 1 FROM ingestion_state LIMIT 1').all()).not.toThrow();
    expect(() => db.prepare('SELECT 1 FROM prs LIMIT 1').all()).not.toThrow();
    db.close();
  });
});
