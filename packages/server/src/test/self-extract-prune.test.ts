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
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, cpSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { defaultSelfExtract } from '../hub/upgradeSync';
import { fakeBin, hostTar } from '../../../cli/src/test/helpers/fakeBin';

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
  spawnSync(hostTar(), ['-czf', tarball, '-C', stage, 'commands', 'bin'], { encoding: 'utf8' });

  // Offline PATH: real tar/gzip, a curl that copies the local archive, and an
  // npm that records that it was invoked instead of installing anything. The
  // stubs are node scripts behind a launcher, so cmd.exe finds them too
  // (`npm.cmd` on Windows, which is what self-extract runs there).
  binDir = fakeBin(path.join(work, 'bin'), {
    tools: ['tar', 'gzip'],
    stubs: {
      curl: `const args = process.argv.slice(2);
require('fs').copyFileSync(${JSON.stringify(tarball)}, args[args.indexOf('-o') + 1]);
`,
      npm: `require('fs').writeFileSync('.npm-was-called', process.argv.slice(2).join(' ') + '\\n');`,
    },
  }).dir;
});

afterAll(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

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

  // GH-281: replaces a regex over upgradeSync.ts's source. A full `npm ci` would
  // pull devDependencies onto an install root; production-only is the contract.
  it('installs production dependencies only: npm ci --omit=dev', () => {
    expect(readFileSync(path.join(root, '.npm-was-called'), 'utf8').trim()).toMatch(/^ci\b.*--omit=dev\b/);
  });
});

describe('self-extract on a developer working tree', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof defaultSelfExtract>>;
  beforeAll(async () => { root = makeRoot('devtree', true); result = await run(root); });

  it('does NOT prune the developer\'s files', () => {
    expect(existsSync(path.join(root, 'commands', 'agenfk-dropped.md'))).toBe(true);
  });

  /*
   * 658ef023 changed this deliberately: a forced recovery over a developer's
   * checkout overwrote its tracked files and dist with the published build,
   * and `npm ci --omit=dev` stripped its devDependencies. It is refused now.
   * These two used to pin the opposite - that it installed and reported
   * success - so they are renamed to what they now hold, not repointed.
   * The concern behind the old ones (BUG bbe794bc: an early return that
   * skipped npm ci yet said ok) still holds: the refusal does not say ok.
   */
  it('does not install dependencies either: npm ci --omit=dev would strip its devDependencies', () => {
    expect(existsSync(path.join(root, '.npm-was-called'))).toBe(false);
  });

  it('reports the refusal, never a success', () => {
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/development checkout/);
  });
});
