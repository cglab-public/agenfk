import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { DatabaseSync } = require('node:sqlite');

const TEST_DB = path.join(os.tmpdir(), `agenfk-sqlite-migration-test-${process.pid}.sqlite`);

describe('SQLiteStorageProvider migrations', () => {
  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = TEST_DB + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  describe('flows table: project_id column removal', () => {
    beforeEach(() => {
      // Simulate a database created with the OLD schema where
      // flows had `project_id TEXT NOT NULL`.
      const db = new DatabaseSync(TEST_DB);
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS items (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          parent_id TEXT,
          data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS snapshots (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS flows (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          data TEXT NOT NULL
        );
      `);
      db.close();
    });

    it('init() runs without error on a database with the old flows schema', async () => {
      const storage = new SQLiteStorageProvider();
      await expect(storage.init({ path: TEST_DB })).resolves.not.toThrow();
      await storage.shutdown();
    });

    it('createFlow() succeeds after init() on a database with the old flows schema', async () => {
      const storage = new SQLiteStorageProvider();
      await storage.init({ path: TEST_DB });

      const flow = {
        id: 'flow-1',
        name: 'Test Flow',
        description: 'A flow with no project',
        steps: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await expect(storage.createFlow(flow)).resolves.toMatchObject({ id: 'flow-1', name: 'Test Flow' });
      await storage.shutdown();
    });

    it('pre-existing flows data is preserved after migration', async () => {
      // Insert a flow row in the old schema (requires project_id)
      const db = new DatabaseSync(TEST_DB);
      const existingFlow = {
        id: 'existing-flow',
        name: 'Old Flow',
        steps: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      db.prepare('INSERT INTO flows (id, project_id, data) VALUES (?, ?, ?)').run(
        existingFlow.id, 'proj-1', JSON.stringify(existingFlow)
      );
      db.close();

      const storage = new SQLiteStorageProvider();
      await storage.init({ path: TEST_DB });

      const retrieved = await storage.getFlow('existing-flow');
      expect(retrieved).toMatchObject({ id: 'existing-flow', name: 'Old Flow' });

      await storage.shutdown();
    });
  });
});
