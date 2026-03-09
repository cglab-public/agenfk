/**
 * Tests for the db.json → SQLite migration helper.
 * These tests should FAIL before stageJsonMigration() is implemented.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We will import the real module after it exists
let stageJsonMigration: (agenfkHome: string) => boolean;

beforeEach(async () => {
  try {
    const mod = await import('../db-migration.js');
    stageJsonMigration = mod.stageJsonMigration;
  } catch {
    // Module not yet implemented — stageJsonMigration stays undefined
    stageJsonMigration = undefined as any;
  }
});

describe('stageJsonMigration', () => {
  let tmpDir: string;
  const migrationPath = path.join(os.homedir(), '.agenfk', 'migration.json');
  let savedMigration: string | null = null;

  beforeEach(() => {
    // Save real migration.json if it exists
    if (fs.existsSync(migrationPath)) {
      savedMigration = fs.readFileSync(migrationPath, 'utf8');
    }
    // Create a fresh temp dir to act as agenfkHome
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-migration-test-'));
  });

  afterEach(() => {
    // Restore or remove migration.json
    if (savedMigration !== null) {
      fs.writeFileSync(migrationPath, savedMigration);
      savedMigration = null;
    } else if (fs.existsSync(migrationPath)) {
      fs.unlinkSync(migrationPath);
    }
    // Clean temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return false and do nothing when no db.json exists', () => {
    expect(stageJsonMigration).toBeDefined();
    const result = stageJsonMigration(tmpDir);
    expect(result).toBe(false);
    expect(fs.existsSync(migrationPath)).toBe(false);
  });

  it('should return true and write migration.json when db.json exists', () => {
    expect(stageJsonMigration).toBeDefined();

    const dbJsonContent = {
      version: '1',
      projects: [{ id: 'p1', name: 'Test Project' }],
      items: [],
    };
    fs.writeFileSync(path.join(tmpDir, 'db.json'), JSON.stringify(dbJsonContent));

    const result = stageJsonMigration(tmpDir);

    expect(result).toBe(true);
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('should write migration.json with correct projects and items from db.json', () => {
    expect(stageJsonMigration).toBeDefined();

    const dbJsonContent = {
      version: '1',
      projects: [{ id: 'p1', name: 'Proj A' }, { id: 'p2', name: 'Proj B' }],
      items: [{ id: 'item1', title: 'Task 1', projectId: 'p1' }],
    };
    fs.writeFileSync(path.join(tmpDir, 'db.json'), JSON.stringify(dbJsonContent));

    stageJsonMigration(tmpDir);

    const migration = JSON.parse(fs.readFileSync(migrationPath, 'utf8'));
    expect(migration.projects).toHaveLength(2);
    expect(migration.items).toHaveLength(1);
    expect(migration.projects[0].id).toBe('p1');
    expect(migration.items[0].id).toBe('item1');
  });

  it('should not overwrite an existing migration.json', () => {
    expect(stageJsonMigration).toBeDefined();

    // Pre-existing migration.json (e.g. from a previous run)
    const existing = { version: '1', projects: [{ id: 'existing' }], items: [] };
    const agenfkHome = path.join(os.homedir(), '.agenfk');
    if (!fs.existsSync(agenfkHome)) fs.mkdirSync(agenfkHome, { recursive: true });
    fs.writeFileSync(migrationPath, JSON.stringify(existing));

    // db.json exists too
    const newContent = { version: '1', projects: [{ id: 'new' }], items: [] };
    fs.writeFileSync(path.join(tmpDir, 'db.json'), JSON.stringify(newContent));

    stageJsonMigration(tmpDir);

    // Should NOT overwrite — existing migration.json stays
    const after = JSON.parse(fs.readFileSync(migrationPath, 'utf8'));
    expect(after.projects[0].id).toBe('existing');
  });

  it('should handle malformed db.json gracefully (return false)', () => {
    expect(stageJsonMigration).toBeDefined();

    fs.writeFileSync(path.join(tmpDir, 'db.json'), '{ invalid json ');

    const result = stageJsonMigration(tmpDir);
    expect(result).toBe(false);
    expect(fs.existsSync(migrationPath)).toBe(false);
  });
});
