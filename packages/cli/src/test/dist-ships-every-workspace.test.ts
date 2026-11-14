/**
 * Issue #232 — the dist must ship the package.json of every workspace.
 *
 * The root package.json lists packages/create and packages/desktop as
 * workspaces and package-lock.json carries them, but agenfk-dist.tar.gz did
 * not ship their package.json. A copy left in ~/.agenfk-system by an earlier
 * source install was then never refreshed, kept depending on an old
 * @agenfk/core, and `npm ci` went to the registry for it and failed (E404).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { DIST_INCLUDE } from '../../../../scripts/dist-manifest.mjs';

const ROOT = path.resolve(__dirname, '../../../..');
const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

describe('agenfk-dist ships every workspace manifest (#232)', () => {
  it('lists the package.json of every root workspace', () => {
    const workspaces: string[] = rootPkg.workspaces;
    expect(workspaces.length).toBeGreaterThan(0);
    const missing = workspaces.filter((ws) => !DIST_INCLUDE.includes(`${ws}/package.json`));
    expect(missing).toEqual([]);
  });

  it('ships the root manifest and lockfile that npm ci reads', () => {
    expect(DIST_INCLUDE).toContain('package.json');
    expect(DIST_INCLUDE).toContain('package-lock.json');
  });
});
