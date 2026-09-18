/**
 * The npx bootstrap (bin/agenfk.js) must prune ~/.agenfk-system, and must prune
 * it against the RIGHT tree.
 *
 * `fs.cpSync` and `tar -xzf` are both overlays that delete nothing, so a file
 * dropped upstream survived in the install dir forever and scripts/install.mjs
 * re-installed it into every client's global config on each upgrade. That is
 * how the repo-private /agenfk-release command kept coming back.
 *
 * Three paths, three different correct answers:
 *   - an archive was fetched  -> prune against the ARCHIVE (it is the last writer)
 *   - --rebuild, no archive   -> prune against the npx source tree (it is the last writer)
 *   - the download FAILED     -> prune against NOTHING; the install dir is still
 *                                on the user's existing tag, which may be newer
 *                                than the npx ref (a prerelease). Unauthenticated
 *                                api.github.com is rate-limited at 60/h, so this
 *                                path is routine, and pruning here deleted every
 *                                beta-only command.
 *
 * Offline by construction: PATH holds only the tools each case needs. `curl`
 * and `gh` are absent unless a case deliberately fakes them, and the fakes are
 * shell scripts that never touch the network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, cpSync, rmSync, symlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import { REPO_ROOT } from './helpers/runInstaller';

let work: string;

/** A .git-less copy of the repo: the signal bin/agenfk.js keys isNpxCache off. */
function makeSource(): string {
  const source = path.join(work, `src-${Math.random().toString(36).slice(2)}`);
  for (const dir of ['bin', 'scripts', 'commands']) {
    cpSync(path.join(REPO_ROOT, dir), path.join(source, dir), { recursive: true });
  }
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'agenfk', version: '9.9.9' }), 'utf8');
  return source;
}

/** A previous install carrying a command the new version dropped. */
function makeInstallDir(home: string): string {
  const installDir = path.join(home, '.agenfk-system');
  mkdirSync(path.join(installDir, 'commands'), { recursive: true });
  writeFileSync(path.join(installDir, 'commands', 'agenfk-release.md'), 'stale repo-private\n', 'utf8');
  writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: 'agenfk', version: '0.0.1' }), 'utf8');
  for (const pkg of ['core', 'storage-sqlite', 'telemetry', 'cli', 'server']) {
    mkdirSync(path.join(installDir, 'packages', pkg, 'dist'), { recursive: true });
    writeFileSync(path.join(installDir, 'packages', pkg, 'dist', 'index.js'), 'built\n', 'utf8');
  }
  mkdirSync(path.join(installDir, 'packages', 'cli', 'bin'), { recursive: true });
  writeFileSync(path.join(installDir, 'packages', 'cli', 'bin', 'agenfk.js'), '#!/usr/bin/env node\n', 'utf8');
  return installDir;
}

function makeBin(tools: string[]): string {
  const binDir = mkdtempSync(path.join(work, 'bin-'));
  symlinkSync(process.execPath, path.join(binDir, 'node'));
  for (const tool of tools) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) symlinkSync(found, path.join(binDir, tool));
  }
  return binDir;
}

function run(source: string, home: string, binDir: string, args: string[] = []) {
  return spawnSync(process.execPath, [path.join(source, 'bin', 'agenfk.js'), ...args], {
    encoding: 'utf8',
    timeout: 180_000,
    env: { HOME: home, USERPROFILE: home, PATH: binDir, NODE_ENV: 'production', VITEST: '1' },
  });
}

beforeAll(() => { work = mkdtempSync(path.join(os.tmpdir(), 'agenfk-bootstrap-')); });
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('npx upgrade, --rebuild: prunes against the npx source tree', () => {
  // --rebuild fetches no archive, so the source tree really is the last writer.
  let home: string, installDir: string, r: ReturnType<typeof spawnSync>;
  beforeAll(() => {
    home = mkdtempSync(path.join(work, 'home-'));
    installDir = makeInstallDir(home);
    r = run(makeSource(), home, makeBin(['tar', 'gzip']), ['--rebuild']);
  });

  it('actually ran the update branch (guard)', () => {
    expect(`${r.stdout}${r.stderr}`).toMatch(/Updating AgEnFK at/);
  });

  it('drops a command this version no longer ships', () => {
    expect(existsSync(path.join(installDir, 'commands', 'agenfk-release.md'))).toBe(false);
  });

  it('keeps the commands it does ship', () => {
    expect(existsSync(path.join(installDir, 'commands', 'agenfk.md'))).toBe(true);
  });

  it('keeps the pre-built dist, which the source tree does not carry', () => {
    for (const pkg of ['core', 'storage-sqlite', 'telemetry', 'cli', 'server']) {
      expect(existsSync(path.join(installDir, 'packages', pkg, 'dist', 'index.js'))).toBe(true);
    }
  });

  it('does not re-install the stale command into the global config', () => {
    expect(existsSync(path.join(home, '.claude', 'commands', 'agenfk-release.md'))).toBe(false);
  });
});

