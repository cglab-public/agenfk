import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A release gate, not a docs check: docs/RELEASES.md makes a CHANGELOG entry
 * for the version being cut mandatory, and this is what enforces it. (It used
 * to live in hub-docs-tenancy.test.ts, removed with the docs-text checks in GH-281.)
 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('release self-documentation', () => {
  it('CHANGELOG has an entry for the current version', () => {
    const version: string = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
    expect(fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8')).toContain(`## [${version}]`);
  });
});
