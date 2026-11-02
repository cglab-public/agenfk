/**
 * SX-1 (8dd7c7c0): the cards a sandboxed session touched. Their own table, not a
 * field on the item: nothing that edits an item can clear it. Recording is
 * idempotent and keeps the first time; reading answers which of the given ids
 * are recorded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let dir: string;
let dbPath: string;
let storage: SQLiteStorageProvider;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-airlock-coverage-'));
  dbPath = path.join(dir, 'db.sqlite');
  storage = new SQLiteStorageProvider();
  await storage.init({ path: dbPath });
});

afterEach(async () => {
  await storage.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Airlock covered cards', () => {
  it('records cards and answers which of the asked ids are recorded', async () => {
    expect(await storage.airlockCoveredAmong(['a', 'b'])).toEqual([]);
    await storage.markAirlockCovered(['a', 'c'], '2026-10-28T10:00:00.000Z');
    expect((await storage.airlockCoveredAmong(['a', 'b', 'c'])).sort()).toEqual(['a', 'c']);
    expect(await storage.airlockCoveredAmong([])).toEqual([]);
  });

  it('is idempotent and keeps the first time a card was covered', async () => {
    await storage.markAirlockCovered(['a'], '2026-10-28T10:00:00.000Z');
    await storage.markAirlockCovered(['a', 'a'], '2026-10-28T11:00:00.000Z');
    expect(await storage.airlockCoveredSince('a')).toBe('2026-10-28T10:00:00.000Z');
    expect(await storage.airlockCoveredSince('zz')).toBeNull();
  });

  it('survives a reopen of the database', async () => {
    await storage.markAirlockCovered(['a'], '2026-10-28T10:00:00.000Z');
    await storage.shutdown();
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
    expect(await storage.airlockCoveredAmong(['a'])).toEqual(['a']);
  });

  it('asks in bounded batches: thousands of ids answer correctly', async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `id-${i}`);
    await storage.markAirlockCovered([ids[0], ids[1999], ids[2499]], '2026-10-28T10:00:00.000Z');
    expect((await storage.airlockCoveredAmong(ids)).sort()).toEqual([ids[0], ids[1999], ids[2499]].sort());
  });
});
