/**
 * @file GitHub #208 — `npx agenfk` (packages/create) extracts with the tar it meets.
 *
 * packages/create is the published `agenfk` package: one file, which cannot
 * reach bin/tar-flags.mjs once published, so it carries its own copy of the
 * rule. It ran `tar -xzf "C:\..." -C "C:\..."` on every OS. That suits the
 * bsdtar Windows ships, but GNU tar (Git Bash's) reads `C:` as a remote host
 * and unescapes backslashes in -C (`...\Temp\tf-x` becomes a TAB), so from a
 * Git Bash prompt the download could never be extracted. GNU tar on Windows
 * now gets --force-local and forward slashes; everyone else the command as it
 * always was.
 *
 * The file runs the installer when executed, so the rule is read from a child
 * that only `require`s it - with no git on PATH, so a file that still runs on
 * require stops at its git check instead of installing anything.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { REPO_ROOT } from './helpers/runInstaller';
import { fakeBin, hostTar } from './helpers/fakeBin';

const CREATE = path.join(REPO_ROOT, 'packages', 'create', 'bin', 'agenfk.js');
const GNU = 'tar (GNU tar) 1.35\n';
const BSD = 'bsdtar 3.8.8 - libarchive 3.8.8 zlib/1.2.13.1-motley\n';

let work: string;
beforeAll(() => { work = mkdtempSync(path.join(os.tmpdir(), 'agenfk-create-tar-')); });
afterAll(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

/** Evaluate `expr` against the module's exports in a child that only requires it. */
function fromModule(expr: string): unknown {
  const home = mkdtempSync(path.join(work, 'home-'));
  const bin = fakeBin(mkdtempSync(path.join(work, 'bin-')), { node: true });
  const r = spawnSync(process.execPath, ['-e', `const m = require(${JSON.stringify(CREATE)}); process.stdout.write(JSON.stringify(${expr}));`], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: bin.env({ HOME: home, USERPROFILE: home }),
  });
  expect(r.status, `${r.stdout}${r.stderr}`.slice(-2000)).toBe(0);
  return JSON.parse(r.stdout);
}

describe('packages/create: requiring it runs nothing', () => {
  it('prints nothing and exports the tar rule when required rather than executed', () => {
    expect(fromModule(`Object.keys(m).sort()`)).toEqual(['isGnuTar', 'tarExtractCommand']);
  });
});

describe('packages/create: the extract command follows the tar', () => {
  it('knows GNU tar from bsdtar by --version', () => {
    expect(fromModule(`[m.isGnuTar(${JSON.stringify(GNU)}), m.isGnuTar(${JSON.stringify(BSD)}), m.isGnuTar('')]`)).toEqual([true, false, false]);
  });

  it('bsdtar on Windows: native paths, no --force-local (it rejects the flag)', () => {
    expect(fromModule(`m.tarExtractCommand('win32', ${JSON.stringify(BSD)}, 'C:\\\\Users\\\\u\\\\.agenfk-system\\\\agenfk-dist.tar.gz', 'C:\\\\Users\\\\u\\\\.agenfk-system')`))
      .toBe('tar -xzf "C:\\Users\\u\\.agenfk-system\\agenfk-dist.tar.gz" -C "C:\\Users\\u\\.agenfk-system"');
  });

  it('GNU tar on Windows: --force-local, and forward slashes it will not unescape', () => {
    expect(fromModule(`m.tarExtractCommand('win32', ${JSON.stringify(GNU)}, 'C:\\\\Users\\\\u\\\\.agenfk-system\\\\agenfk-dist.tar.gz', 'C:\\\\Users\\\\u\\\\.agenfk-system')`))
      .toBe('tar --force-local -xzf "C:/Users/u/.agenfk-system/agenfk-dist.tar.gz" -C "C:/Users/u/.agenfk-system"');
  });

  it('off Windows: the command exactly as before, whatever the tar', () => {
    for (const v of [GNU, BSD]) {
      expect(fromModule(`m.tarExtractCommand('linux', ${JSON.stringify(v)}, '/home/u/.agenfk-system/agenfk-dist.tar.gz', '/home/u/.agenfk-system')`))
        .toBe('tar -xzf "/home/u/.agenfk-system/agenfk-dist.tar.gz" -C "/home/u/.agenfk-system"');
    }
  });
});

describe('npx agenfk (packages/create) extracts the release with the tar on PATH', () => {
  let home: string, installDir: string, r: ReturnType<typeof spawnSync>;
  beforeAll(() => {
    // The archive's install.mjs only records that it ran from the extracted tree.
    const stage = mkdtempSync(path.join(work, 'stage-'));
    mkdirSync(path.join(stage, 'scripts'), { recursive: true });
    writeFileSync(path.join(stage, 'scripts', 'install.mjs'), `import fs from 'fs';\nfs.writeFileSync('extracted-install-ran', 'yes');\n`, 'utf8');
    const tarball = path.join(work, 'agenfk-dist.tar.gz');
    const made = spawnSync(hostTar(), ['-czf', tarball, '-C', stage, 'scripts'], { encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);

    // An existing, non-git install on an old version: the update branch downloads.
    home = mkdtempSync(path.join(work, 'home-'));
    installDir = path.join(home, '.agenfk-system');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: 'agenfk', version: '0.0.1' }));

    const bin = fakeBin(mkdtempSync(path.join(work, 'bin-')), {
      node: true,
      tools: ['tar', 'gzip', 'git'],
      stubs: {
        curl: `const args = process.argv.slice(2);
const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : '';
if (out) require('fs').copyFileSync(${JSON.stringify(tarball)}, out);
else console.log('[{"tag_name":"v9.9.9","prerelease":false,"published_at":"2026-01-01T00:00:00Z"}]');
`,
      },
    });
    r = spawnSync(process.execPath, [CREATE], {
      encoding: 'utf8', timeout: 60_000, windowsHide: true,
      env: bin.env({ HOME: home, USERPROFILE: home, NODE_ENV: 'production', VITEST: '1' }),
    });
  });

  it('extracted the archive and ran the install it carries', () => {
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/Failed to update pre-built binary/);
    expect(readFileSync(path.join(installDir, 'extracted-install-ran'), 'utf8')).toBe('yes');
    expect(r.status).toBe(0);
  });

  it('does not leave the archive behind', () => {
    expect(existsSync(path.join(installDir, 'agenfk-dist.tar.gz'))).toBe(false);
  });
});
