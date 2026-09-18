/**
 * CGLAB-167: resolving which server bundle the app forks.
 *
 * Pure and fully injected, so both layouts can be exercised without building
 * or packaging anything. The packaged branch especially needs this: until the
 * electron-builder config exists it never runs in anger, and an untested
 * branch that *looks* supported is worse than one that is honestly absent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveDesktopPaths } from '../main/paths.js';

let tmp: string;

/** Build a <root>/server/dist/server.js + <root>/ui/dist tree. */
function stagePackages(root: string): void {
  fs.mkdirSync(path.join(root, 'server', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'dist', 'server.js'), '// server');
  fs.mkdirSync(path.join(root, 'ui', 'dist'), { recursive: true });
}

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-paths-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('resolveDesktopPaths — source checkout', () => {
  it('finds the server entry and ui bundle from dist/main', () => {
    const packages = path.join(tmp, 'packages');
    stagePackages(packages);
    const dirname = path.join(packages, 'desktop', 'dist', 'main');
    fs.mkdirSync(dirname, { recursive: true });

    const resolved = resolveDesktopPaths({ dirname, packaged: false });
    expect(resolved.serverEntry).toBe(path.join(packages, 'server', 'dist', 'server.js'));
    expect(resolved.uiDir).toBe(path.join(packages, 'ui', 'dist'));
  });
});

describe('resolveDesktopPaths — packaged app', () => {
  it('prefers resources/packages when packaged', () => {
    const resources = path.join(tmp, 'Resources');
    stagePackages(path.join(resources, 'packages'));
    // A checkout-shaped path that also exists, to prove precedence is real.
    const packages = path.join(tmp, 'other', 'packages');
    stagePackages(packages);
    const dirname = path.join(packages, 'desktop', 'dist', 'main');
    fs.mkdirSync(dirname, { recursive: true });

    const resolved = resolveDesktopPaths({ dirname, resourcesPath: resources, packaged: true });
    expect(resolved.serverEntry).toBe(path.join(resources, 'packages', 'server', 'dist', 'server.js'));
  });

  it('falls back to the checkout layout when resources has no bundle', () => {
    const packages = path.join(tmp, 'packages');
    stagePackages(packages);
    const dirname = path.join(packages, 'desktop', 'dist', 'main');
    fs.mkdirSync(dirname, { recursive: true });

    const resolved = resolveDesktopPaths({
      dirname,
      resourcesPath: path.join(tmp, 'empty-resources'),
      packaged: true,
    });
    expect(resolved.serverEntry).toBe(path.join(packages, 'server', 'dist', 'server.js'));
  });
});

describe('resolveDesktopPaths — nothing found', () => {
  it('throws an error naming every location it searched', () => {
    const dirname = path.join(tmp, 'packages', 'desktop', 'dist', 'main');
    fs.mkdirSync(dirname, { recursive: true });

    let message = '';
    try {
      resolveDesktopPaths({ dirname, packaged: false });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/server bundle not found/i);
    expect(message).toContain(path.join(tmp, 'packages'));
    expect(message).toMatch(/npm run build/);
  });
});