describe('npx upgrade, release download FAILS: prunes nothing', () => {
  // Regression. An unauthenticated GitHub rate limit made fetchLatestTag throw,
  // and the source-tree fallback then pruned the user's install against the npx
  // ref — deleting every command their (newer) installed tag adds. Before this
  // change the same run was a harmless no-op overlay, so pruning here was
  // strictly worse than doing nothing.
  let home: string, installDir: string, r: ReturnType<typeof spawnSync>;
  beforeAll(() => {
    home = mkdtempSync(path.join(work, 'home-'));
    installDir = makeInstallDir(home);
    // No curl, no gh: the download throws.
    r = run(makeSource(), home, makeBin(['tar', 'gzip']));
  });

  it('took the download-failure path (guard)', () => {
    expect(`${r.stdout}${r.stderr}`).toMatch(/Failed to download pre-built binary/);
  });

  it('leaves the install dir alone rather than pruning it against the wrong ref', () => {
    expect(existsSync(path.join(installDir, 'commands', 'agenfk-release.md'))).toBe(true);
  });

  it('does not re-install the surviving stale command into the global config', () => {
    // Guard first: an early install.mjs failure would leave the config dir
    // uncreated and make the assertion below pass for the wrong reason.
    expect(existsSync(path.join(home, '.claude', 'commands', 'agenfk.md'))).toBe(true);
    expect(existsSync(path.join(home, '.claude', 'commands', 'agenfk-release.md'))).toBe(false);
  });
});

describe('npx upgrade with an archive: prunes against the ARCHIVE', () => {
  // The archive is the last writer, and it is a DIFFERENT ref from the npx
  // source tree — betas are cut from release branches. Pruning against the
  // source would delete commands the archive ships.
  let home: string, installDir: string, r: ReturnType<typeof spawnSync>;
  beforeAll(() => {
    home = mkdtempSync(path.join(work, 'home-'));
    installDir = makeInstallDir(home);
    const source = makeSource();

    // An archive that ships one command the npx source tree does NOT have.
    const stage = mkdtempSync(path.join(work, 'stage-'));
    mkdirSync(path.join(stage, 'commands'), { recursive: true });
    cpSync(path.join(REPO_ROOT, 'commands'), path.join(stage, 'commands'), { recursive: true });
    writeFileSync(path.join(stage, 'commands', 'agenfk-archive-only.md'), '---\ndescription: x\n---\nonly in the archive\n', 'utf8');
    const tarball = path.join(work, 'fake-dist.tar.gz');
    spawnSync('tar', ['-czf', tarball, '-C', stage, 'commands'], { encoding: 'utf8' });

    // Fake curl + gh: no network, just a tag and a file copy.
    const binDir = makeBin(['tar', 'gzip', 'cp']);
    writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\necho v9.9.9\n', 'utf8');
    chmodSync(path.join(binDir, 'gh'), 0o755);
    writeFileSync(path.join(binDir, 'curl'),
      `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) shift; out="$1";; esac; shift; done\n` +
      `if [ -n "$out" ]; then cp ${JSON.stringify(tarball)} "$out"; else echo '"v9.9.9"'; fi\n`, 'utf8');
    chmodSync(path.join(binDir, 'curl'), 0o755);

    r = run(source, home, binDir);
  });

  it('fetched and extracted the archive (guard)', () => {
    expect(existsSync(path.join(installDir, 'commands', 'agenfk-archive-only.md'))).toBe(true);
  });

  it('keeps a command only the ARCHIVE ships, which a source-tree prune would delete', () => {
    // The whole point: the source tree has no agenfk-archive-only.md.
    expect(existsSync(path.join(installDir, 'commands', 'agenfk-archive-only.md'))).toBe(true);
  });

  it('still drops a command neither the archive nor this version ships', () => {
    expect(existsSync(path.join(installDir, 'commands', 'agenfk-release.md'))).toBe(false);
  });

  it('does not strand the downloaded archive in the install dir', () => {
    expect(existsSync(path.join(installDir, 'agenfk-dist.tar.gz'))).toBe(false);
  });

  it('does not install the stale command into the global config', () => {
    expect(existsSync(path.join(home, '.claude', 'commands', 'agenfk-release.md'))).toBe(false);
  });
});

describe('npx upgrade --rebuild on a NEWER install: prunes nothing', () => {
  // --rebuild fetches no archive, so it reaches the source-tree prune — and the
  // source tree is the npx git ref (the default branch). Deleting the files
  // that ref lacks would strip every command a newer prerelease ships: the same
  // failure the archive fork and the downgrade guard exist to prevent, reached
  // through the one path that skipped both.
  let home: string, installDir: string, r: ReturnType<typeof spawnSync>;
  beforeAll(() => {
    home = mkdtempSync(path.join(work, 'home-'));
    installDir = makeInstallDir(home);
    // Make the LOCAL install newer than the source tree (9.9.9).
    writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: 'agenfk', version: '99.0.0' }), 'utf8');
    r = run(makeSource(), home, makeBin(['tar', 'gzip']), ['--rebuild']);
  });

  it('actually ran the update branch (guard)', () => {
    expect(`${r.stdout}${r.stderr}`).toMatch(/Updating AgEnFK at/);
  });

  it('leaves the newer install alone rather than pruning it against an older ref', () => {
    expect(existsSync(path.join(installDir, 'commands', 'agenfk-release.md'))).toBe(true);
  });
});
