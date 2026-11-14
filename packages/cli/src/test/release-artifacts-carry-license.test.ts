/**
 * Issue #257 — AgEnFK is licensed under Apache-2.0, and section 4(a) of that
 * license requires a copy of it with every distribution. The release tarballs
 * carried the identifier in package.json but not the license text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { DIST_INCLUDE } from '../../../../scripts/dist-manifest.mjs';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

// Same extraction as hub-release-dist.test.ts: comments stripped first.
function hubIncludeList(): string[] {
  const src = read('scripts/package-hub-dist.mjs');
  const start = src.indexOf('const include = [');
  const end = src.indexOf('];', start);
  expect(start).toBeGreaterThan(-1);
  const block = src.slice(start, end).split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  return [...block.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

describe('release artifacts carry the Apache-2.0 license (#257)', () => {
  it('the root LICENSE is the Apache License 2.0', () => {
    expect(read('LICENSE')).toMatch(/Apache License\s+Version 2\.0, January 2004/);
  });

  it('agenfk-dist.tar.gz ships LICENSE', () => {
    expect(DIST_INCLUDE).toContain('LICENSE');
  });

  it('agenfk-hub-dist.tar.gz ships LICENSE', () => {
    expect(hubIncludeList()).toContain('LICENSE');
  });

  it('every workspace package declares Apache-2.0', () => {
    const packagesDir = path.join(ROOT, 'packages');
    const undeclared = readdirSync(packagesDir)
      .filter((name) => existsSync(path.join(packagesDir, name, 'package.json')))
      .filter((name) => JSON.parse(read(`packages/${name}/package.json`)).license !== 'Apache-2.0');
    expect(undeclared).toEqual([]);
    expect(JSON.parse(read('package.json')).license).toBe('Apache-2.0');
  });
});
