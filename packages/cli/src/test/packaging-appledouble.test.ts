/**
 * CGLAB-94 / issue #163 — the release tarball must never carry macOS
 * AppleDouble (`._*`) resource-fork metadata or `.DS_Store`.
 *
 * Every published release from at least v1.1.13 through v1.1.16-beta.4 was
 * roughly half AppleDouble (436 of 872 members in v1.1.16-beta.3) because
 * scripts/package-dist.mjs ran a bare `tar -czf` on macOS, where bsdtar emits a
 * `._<name>` companion for every file carrying an extended attribute.
 *
 * Behaviour-based: build a real archive from a fixture tree with the same
 * helper the release scripts use, then read the members back without `tar -t`
 * (see helpers/tarEntries — macOS tar hides exactly the members under test).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { createTarball } from '../../../../scripts/package-helpers.mjs';
import { tarEntryNames, appleDoubleEntries } from './helpers/tarEntries';

describe('release packaging — excludes macOS metadata', () => {
  let dir: string;
  let out: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'agenfk-pack-'));
    mkdirSync(path.join(dir, 'commands'), { recursive: true });
    writeFileSync(path.join(dir, 'commands', 'agenfk.md'), '# real payload\n');
    // Artifacts a polluted working tree (or a previously-extracted polluted
    // tarball) leaves lying around. These must never enter the archive.
    writeFileSync(path.join(dir, 'commands', '._agenfk.md'), 'AppleDouble junk');
    writeFileSync(path.join(dir, 'commands', '.DS_Store'), 'finder junk');
    out = path.join(dir, 'out.tar.gz');
    createTarball({ cwd: dir, outFile: 'out.tar.gz', include: ['commands/'] });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('includes the real payload', () => {
    expect(tarEntryNames(out).some((n) => n.endsWith('commands/agenfk.md'))).toBe(true);
  });

  it('excludes ._* files that are physically present in the source tree', () => {
    expect(appleDoubleEntries(out)).toEqual([]);
  });

  it('carries no xattr PAX headers (GNU tar warns once per file for each)', () => {
    expect(tarEntryNames(out).filter((n) => n.includes('PaxHeader'))).toEqual([]);
  });

  it('excludes .DS_Store', () => {
    const base = tarEntryNames(out).map((n) => n.split('/').pop());
    expect(base).not.toContain('.DS_Store');
  });

  // The regression that actually shipped: files carrying an extended attribute
  // make bsdtar synthesise an AppleDouble member that never existed on disk.
  // Only reproducible on macOS, which is where releases are cut.
  it.runIf(process.platform === 'darwin')(
    'emits no AppleDouble member for files carrying extended attributes',
    () => {
      const xattrDir = mkdtempSync(path.join(os.tmpdir(), 'agenfk-xattr-'));
      try {
        mkdirSync(path.join(xattrDir, 'commands'), { recursive: true });
        const f = path.join(xattrDir, 'commands', 'agenfk.md');
        writeFileSync(f, '# real payload\n');
        const set = spawnSync('xattr', ['-w', 'com.apple.provenance', 'x', f], { encoding: 'utf8' });
        expect(set.status, 'could not seed an xattr; test would be vacuous').toBe(0);

        // Guard against the test itself going vacuous: prove a bare tar DOES
        // synthesise the artifact here, so the assertion below has teeth.
        spawnSync('tar', ['-czf', 'bare.tar.gz', 'commands/'], { cwd: xattrDir });
        expect(appleDoubleEntries(path.join(xattrDir, 'bare.tar.gz')).length).toBeGreaterThan(0);

        createTarball({ cwd: xattrDir, outFile: 'out.tar.gz', include: ['commands/'] });
        const tgz = path.join(xattrDir, 'out.tar.gz');
        expect(existsSync(tgz)).toBe(true);
        expect(appleDoubleEntries(tgz)).toEqual([]);
      } finally {
        rmSync(xattrDir, { recursive: true, force: true });
      }
    }
  );
});
