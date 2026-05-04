/**
 * Tests verifying that the server uses SQLite exclusively.
 * These tests should FAIL before the JSONStorageProvider is removed and
 * initStorage() is simplified to always use SQLite.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app, initStorage } from '../server';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB_JSON_PATH = path.resolve('./server-sqlite-only-test-db.json');
const TEST_DB_SQLITE_PATH = path.resolve('./server-sqlite-only-test-db.sqlite');

describe('SQLite-only storage enforcement', () => {
  describe('when AGENFK_DB_PATH points to a .json path', () => {
    beforeAll(async () => {
      // Clean up any leftover test files
      if (fs.existsSync(TEST_DB_JSON_PATH)) fs.unlinkSync(TEST_DB_JSON_PATH);
      if (fs.existsSync(TEST_DB_SQLITE_PATH)) fs.unlinkSync(TEST_DB_SQLITE_PATH);

      process.env.AGENFK_DB_PATH = TEST_DB_JSON_PATH;
      await initStorage();
    });

    afterAll(() => {
      if (fs.existsSync(TEST_DB_JSON_PATH)) fs.unlinkSync(TEST_DB_JSON_PATH);
      if (fs.existsSync(TEST_DB_SQLITE_PATH)) fs.unlinkSync(TEST_DB_SQLITE_PATH);
    });

    it('GET /db/status should always report dbType=sqlite', async () => {
      const res = await request(app).get('/db/status');
      expect(res.status).toBe(200);
      // Must be sqlite even though env path ended in .json
      expect(res.body.dbType).toBe('sqlite');
    });

    it('should NOT create a .json database file', async () => {
      // After init, a .json storage file must NOT exist — only SQLite
      expect(fs.existsSync(TEST_DB_JSON_PATH)).toBe(false);
    });

    it('should create a .sqlite database file instead', async () => {
      // The server should have remapped .json → .sqlite
      expect(fs.existsSync(TEST_DB_SQLITE_PATH)).toBe(true);
    });

    it('should be fully functional with SQLite (projects endpoint)', async () => {
      const res = await request(app).get('/projects');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('when AGENFK_DB_PATH points to a .sqlite path', () => {
    const SQLITE_TEST_DB = path.resolve('./server-sqlite-explicit-test-db.sqlite');

    beforeAll(async () => {
      if (fs.existsSync(SQLITE_TEST_DB)) fs.unlinkSync(SQLITE_TEST_DB);
      process.env.AGENFK_DB_PATH = SQLITE_TEST_DB;
      await initStorage();
    });

    afterAll(() => {
      if (fs.existsSync(SQLITE_TEST_DB)) fs.unlinkSync(SQLITE_TEST_DB);
    });

    it('GET /db/status should report dbType=sqlite', async () => {
      const res = await request(app).get('/db/status');
      expect(res.status).toBe(200);
      expect(res.body.dbType).toBe('sqlite');
    });
  });

  describe('migration.json import on startup', () => {
    const MIGRATION_DB = path.resolve('./server-migration-test-db.sqlite');
    const migrationPath = path.join(os.homedir(), '.agenfk', 'migration.json');
    let hadExistingMigration = false;
    let existingMigrationContent: string | null = null;

    const testProject = {
      id: 'migrate-test-proj-001',
      name: 'Migrated Project',
      description: 'From JSON migration',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    beforeAll(async () => {
      // Save and replace any real migration.json
      if (fs.existsSync(migrationPath)) {
        hadExistingMigration = true;
        existingMigrationContent = fs.readFileSync(migrationPath, 'utf8');
      }

      if (fs.existsSync(MIGRATION_DB)) fs.unlinkSync(MIGRATION_DB);

      // Stage a migration.json with a known project
      const agenfkHome = path.join(os.homedir(), '.agenfk');
      if (!fs.existsSync(agenfkHome)) fs.mkdirSync(agenfkHome, { recursive: true });
      fs.writeFileSync(migrationPath, JSON.stringify({
        version: '1',
        backupDate: new Date().toISOString(),
        dbType: 'json',
        projects: [testProject],
        items: [],
      }, null, 2));

      process.env.AGENFK_DB_PATH = MIGRATION_DB;
      await initStorage();
    });

    afterAll(() => {
      // Restore original migration.json state
      if (hadExistingMigration && existingMigrationContent) {
        fs.writeFileSync(migrationPath, existingMigrationContent);
      } else if (fs.existsSync(migrationPath)) {
        fs.unlinkSync(migrationPath);
      }
      if (fs.existsSync(MIGRATION_DB)) fs.unlinkSync(MIGRATION_DB);
    });

    it('should import projects from migration.json into SQLite on startup', async () => {
      const res = await request(app).get('/projects');
      expect(res.status).toBe(200);
      const found = res.body.find((p: any) => p.id === testProject.id);
      expect(found).toBeDefined();
      expect(found.name).toBe('Migrated Project');
    });

    it('should delete migration.json after successful import', async () => {
      // migration.json must be consumed (deleted) after server start
      expect(fs.existsSync(migrationPath)).toBe(false);
    });
  });
});
