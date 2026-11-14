/**
 * @file GitHub #208 phase 1 — a spec can delete its database on Windows.
 *
 * Over a hundred server specs delete their sqlite database in a hook while the
 * server module still holds it open: `initStorage()` replaced the storage
 * without closing the one before, and nothing closed the last. POSIX lets an
 * open file be unlinked, so it went unnoticed; Windows refuses with EBUSY, and
 * the first refusal failed the whole file (390 tests, plus ~35 files whose
 * tests all passed and only their teardown failed).
 */
import { testDbPath, removeTestDb } from './helpers/testDb';
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';

const TEST_DB = testDbPath('test-db-lifecycle-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { initStorage, closeStorage, storage } from '../server';

afterAll(async () => { await removeTestDb(TEST_DB, closeStorage); });

describe('closeStorage()', () => {
  it('releases the database file, so it can be deleted on every OS', async () => {
    await initStorage();
    await storage.listProjects();
    await closeStorage();
    expect(() => fs.rmSync(TEST_DB)).not.toThrow();
    expect(fs.existsSync(TEST_DB)).toBe(false);
  });

  it('leaves the storage closed: a read after it fails instead of reaching a deleted file', async () => {
    await initStorage();
    await closeStorage();
    await expect(storage.listProjects()).rejects.toThrow(/not initialized/);
  });

  it('is harmless when nothing is open, and when called twice', async () => {
    await closeStorage();
    await expect(closeStorage()).resolves.toBeUndefined();
  });
});

describe('initStorage()', () => {
  it('closes the storage it replaces instead of leaking its handle', async () => {
    await initStorage();
    const first = storage;
    await initStorage();
    expect(storage).not.toBe(first);
    await expect(first.listProjects()).rejects.toThrow(/not initialized/);
    await expect(storage.listProjects()).resolves.toBeInstanceOf(Array);
  });
});

describe('removeTestDb()', () => {
  const sidecars = ['', '-wal', '-shm'];

  it('closes first, then removes the database and its -wal/-shm sidecars', async () => {
    const db = testDbPath('remove-test-db-sidecars.sqlite');
    for (const s of sidecars) fs.writeFileSync(db + s, 'x');
    const calls: string[] = [];
    await removeTestDb(db, async () => {
      calls.push(sidecars.filter(s => fs.existsSync(db + s)).length === 3 ? 'closed-before-removal' : 'closed-late');
    });
    expect(calls).toEqual(['closed-before-removal']);
    for (const s of sidecars) expect(fs.existsSync(db + s)).toBe(false);
  });

  it('tolerates files that are already gone, and works without a closer', async () => {
    const db = testDbPath('remove-test-db-missing.sqlite');
    await expect(removeTestDb(db)).resolves.toBeUndefined();
  });

  it('removes the live database the server had open', async () => {
    await initStorage();
    await storage.listProjects();
    await removeTestDb(TEST_DB, closeStorage);
    for (const s of sidecars) expect(fs.existsSync(TEST_DB + s)).toBe(false);
  });
});
