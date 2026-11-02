/**
 * GH-288 — a backup is a snapshot of the whole database file, not a JSON dump
 * of projects and items: one JSON string cannot hold a database past ~512 MB
 * ("Invalid string length"), and the dump never carried flows, settings or
 * receipts. Taken with node:sqlite's online backup, or VACUUM INTO where the
 * running Node has none; either way the file appears whole or not at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import { ItemType, Status, type AgEnFKItem } from '@agenfk/core';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let dir: string;
let storage: SQLiteStorageProvider;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-snap-'));
  storage = new SQLiteStorageProvider();
  await storage.init({ path: path.join(dir, 'db.sqlite') });
  await storage.createProject({ id: 'p1', name: 'Snap', description: '', createdAt: new Date(), updatedAt: new Date() } as any);
  for (let i = 0; i < 5; i++) {
    await storage.createItem({
      id: `it-${i}`, projectId: 'p1', type: ItemType.TASK, status: Status.TODO, title: `card ${i}`, description: '',
      createdAt: new Date(), updatedAt: new Date(), history: [], comments: [], tests: [], tokenUsage: [], context: [],
    } as unknown as AgEnFKItem);
  }
  await storage.updateSettings({ maxConcurrentSuiteRuns: 3 } as any);
});
afterEach(async () => {
  await storage.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

function read(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const count = (t: string) => Number((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);
    return { projects: count('projects'), items: count('items'), check: (db.prepare('PRAGMA quick_check').get() as any).quick_check };
  } finally {
    db.close();
  }
}

for (const online of [true, false]) {
  describe(`snapshotTo (${online ? 'online backup' : 'VACUUM INTO'})`, () => {
    it('writes the whole database to one file that opens on its own', async () => {
      const dest = path.join(dir, 'backup.sqlite');
      await storage.snapshotTo(dest, { online });
      expect(read(dest)).toEqual({ projects: 1, items: 5, check: 'ok' });
      expect(fs.readdirSync(dir).filter(f => f.startsWith('backup'))).toEqual(['backup.sqlite']);
    });

    it('carries more than projects and items: settings too', async () => {
      const dest = path.join(dir, 'backup.sqlite');
      await storage.snapshotTo(dest, { online });
      const copy = new SQLiteStorageProvider();
      await copy.init({ path: dest });
      try {
        expect((await copy.getSettings()).maxConcurrentSuiteRuns).toBe(3);
      } finally {
        await copy.shutdown();
      }
    });

    it('takes two snapshots to one destination at once without either breaking the other', async () => {
      const dest = path.join(dir, 'backup.sqlite');
      await Promise.all([storage.snapshotTo(dest, { online }), storage.snapshotTo(dest, { online })]);
      expect(read(dest)).toEqual({ projects: 1, items: 5, check: 'ok' });
      expect(fs.readdirSync(dir).filter(f => f.startsWith('backup'))).toEqual(['backup.sqlite']);
    });

    it('leaves nothing at the destination when it fails', async () => {
      const dest = path.join(dir, 'no-such-dir', 'backup.sqlite');
      await expect(storage.snapshotTo(dest, { online })).rejects.toThrow();
      expect(fs.existsSync(dest)).toBe(false);
    });
  });
}
