/**
 * Tests verifying that storage-json has been fully removed from the project.
 * These tests FAIL while packages/storage-json still exists and should PASS
 * after it has been deleted and all references cleaned up.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

describe('storage-json removal', () => {
  it('packages/storage-json directory should not exist', () => {
    expect(fs.existsSync(path.join(ROOT, 'packages/storage-json'))).toBe(false);
  });

  it('root package.json workspaces should not include storage-json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const workspaces: string[] = pkg.workspaces ?? [];
    const hasStorageJson = workspaces.some((w: string) => w.includes('storage-json'));
    expect(hasStorageJson).toBe(false);
  });

  it('server package.json should not depend on @agenfk/storage-json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/server/package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps['@agenfk/storage-json']).toBeUndefined();
  });

  it('server.ts should not import from @agenfk/storage-json', () => {
    const serverSrc = path.join(ROOT, 'packages/server/src/server.ts');
    if (!fs.existsSync(serverSrc)) return; // dist-only install — skip
    const content = fs.readFileSync(serverSrc, 'utf8');
    expect(content).not.toContain('@agenfk/storage-json');
  });

  it('install.mjs requiredDists should not include storage-json', () => {
    const installScript = path.join(ROOT, 'scripts/install.mjs');
    const content = fs.readFileSync(installScript, 'utf8');
    expect(content).not.toContain("'packages/storage-json/dist'");
    expect(content).not.toContain('"packages/storage-json/dist"');
  });

  it('install.mjs staleSrcDirs should not include storage-json', () => {
    const installScript = path.join(ROOT, 'scripts/install.mjs');
    const content = fs.readFileSync(installScript, 'utf8');
    expect(content).not.toContain("'packages/storage-json/src'");
    expect(content).not.toContain('"packages/storage-json/src"');
  });

  it('package-dist.mjs should not include storage-json', () => {
    const script = path.join(ROOT, 'scripts/package-dist.mjs');
    const content = fs.readFileSync(script, 'utf8');
    expect(content).not.toContain('storage-json');
  });
});
