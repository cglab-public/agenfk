/**
 * Hub fleet self-extract: it prunes the install root against the release
 * archive, and it must ALWAYS complete the install.
 *
 * `tar -xzf` deletes nothing, so files this version dropped survive in the
 * install root and get re-installed into client config on the next run. But the
 * prune is only half the job: BUG bbe794bc requires `npm ci` afterwards, since
 * the tarball ships package.json and the lockfile but not node_modules. A
 * dev-checkout guard that `return`ed early skipped `npm ci` and still reported
 * ok:true — a false success on a server that can then boot missing a module.
 * The only existing guard on that was a regex over this file's source text,
 * which stayed green through the regression.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync, symlinkSync, cpSync } from 'fs';
import os from 'os';
import path from 'path';
import { defaultSelfExtract } from '../hub/upgradeSync';

let work: string;
let binDir: string;
let tarball: string;

beforeAll(() => {
  work = mkdtempSync(path.join(os.tmpdir(), 'agenfk-selfextract-'));

  // An archive shipping one command and bin/, exactly as the real
  // agenfk-dist.tar.gz does (scripts/package-dist.mjs ships bin/ wholesale).
  // bin/ matters: the prune imports sync-install-dir.mjs FROM the install root,
  // so an archive without it silently degrades to "prune skipped".
  const stage = path.join(work, 'stage');
  mkdirSync(path.join(stage, 'commands'), { recursive: true });
  writeFileSync(path.join(stage, 'commands', 'agenfk.md'), 'current\n', 'utf8');
  mkdirSync(path.join(stage, 'bin'), { recursive: true });
  cpSync(path.join(__dirname, '../../../../bin/sync-install-dir.mjs'), path.join(stage, 'bin', 'sync-install-dir.mjs'));
  tarball = path.join(work, 'dist.tar.gz');
  spawnSync('tar', ['-czf', tarball, '-C', stage, 'commands', 'bin'], { encoding: 'utf8' });

  // Offline PATH: real tar/gzip, a curl that copies the local archive, and an
  // npm that records that it was invoked instead of installing anything.
  binDir = path.join(work, 'bin');
  mkdirSync(binDir, { recursive: true });
  for (const tool of ['tar', 'gzip', 'cp', 'sh']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) symlinkSync(found, path.join(binDir, tool));
  }
  writeFileSync(path.join(binDir, 'curl'),
    `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) shift; out="$1";; esac; shift; done\n` +
    `cp ${JSON.stringify(tarball)} "$out"\n`, 'utf8');
  chmodSync(path.join(binDir, 'curl'), 0o755);
  writeFileSync(path.join(binDir, 'npm'), `#!/bin/sh\necho "$@" > "$PWD/.npm-was-called"\n`, 'utf8');
  chmodSync(path.join(binDir, 'npm'), 0o755);
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

function makeRoot(label: string, withGit: boolean): string {
  const root = path.join(work, label);
  mkdirSync(path.join(root, 'commands'), { recursive: true });
  writeFileSync(path.join(root, 'commands', 'agenfk.md'), 'old\n', 'utf8');
  writeFileSync(path.join(root, 'commands', 'agenfk-dropped.md'), 'stale\n', 'utf8');
  if (withGit) mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

async function run(root: string) {
  const savedPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    return await defaultSelfExtract({ installRoot: root, targetVersion: '9.9.9' });
  } finally {
    process.env.PATH = savedPath;
  }
}

describe('self-extract on a normal install root', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof defaultSelfExtract>>;
  beforeAll(async () => { root = makeRoot('install', false); result = await run(root); });

  it('succeeds', () => {
    expect(result).toEqual({ ok: true });
  });

  it('prunes a command the archive no longer carries', () => {
    expect(existsSync(path.join(root, 'commands', 'agenfk-dropped.md'))).toBe(false);
  });

  it('installs dependencies, which makes the recovery complete (BUG bbe794bc)', () => {
    expect(existsSync(path.join(root, '.npm-was-called'))).toBe(true);
  });
});

describe('self-extract on a developer working tree', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof defaultSelfExtract>>;
  beforeAll(async () => { root = makeRoot('devtree', true); result = await run(root); });

  it('does NOT prune the developer\'s files', () => {
    expect(existsSync(path.join(root, 'commands', 'agenfk-dropped.md'))).toBe(true);
  });

  it('STILL installs dependencies — skipping the prune must not skip the install', () => {
    // The regression: an early return here skipped npm ci and reported success.
    expect(existsSync(path.join(root, '.npm-was-called'))).toBe(true);
  });

  it('still reports success', () => {
    expect(result).toEqual({ ok: true });
  });
});
