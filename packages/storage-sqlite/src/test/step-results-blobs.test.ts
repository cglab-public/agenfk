/**
 * @file e248239d — a capture's per-test results live outside the item row.
 *
 * Every capture record held a whole run's per-test results inline, so a card
 * weighed 1.8 MB and every listItems parsed hundreds of MB. The provider now
 * keeps each record's `tests` in a content-addressed blobs table (one row per
 * distinct array) and the item row keeps a `testsBlob` reference. Reads give
 * the results back unless the caller asks for `hydrate: false`, so callers
 * are unchanged. Existing rows are moved once at init; blobs nothing
 * references any more are dropped then too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import { ItemType, Status, type AgEnFKItem } from '@agenfk/core';
// The provider's own driver (Node 22+), for reading rows as they are stored.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let dbPath: string;
let storage: SQLiteStorageProvider;
beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `agenfk-blobs-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
  storage = new SQLiteStorageProvider();
  await storage.init({ path: dbPath });
});
afterEach(async () => {
  await storage.shutdown();
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(dbPath + s)) fs.unlinkSync(dbPath + s);
});

const tests = (n: number, tag = 'a') => Array.from({ length: n }, (_, i) => ({ name: `${tag} ${i}`, file: `f${i % 7}.test.js`, status: 'passed' }));
const capture = (t: any[], at = '2026-09-28T10:00:00.000Z') => ({ step: 'WORK', kind: 'capture', at, available: true, exitCode: 0, tests: t });
const item = (id = `it-${Math.random().toString(36).slice(2)}`): AgEnFKItem => ({
  id, projectId: 'p1', type: ItemType.TASK, status: Status.TODO, title: 'card', description: '', createdAt: new Date(), updatedAt: new Date(), history: [], comments: [], tests: [], tokenUsage: [], context: [],
} as unknown as AgEnFKItem);
const raw = (id: string) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return (db.prepare('SELECT data FROM items WHERE id = ?').get(id) as { data: string }).data; } finally { db.close(); }
};
const blobCount = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return (db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n; } finally { db.close(); }
};

describe('writing', () => {
  it('keeps the per-test results out of the item row', async () => {
    const c = await storage.createItem(item());
    await storage.updateItem(c.id, { stepRecords: [capture(tests(500))] } as any);
    const row = JSON.parse(raw(c.id));
    expect(row.stepRecords[0].tests).toBeUndefined();
    expect(typeof row.stepRecords[0].testsBlob).toBe('string');
    expect(raw(c.id).length).toBeLessThan(5_000);
  });

  it('superseded records too', async () => {
    const c = await storage.createItem(item());
    await storage.updateItem(c.id, { supersededRecords: [capture(tests(300))] } as any);
    expect(JSON.parse(raw(c.id)).supersededRecords[0].tests).toBeUndefined();
  });

  it('stores one blob per distinct result set, shared by the records that hold it', async () => {
    const a = await storage.createItem(item());
    const b = await storage.createItem(item());
    const same = tests(200);
    await storage.updateItem(a.id, { stepRecords: [capture(same), capture(same, '2026-09-28T11:00:00.000Z')] } as any);
    await storage.updateItem(b.id, { stepRecords: [capture(same)] } as any);
    expect(blobCount()).toBe(1);
  });

  it('an update of another field hands back the stored results too, not their reference', async () => {
    const c = await storage.createItem(item());
    await storage.updateItem(c.id, { stepRecords: [capture(tests(25))] } as any);
    const updated: any = await storage.updateItem(c.id, { title: 'renamed' } as any);
    expect(updated.title).toBe('renamed');
    expect(updated.stepRecords[0].tests).toHaveLength(25);
    expect(updated.stepRecords[0].testsBlob).toBeUndefined();
  });

  it('hands the caller back its results, not the reference', async () => {
    const c = await storage.createItem(item());
    const updated: any = await storage.updateItem(c.id, { stepRecords: [capture(tests(50))] } as any);
    expect(updated.stepRecords[0].tests).toHaveLength(50);
    expect(updated.stepRecords[0].testsBlob).toBeUndefined();
  });
});

describe('reading', () => {
  it('getItem gives the results back', async () => {
    const c = await storage.createItem(item());
    await storage.updateItem(c.id, { stepRecords: [capture(tests(120))] } as any);
    const got: any = await storage.getItem(c.id);
    expect(got.stepRecords[0].tests).toEqual(tests(120));
    expect(got.stepRecords[0].testsBlob).toBeUndefined();
  });

  it('listItems gives them back by default', async () => {
    const c = await storage.createItem(item());
    await storage.updateItem(c.id, { stepRecords: [capture(tests(40))] } as any);
    const [got]: any = (await storage.listItems({ projectId: 'p1' })).filter(i => i.id === c.id);
    expect(got.stepRecords[0].tests).toHaveLength(40);
  });

  it('listItems with hydrate: false leaves the reference and skips the results', async () => {
    const c = await storage.createItem(item());
    await storage.updateItem(c.id, { stepRecords: [capture(tests(40))] } as any);
    const [got]: any = (await storage.listItems({ projectId: 'p1', hydrate: false } as any)).filter(i => i.id === c.id);
    expect(got.stepRecords[0].tests).toBeUndefined();
    expect(typeof got.stepRecords[0].testsBlob).toBe('string');
  });

  it('a record with no per-test results is stored and read as it was', async () => {
    const c = await storage.createItem(item());
    const exit = { step: 'WORK', kind: 'exit', at: '2026-09-28T10:00:00.000Z', checks: [] };
    await storage.updateItem(c.id, { stepRecords: [exit] } as any);
    expect(((await storage.getItem(c.id)) as any).stepRecords).toEqual([exit]);
  });
});

describe('an existing database', () => {
  it('has its inline results moved out once, at init, and reads the same', async () => {
    const c = await storage.createItem(item());
    await storage.shutdown();
    // A row as an older build wrote it: the results inline.
    const db = new DatabaseSync(dbPath);
    const data = JSON.parse((db.prepare('SELECT data FROM items WHERE id = ?').get(c.id) as { data: string }).data);
    data.stepRecords = [capture(tests(80))];
    db.prepare('UPDATE items SET data = ? WHERE id = ?').run(JSON.stringify(data), c.id);
    db.close();
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
    expect(JSON.parse(raw(c.id)).stepRecords[0].tests).toBeUndefined();
    expect(((await storage.getItem(c.id)) as any).stepRecords[0].tests).toEqual(tests(80));
  });

  it('drops the blobs no item references any more, at init', async () => {
    const c = await storage.createItem(item());
    await storage.updateItem(c.id, { stepRecords: [capture(tests(30, 'old'))] } as any);
    await storage.updateItem(c.id, { stepRecords: [capture(tests(30, 'new'))] } as any);
    expect(blobCount()).toBe(2);
    await storage.shutdown();
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
    expect(blobCount()).toBe(1);
    expect(((await storage.getItem(c.id)) as any).stepRecords[0].tests[0].name).toBe('new 0');
  });
});
