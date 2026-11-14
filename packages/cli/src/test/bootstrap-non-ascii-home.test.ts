/**
 * #349: the npx bootstrap (bin/agenfk.js) must install when HOME and the npx
 * source tree both live under a path with a space and non-ASCII letters (a
 * user named "José Ção"). fs.cpSync aborts the process natively there on
 * Windows + Node 22 (exit 3); the bootstrap now copies with bin/copy-tree.mjs.
 *
 * Offline like bootstrap-prunes-install-dir.test.ts: no curl/gh on PATH, so
 * --rebuild is used and nothing touches the network. The source tree is staged
 * with a plain-JS copy here (no fs.cpSync, no dependency on the helper under
 * test). Green on Node 24; red only where cpSync aborts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, copyFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { REPO_ROOT } from './helpers/runInstaller';
import { fakeBin } from './helpers/fakeBin';

let work: string;
let binRoot: string;

/** Plain recursive copy: the staging must not depend on cpSync or on the helper under test. */
function plainCopy(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) plainCopy(s, d);
    else if (e.isFile()) copyFileSync(s, d);
  }
}

/** A .git-less copy of the repo (the isNpxCache signal), carrying macOS metadata that must be filtered. */
function makeSource(): string {
  const source = path.join(work, `sôurce ção ${Math.random().toString(36).slice(2)}`);
  for (const dir of ['bin', 'scripts', 'commands']) plainCopy(path.join(REPO_ROOT, dir), path.join(source, dir));
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'agenfk', version: '9.9.9' }), 'utf8');
  writeFileSync(path.join(source, 'commands', '._agenfk.md'), 'appledouble\n', 'utf8');
  writeFileSync(path.join(source, 'commands', '.DS_Store'), 'finder\n', 'utf8');
  return source;
}

function run(source: string, home: string) {
  const bin = fakeBin(mkdtempSync(path.join(binRoot, 'bin-')), { node: true, tools: ['tar', 'gzip'] });
  return spawnSync(process.execPath, [path.join(source, 'bin', 'agenfk.js'), '--rebuild'], {
    encoding: 'utf8',
    timeout: 180_000,
    env: bin.env({ HOME: home, USERPROFILE: home, NODE_ENV: 'production', VITEST: '1' }),
  });
}

function listAll(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(p);
    if (e.isDirectory() && e.name !== 'node_modules') listAll(p, out);
  }
  return out;
}

beforeAll(() => {
  work = mkdtempSync(path.join(os.tmpdir(), 'agenfk install hôme ção-'));
  binRoot = mkdtempSync(path.join(os.tmpdir(), 'agenfk-nonascii-bin-'));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(binRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('npx bootstrap under an accented, spaced HOME and source path', () => {
  describe('update (existing ~/.agenfk-system)', () => {
    let installDir: string, r: ReturnType<typeof run>;
    beforeAll(() => {
      const home = path.join(work, 'hôme update');
      installDir = path.join(home, '.agenfk-system');
      mkdirSync(path.join(installDir, 'commands'), { recursive: true });
      writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: 'agenfk', version: '0.0.1' }), 'utf8');
      writeFileSync(path.join(installDir, 'commands', 'keep-extra.md'), 'extra\n', 'utf8');
      r = run(makeSource(), home);
    });

    it('does not abort natively (exit status is not 3)', () => {
      expect(r.status, `${r.stdout}\n${r.stderr}`).not.toBe(3);
    });

    it('ran the update branch (guard)', () => {
      expect(`${r.stdout}${r.stderr}`).toMatch(/Updating AgEnFK at/);
    });

    it('copies the shipped files into the install dir', () => {
      expect(existsSync(path.join(installDir, 'commands', 'agenfk.md'))).toBe(true);
      expect(existsSync(path.join(installDir, 'bin', 'agenfk.js'))).toBe(true);
      expect(readFileSync(path.join(installDir, 'package.json'), 'utf8')).toContain('9.9.9');
    });

    it('filters ._* and .DS_Store out of the install dir', () => {
      const bad = listAll(installDir).filter((p) => path.basename(p).startsWith('._') || path.basename(p) === '.DS_Store');
      expect(bad).toEqual([]);
    });
  });

  describe('fresh install (no ~/.agenfk-system)', () => {
    let installDir: string, r: ReturnType<typeof run>;
    beforeAll(() => {
      const home = path.join(work, 'hôme fresh');
      mkdirSync(home, { recursive: true });
      installDir = path.join(home, '.agenfk-system');
      r = run(makeSource(), home);
    });

    it('does not abort natively (exit status is not 3)', () => {
      expect(r.status, `${r.stdout}\n${r.stderr}`).not.toBe(3);
    });

    it('took the fresh-install branch (guard)', () => {
      expect(`${r.stdout}${r.stderr}`).toMatch(/Installing AgEnFK to/);
    });

    it('creates the install dir with the shipped files', () => {
      expect(statSync(installDir).isDirectory()).toBe(true);
      expect(existsSync(path.join(installDir, 'commands', 'agenfk.md'))).toBe(true);
      expect(existsSync(path.join(installDir, 'bin', 'agenfk.js'))).toBe(true);
    });

    it('filters ._* and .DS_Store out of the install dir', () => {
      const bad = listAll(installDir).filter((p) => path.basename(p).startsWith('._') || path.basename(p) === '.DS_Store');
      expect(bad).toEqual([]);
    });
  });
});
