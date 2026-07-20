/**
 * Tests verifying that stale npm and json-db references have been cleaned up
 * after the migration to dist-only installs and SQLite-only storage.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(__dirname, '../../../..');

// NB: source-string guards asserting the CLI `up` command contains no `npm ci`
// and that start-services.mjs no longer defaults to db.json were removed in the
// behaviour-based-testing conversion (CGLAB-16) — they grepped script/CLI source
// for the absence/presence of strings rather than exercising behaviour. The
// dist-only install and SQLite-default behaviour is covered by the CLI/install
// suites. The git-tracking assertions below inspect real artifacts (.gitignore
// and the actual git index) and are kept.

describe('dist-only cleanup', () => {
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
