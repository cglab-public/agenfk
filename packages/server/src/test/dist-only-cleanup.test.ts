/**
 * Tests verifying that stale npm and json-db references have been cleaned up
 * after the migration to dist-only installs and SQLite-only storage.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(__dirname, '../../../..');

describe('dist-only cleanup', () => {
  describe('CLI up command should not run npm ci', () => {
    it('packages/cli/src/index.ts up command should not contain npm ci', () => {
      const src = fs.readFileSync(path.join(ROOT, 'packages/cli/src/index.ts'), 'utf8');
      // Extract the 'up' command block — find .command('up') and read until the next .command( or program.
      const upIdx = src.indexOf(".command('up')");
      expect(upIdx).toBeGreaterThan(-1);
      // Find next command registration after 'up'
      const afterUp = src.indexOf("\nprogram", upIdx + 1);
      const upBlock = afterUp > -1 ? src.slice(upIdx, afterUp) : src.slice(upIdx);
      expect(upBlock).not.toContain('npm ci');
      expect(upBlock).not.toContain('npm install');
    });
  });

  describe('start-services.mjs should default to SQLite', () => {
    it('should not default to db.json', () => {
      const src = fs.readFileSync(path.join(ROOT, 'scripts/start-services.mjs'), 'utf8');
      expect(src).not.toContain("'db.json'");
      expect(src).not.toContain('"db.json"');
    });

    it('should default to db.sqlite', () => {
      const src = fs.readFileSync(path.join(ROOT, 'scripts/start-services.mjs'), 'utf8');
      expect(src).toMatch(/db\.sqlite/);
    });
  });

  describe('.sqlite files should not be tracked by git', () => {
    it('.gitignore should contain *.sqlite pattern', () => {
      const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
      expect(gitignore).toContain('*.sqlite');
    });

    it('no .sqlite files should be tracked by git', () => {
      const tracked = execSync('git ls-files "*.sqlite"', { cwd: ROOT, encoding: 'utf8' }).trim();
      expect(tracked).toBe('');
    });
  });
});
