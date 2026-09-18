/**
 * Step 1a: install.mjs prunes the INSTALL DIR against the release archive.
 *
 * It runs BEFORE the steps that install from that tree. Pruning afterwards
 * still lets a stale file reach the client config for a whole upgrade cycle,
 * because steps 8* and 10* enumerate rootDir/commands and rootDir/skills.
 *
 * `agenfk upgrade` and `npx agenfk@latest` both extract agenfk-dist.tar.gz
 * straight over ~/.agenfk-system, and `tar -xzf` deletes nothing — so the
 * install dir keeps every file this version dropped. It also cannot be asked
 * what is current, because it IS the stale thing; the archive listing is the
 * only authority. Hence `--dist-tarball`.
 *
 * This runs the REAL install.mjs. An earlier version of this test hand-rolled
 * the prune in a `node -e` string, which proved nothing about the argv parsing,
 * the existsSync skip, the dynamic import resolving inside the extracted
 * tarball, or the shell interpolation — every one of which fails silently into
 * a "Skipped:" line.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, cpSync, rmSync, symlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import { REPO_ROOT } from './helpers/runInstaller';

let root: string;
let home: string;
let binDir: string;
let tarball: string;
let run: ReturnType<typeof spawnSync>;

beforeAll(() => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'agenfk-1a-'));
  root = path.join(work, 'agenfk-system');
  home = path.join(work, 'home');
  mkdirSync(home, { recursive: true });
  // A flat Gemini TOML leaked by a pre-fix `agenfk skills install`. It must be
  // REMOVED by step 8f — the nested layout is not the only shape on disk.
  mkdirSync(path.join(home, '.gemini', 'commands'), { recursive: true });
  writeFileSync(path.join(home, '.gemini', 'commands', 'agenfk-release.toml'), 'leaked\n', 'utf8');

  // A real install dir: the shipped scripts/ and bin/, and the real commands/.
  for (const dir of ['scripts', 'bin', 'commands']) {
    cpSync(path.join(REPO_ROOT, dir), path.join(root, dir), { recursive: true });
  }
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'agenfk', version: '9.9.9' }), 'utf8');
  for (const pkg of ['core', 'storage-sqlite', 'telemetry', 'cli', 'server']) {
    mkdirSync(path.join(root, 'packages', pkg, 'dist'), { recursive: true });
    writeFileSync(path.join(root, 'packages', pkg, 'dist', 'index.js'), 'built\n', 'utf8');
  }
  mkdirSync(path.join(root, 'packages', 'cli', 'bin'), { recursive: true });
  writeFileSync(path.join(root, 'packages', 'cli', 'bin', 'agenfk.js'), '#!/usr/bin/env node\n', 'utf8');

  // Files an older version left behind, exactly as `tar -xzf` would.
  writeFileSync(path.join(root, 'commands', 'agenfk-longgone.md'), 'stale\n', 'utf8');
  writeFileSync(path.join(root, 'commands', 'agenfk-release.md'), 'stale repo-private\n', 'utf8');

  // The archive: the real commands/, minus the two stale files.
  const stage = path.join(work, 'stage');
  cpSync(path.join(REPO_ROOT, 'commands'), path.join(stage, 'commands'), { recursive: true });
  tarball = path.join(work, 'agenfk-dist.tar.gz');
  spawnSync('tar', ['-czf', tarball, '-C', stage, 'commands'], { encoding: 'utf8' });

  // PATH holds only what step 1a legitimately needs: node, and tar/gzip for the
  // archive listing. curl and gh stay absent, so nothing can reach the network.
  binDir = path.join(work, 'bin');
  mkdirSync(binDir, { recursive: true });
  symlinkSync(process.execPath, path.join(binDir, 'node'));
  for (const tool of ['tar', 'gzip']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) symlinkSync(found, path.join(binDir, tool));
  }

  run = spawnSync(process.execPath,
    [path.join(root, 'scripts', 'install.mjs'), '--rules-scope=global', `--dist-tarball=${tarball}`],
    {
      encoding: 'utf8',
      timeout: 180_000,
      cwd: root,
      env: { HOME: home, USERPROFILE: home, PATH: binDir, NODE_ENV: 'production', VITEST: '1' },
    });
});

afterAll(() => rmSync(path.dirname(root), { recursive: true, force: true }));

describe('install.mjs prunes the install dir against --dist-tarball', () => {
  it('reached the prune step at all (guard: a silent skip makes everything below vacuous)', () => {
    const out = `${run.stdout}${run.stderr}`;
    expect(out).toMatch(/\[1a\/14\]/);
    expect(out).not.toMatch(/\[1a\/14\][\s\S]{0,200}?Skipped/);
  });

  it('removes a command the archive does not carry', () => {
    expect(existsSync(path.join(root, 'commands', 'agenfk-longgone.md'))).toBe(false);
  });

  it('removes the repo-private release command', () => {
    expect(existsSync(path.join(root, 'commands', 'agenfk-release.md'))).toBe(false);
  });

  it('so neither is re-installed into the global client config', () => {
    expect(existsSync(path.join(home, '.claude', 'commands', 'agenfk.md'))).toBe(true); // guard
    expect(existsSync(path.join(home, '.claude', 'commands', 'agenfk-longgone.md'))).toBe(false);
    expect(existsSync(path.join(home, '.claude', 'commands', 'agenfk-release.md'))).toBe(false);
  });

  it('removes a flat Gemini TOML leaked by an earlier install', () => {
    expect(existsSync(path.join(home, '.gemini', 'commands', 'agenfk-release.toml'))).toBe(false);
  });

  it('keeps the commands the archive does carry', () => {
    expect(existsSync(path.join(root, 'commands', 'agenfk.md'))).toBe(true);
  });

  it('never touches paths outside the pruned dirs', () => {
    expect(existsSync(path.join(root, 'packages', 'cli', 'dist', 'index.js'))).toBe(true);
  });
});

describe('step 1a refuses to prune a developer working tree', () => {
  // The ONLY thing between `agenfk upgrade` run from a framework developer's
  // clone and their in-flight commands/, skills/ and *rules/ being deleted
  // against a release archive. Tracked files are recoverable from git;
  // UNTRACKED ones are not.
  let devRoot: string;
  let devRun: ReturnType<typeof spawnSync>;

  beforeAll(() => {
    const devWork = mkdtempSync(path.join(os.tmpdir(), 'agenfk-devguard-'));
    devRoot = path.join(devWork, 'clone');
    for (const dir of ['scripts', 'bin', 'commands']) {
      cpSync(path.join(REPO_ROOT, dir), path.join(devRoot, dir), { recursive: true });
    }
    writeFileSync(path.join(devRoot, 'package.json'), JSON.stringify({ name: 'agenfk', version: '9.9.9' }), 'utf8');
    for (const pkg of ['core', 'storage-sqlite', 'telemetry', 'cli', 'server']) {
      mkdirSync(path.join(devRoot, 'packages', pkg, 'dist'), { recursive: true });
      writeFileSync(path.join(devRoot, 'packages', pkg, 'dist', 'index.js'), 'built\n', 'utf8');
    }
    mkdirSync(path.join(devRoot, 'packages', 'cli', 'bin'), { recursive: true });
    writeFileSync(path.join(devRoot, 'packages', 'cli', 'bin', 'agenfk.js'), '#!/usr/bin/env node\n', 'utf8');
    // What makes it a working tree, and the work that must survive.
    mkdirSync(path.join(devRoot, '.git'), { recursive: true });
    writeFileSync(path.join(devRoot, 'commands', 'agenfk-wip.md'), '---\ndescription: x\n---\nin flight\n', 'utf8');

    const devHome = path.join(devWork, 'home');
    mkdirSync(devHome, { recursive: true });
    devRun = spawnSync(process.execPath,
      [path.join(devRoot, 'scripts', 'install.mjs'), '--rules-scope=global', `--dist-tarball=${tarball}`],
      {
        encoding: 'utf8',
        timeout: 180_000,
        cwd: devRoot,
        env: { HOME: devHome, USERPROFILE: devHome, PATH: binDir, NODE_ENV: 'production', VITEST: '1' },
      });
  });

  it('says it skipped, and why (guard: otherwise the assertion below is vacuous)', () => {
    expect(`${devRun.stdout}${devRun.stderr}`).toMatch(/\[1a\/14\][\s\S]{0,200}?dev checkout detected/);
  });

  it("does not delete the developer's in-flight command", () => {
    expect(existsSync(path.join(devRoot, 'commands', 'agenfk-wip.md'))).toBe(true);
  });
});

describe('install.mjs takes the archive path from AGENFK_DIST_TARBALL', () => {
  // The upgrade callers hold the path in-hand and now pass it in the ENV.
  // Interpolating it into the command string required shell-quoting a filesystem
  // path, and JSON.stringify is not shell quoting: on Windows `C:\Users\...`
  // arrived as `C:\\Users\\...`, the file read as "not found", and the prune was
  // silently skipped — leaving the deleted-upstream file installed.
  let envRoot: string;
  let envHome: string;
  let envRun: ReturnType<typeof spawnSync>;

  beforeAll(() => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'agenfk-env-'));
    envRoot = path.join(work, 'agenfk-system');
    envHome = path.join(work, 'home');
    mkdirSync(envHome, { recursive: true });
    for (const dir of ['scripts', 'bin', 'commands']) {
      cpSync(path.join(REPO_ROOT, dir), path.join(envRoot, dir), { recursive: true });
    }
    writeFileSync(path.join(envRoot, 'package.json'), JSON.stringify({ name: 'agenfk', version: '9.9.9' }), 'utf8');
    for (const pkg of ['core', 'storage-sqlite', 'telemetry', 'cli', 'server']) {
      mkdirSync(path.join(envRoot, 'packages', pkg, 'dist'), { recursive: true });
      writeFileSync(path.join(envRoot, 'packages', pkg, 'dist', 'index.js'), 'built\n', 'utf8');
    }
    mkdirSync(path.join(envRoot, 'packages', 'cli', 'bin'), { recursive: true });
    writeFileSync(path.join(envRoot, 'packages', 'cli', 'bin', 'agenfk.js'), '#!/usr/bin/env node\n', 'utf8');
    writeFileSync(path.join(envRoot, 'commands', 'agenfk-longgone.md'), 'stale\n', 'utf8');
    writeFileSync(path.join(envRoot, 'commands', 'agenfk-release.md'), 'stale repo-private\n', 'utf8');

    envRun = spawnSync(process.execPath,
      [path.join(envRoot, 'scripts', 'install.mjs'), '--rules-scope=global'],
      {
        encoding: 'utf8',
        timeout: 180_000,
        cwd: envRoot,
        env: {
          HOME: envHome, USERPROFILE: envHome, PATH: binDir, NODE_ENV: 'production', VITEST: '1',
          AGENFK_DIST_TARBALL: tarball,
        },
      });
  });

  afterAll(() => rmSync(path.dirname(envRoot), { recursive: true, force: true }));

  it('reached the prune step at all (guard: a silent skip makes the rest vacuous)', () => {
    const out = `${envRun.stdout}${envRun.stderr}`;
    expect(out).toMatch(/\[1a\/14\]/);
    expect(out).not.toMatch(/\[1a\/14\][\s\S]{0,200}?Skipped/);
  });

  it('prunes against the env-provided archive', () => {
    expect(existsSync(path.join(envRoot, 'commands', 'agenfk-longgone.md'))).toBe(false);
    expect(existsSync(path.join(envRoot, 'commands', 'agenfk-release.md'))).toBe(false);
    expect(existsSync(path.join(envRoot, 'commands', 'agenfk.md'))).toBe(true);
  });

  it('so the stale commands never reach the global client config', () => {
    expect(existsSync(path.join(envHome, '.claude', 'commands', 'agenfk-longgone.md'))).toBe(false);
    expect(existsSync(path.join(envHome, '.claude', 'commands', 'agenfk-release.md'))).toBe(false);
  });
});
