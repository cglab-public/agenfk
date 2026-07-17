/**
 * TDD for hub-only releases (CGLAB-8).
 *
 * Contract: global `v*` tags keep releasing everything (framework dist already
 * ships the hub — asserted here too so decoupling never silently drops it), and
 * `hub-v*` tags release ONLY the hub: GHCR Docker image (pre-existing) plus a
 * GitHub Release carrying a hub-only dist tarball for the non-Docker path.
 *
 * Follows the dist-ships-uninstaller.test.ts pattern: assert on the include
 * list of the packaging script and on the workflow file, so a refactor that
 * drops an artifact fails CI instead of shipping a broken release.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

// Literal-extraction helper à la dist-ships-uninstaller.test.ts, hardened:
// `//` comments are stripped first so an apostrophe inside a comment (e.g.
// "doesn't") can't unbalance the quote pairing and silently drop entries.
function parseIncludeList(src: string): string[] {
  const start = src.indexOf('const include = [');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('];', start);
  expect(end).toBeGreaterThan(start);
  const block = src
    .slice(start, end)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return [...block.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

describe('scripts/package-hub-dist.mjs — hub-only distributable', () => {
  it('exists', () => {
    expect(existsSync(path.join(ROOT, 'scripts', 'package-hub-dist.mjs'))).toBe(true);
  });

  it('ships the hub runtime, its UI, and the workspace deps the hub needs', () => {
    const include = parseIncludeList(read('scripts/package-hub-dist.mjs'));
    for (const entry of [
      'package.json',
      'package-lock.json',
      'packages/hub/package.json',
      'packages/hub/dist/',
      'packages/hub-ui/package.json',
      'packages/hub-ui/dist/',
      // @agenfk/hub depends on @agenfk/core at runtime.
      'packages/core/package.json',
      'packages/core/dist/',
    ]) {
      expect(include).toContain(entry);
    }
  });

  it('produces agenfk-hub-dist.tar.gz (the asset name the workflow uploads)', () => {
    expect(read('scripts/package-hub-dist.mjs')).toContain('agenfk-hub-dist.tar.gz');
  });

  it('does NOT ship framework-only surfaces (cli/server/rules) in the hub tarball', () => {
    const include = parseIncludeList(read('scripts/package-hub-dist.mjs'));
    for (const entry of ['packages/cli/dist/', 'packages/server/dist/', 'clauderules/', 'commands/']) {
      expect(include).not.toContain(entry);
    }
  });
});

describe('.github/workflows/hub-image.yml — hub-v* releases only the hub', () => {
  const wf = () => read('.github/workflows/hub-image.yml');

  it('still triggers on hub-v* tags', () => {
    expect(wf()).toContain("'hub-v*'");
  });

  it('packages the hub dist tarball and attaches it to a GitHub Release', () => {
    expect(wf()).toContain('package-hub-dist.mjs');
    expect(wf()).toContain('gh release create');
    expect(wf()).toContain('agenfk-hub-dist.tar.gz');
  });

  it('keeps pushing the GHCR image (existing behaviour preserved)', () => {
    expect(wf()).toContain('packages/hub/Dockerfile');
    expect(wf()).toContain('agenfk-hub:');
  });
});

describe('global releases still include the hub (framework tarball unchanged)', () => {
  it('scripts/package-dist.mjs keeps shipping hub + hub-ui', () => {
    const include = parseIncludeList(read('scripts/package-dist.mjs'));
    for (const entry of [
      'packages/hub/package.json',
      'packages/hub/dist/',
      'packages/hub-ui/package.json',
      'packages/hub-ui/dist/',
    ]) {
      expect(include).toContain(entry);
    }
  });
});
