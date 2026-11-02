/**
 * GH-288 — what the database file holds, and compacting it in place.
 *
 * `dbStats()` is what `agenfk db status` shows: the file and WAL sizes, the
 * space deleted rows left behind (free pages), and the largest tables.
 * `vacuum()` is `agenfk db vacuum`: it folds the WAL into the file, rewrites
 * the file without the free pages, and checks the result.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import { ItemType, Status, type AgEnFKItem } from '@agenfk/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let dbPath: string;
let storage: SQLiteStorageProvider;
beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `agenfk-maint-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
  storage = new SQLiteStorageProvider();
  await storage.init({ path: dbPath });
});
afterEach(async () => {
  await storage.shutdown();
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(dbPath + s)) fs.unlinkSync(dbPath + s);
});

const item = (i: number): AgEnFKItem => ({
  id: `it-${i}`, projectId: 'p1', type: ItemType.TASK, status: Status.TODO, title: `card ${i}`,
  description: 'x'.repeat(20_000), createdAt: new Date(), updatedAt: new Date(),
  history: [], comments: [], tests: [], tokenUsage: [], context: [],
} as unknown as AgEnFKItem);

async function fill(n: number) {
  for (let i = 0; i < n; i++) await storage.createItem(item(i));
}

describe('dbStats', () => {
  it('reports the file, the WAL, the page size and the tables, largest first', async () => {
    await fill(20);
    const s = storage.dbStats({ tables: true });
    expect(s.fileBytes).toBe(fs.statSync(dbPath).size);
    expect(s.walBytes).toBe(fs.existsSync(dbPath + '-wal') ? fs.statSync(dbPath + '-wal').size : 0);
    expect(s.pageSize).toBeGreaterThan(0);
    expect(s.pageCount).toBeGreaterThan(0);
    const tables = s.tables!;
    expect(tables[0].name).toBe('items');
    expect(tables[0].bytes).toBeGreaterThan(20 * 20_000);
    for (let i = 1; i < tables.length; i++) expect(tables[i - 1].bytes).toBeGreaterThanOrEqual(tables[i].bytes);
  });

  // Review of GH-288: the breakdown reads every page, so it is only taken when asked for.
  it('leaves the tables out unless asked for', async () => {
    await fill(2);
    expect(storage.dbStats().tables).toBeUndefined();
  });

  it('counts the space deleted rows leave behind as reclaimable', async () => {
    await fill(40);
    storage.vacuum();
    expect(storage.dbStats().reclaimableBytes).toBe(0);
    for (let i = 0; i < 30; i++) await storage.deleteItem(`it-${i}`);
    const s = storage.dbStats();
    expect(s.reclaimableBytes).toBe(s.freelistCount * s.pageSize);
    expect(s.reclaimableBytes).toBeGreaterThan(30 * 20_000 * 0.5);
  });
});

describe('vacuum', () => {
  it('shrinks the file to what it holds, empties the WAL, and keeps every row', async () => {
    await fill(40);
    for (let i = 0; i < 30; i++) await storage.deleteItem(`it-${i}`);
    const before = storage.dbStats();
    const r = storage.vacuum();
    expect(r.check).toBe('ok');
    expect(r.before.fileBytes + r.before.walBytes).toBe(before.fileBytes + before.walBytes);
    expect(r.after.fileBytes).toBe(fs.statSync(dbPath).size);
    expect(r.after.fileBytes).toBeLessThan(before.fileBytes + before.walBytes - 30 * 20_000 * 0.5);
    expect(r.after.walBytes).toBe(0);
    expect(r.after.reclaimableBytes).toBe(0);
    const left = await storage.listItems({ projectId: 'p1' });
    expect(left.map(i => i.id).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `it-${i + 30}`).sort());
  });

  it('leaves the database usable for writes afterwards', async () => {
    await fill(3);
    storage.vacuum();
    await storage.createItem(item(99));
    expect((await storage.getItem('it-99'))?.title).toBe('card 99');
  });
});
