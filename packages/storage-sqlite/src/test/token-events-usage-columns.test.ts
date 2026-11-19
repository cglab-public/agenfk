/**
 * GH-389: token events carry cache reads and cache writes separately, an
 * optional cost reported by the harness (pi writes its own), and a dedup key
 * (Claude Code's message.id) that is unique per client ACROSS files - the same
 * message can appear in a session log and its subagent log. Ingestion state
 * carries the parser's saved context so a pass can resume mid-file.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TokenEvent } from '@agenfk/core';
import { SQLiteStorageProvider } from '../index';

const { DatabaseSync } = require('node:sqlite');

const TEST_DB = path.join(os.tmpdir(), `agenfk-usage-cols-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + s); } catch { /* absent */ } } };

const ev = (over: Partial<TokenEvent> = {}): TokenEvent => ({
  id: `e-${Math.random()}`, ts: '2026-11-19T10:00:00Z', client: 'claude-code', sessionId: 's1', model: 'claude-opus-5-5',
  input: 3, cachedInput: 9500, cacheRead: 9000, cacheWrite: 500, output: 40, reasoning: 0, total: 9543,
  sourcePath: '/p/s.jsonl', sourceOffset: 0, ...over,
});

describe('token events: usage columns and cross-file dedup', () => {
  afterEach(cleanup);

  it('stores and returns cache reads, cache writes, cost and the dedup key', async () => {
    const storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
    await storage.insertTokenEvent(ev({ dedupKey: 'msg_1', costUsd: 0.0123 }));

    const [row] = await storage.queryTokenEvents({});
    await storage.shutdown();

    expect(row).toMatchObject({ cacheRead: 9000, cacheWrite: 500, costUsd: 0.0123, dedupKey: 'msg_1' });
  });

  it('refuses a second event with the same dedup key for the same client, even from another file', async () => {
    const storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
    await storage.insertTokenEvent(ev({ dedupKey: 'msg_1', sourcePath: '/p/s.jsonl' }));

    await expect(storage.insertTokenEvent(ev({ dedupKey: 'msg_1', sourcePath: '/p/s/subagents/agent-a.jsonl' }))).rejects.toThrow();
    const rows = await storage.queryTokenEvents({});
    await storage.shutdown();
    expect(rows).toHaveLength(1);
  });

  it('the same key from a different client is a different event', async () => {
    const storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
    await storage.insertTokenEvent(ev({ dedupKey: 'k', client: 'claude-code' }));
    await storage.insertTokenEvent(ev({ dedupKey: 'k', client: 'pi', sourceOffset: 5 }));
    const rows = await storage.queryTokenEvents({});
    await storage.shutdown();
    expect(rows).toHaveLength(2);
  });

  it('events without a dedup key never collide on it', async () => {
    const storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
    await storage.insertTokenEvent(ev({ sourceOffset: 0 }));
    await storage.insertTokenEvent(ev({ sourceOffset: 10 }));
    const rows = await storage.queryTokenEvents({});
    await storage.shutdown();
    expect(rows).toHaveLength(2);
  });

  it('round-trips the parser state on ingestion state', async () => {
    const storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
    await storage.setIngestionState({ sourcePath: '/p/a.jsonl', lastOffset: 10, lastRunAt: 'x', parserState: '{"sessionId":"s"}' });
    const st = await storage.getIngestionState('/p/a.jsonl');
    await storage.shutdown();
    expect(st?.parserState).toBe('{"sessionId":"s"}');
  });

  it('adds the new columns to a database created before them, keeping its rows', async () => {
    const db = new DatabaseSync(TEST_DB);
    db.exec(`
      CREATE TABLE token_events (
        id TEXT PRIMARY KEY, ts TEXT NOT NULL, client TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT,
        model TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0, cached_input INTEGER NOT NULL DEFAULT 0,
        output INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
        item_id TEXT, project_id TEXT, source_path TEXT NOT NULL, source_offset INTEGER NOT NULL);
      CREATE TABLE ingestion_state (source_path TEXT PRIMARY KEY, last_offset INTEGER NOT NULL, last_run_at TEXT NOT NULL);
      INSERT INTO token_events (id, ts, client, session_id, model, input, cached_input, output, total, source_path, source_offset)
        VALUES ('old', '2026-05-01T00:00:00Z', 'claude-code', 's', 'm', 1, 2, 3, 6, '/p/old.jsonl', 0);
      INSERT INTO ingestion_state VALUES ('/p/old.jsonl', 100, 'x');
    `);
    db.close();

    const storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
    const rows = await storage.queryTokenEvents({});
    const st = await storage.getIngestionState('/p/old.jsonl');
    await storage.insertTokenEvent(ev({ dedupKey: 'msg_new' }));
    await storage.shutdown();

    expect(rows.map((r) => r.id)).toEqual(['old']);
    expect(rows[0].dedupKey).toBeUndefined();
    expect(st).toMatchObject({ lastOffset: 100 });
    expect(st?.parserState).toBeUndefined();
  });
});
