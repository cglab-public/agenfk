/**
 * d781db05 — every build starts from an empty dist/.
 *
 * tsc emits into dist/ and never deletes the output of a source that was
 * removed. After the claims removal (26c059f6) packages/core/dist still held
 * claims.js and claimGate.js, and the desktop build packaged them into
 * app.asar; a release tarball would have carried them too. So each package
 * that builds with tsc into dist/ cleans it first, in a `prebuild` - which npm
 * runs for the root build and for `npm run build -w <package>` alike.
 *
 * The clean runs against temporary directories here, never the repository's
 * own dist/ folders: other test files import from them.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CLEAN = path.join(REPO_ROOT, 'scripts', 'clean-dist.mjs');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-clean-dist-'));
  dirs.push(d);
  return d;
}
function write(dir: string, rel: string, body = 'x'): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
}

/** Packages whose build runs tsc and whose tsconfig emits into ./dist. */
function tscDistPackages(): string[] {
  const root = path.join(REPO_ROOT, 'packages');
  return fs.readdirSync(root).filter(name => {
    const pkgFile = path.join(root, name, 'package.json');
    const tsconfig = path.join(root, name, 'tsconfig.json');
    if (!fs.existsSync(pkgFile) || !fs.existsSync(tsconfig)) return false;
    const build: string = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).scripts?.build ?? '';
    const outDir = /"outDir"\s*:\s*"\.?\/?dist"/.test(fs.readFileSync(tsconfig, 'utf8'));
    return /^tsc(\s|$|&)/.test(build) && outDir;
  });
}

describe('which packages clean before they build', () => {
  it('finds the tsc packages, so the check below cannot pass on an empty list', () => {
    expect(tscDistPackages()).toEqual(expect.arrayContaining(['cli', 'core', 'desktop', 'hub', 'server', 'storage-sqlite', 'telemetry']));
  });

  it('gives every one of them a prebuild that runs the shared clean script', () => {
    const missing = tscDistPackages().filter(name => {
      const dir = path.join(REPO_ROOT, 'packages', name);
      const prebuild: string = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts?.prebuild ?? '';
      const script = /node\s+(\S*clean-dist\.mjs)/.exec(prebuild)?.[1];
      return !script || path.resolve(dir, script) !== CLEAN;
    });
    expect(missing, `these packages build with tsc into dist/ without cleaning it first: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('Dockerfiles that build a package', () => {
  /*
   * A Docker build copies packages one by one, and the prebuild runs
   * ../../scripts/clean-dist.mjs: an image that builds without copying it dies
   * on MODULE_NOT_FOUND. The hub image (and with it every hub release) and the
   * e2e harness both did, found by review before they shipped.
   */
  const dockerfiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'release') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/^Dockerfile(\..+)?$/.test(e.name)) out.push(p);
      }
    };
    walk(REPO_ROOT);
    return out;
  };

  it('finds the Dockerfiles, so the check below cannot pass on an empty list', () => {
    const rel = dockerfiles().map(f => path.relative(REPO_ROOT, f));
    expect(rel).toEqual(expect.arrayContaining([path.join('packages', 'hub', 'Dockerfile'), path.join('e2e', 'tdd-harness', 'Dockerfile')]));
  });

  it('copy the clean script before their first npm run build', () => {
    const missing = dockerfiles().filter(f => {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      const build = lines.findIndex(l => /npm run build/.test(l));
      if (build < 0) return false;
      const copy = lines.findIndex(l => /^\s*COPY\s+(\S*\s+)*scripts(\/clean-dist\.mjs)?\/?\s+/.test(l));
      return copy < 0 || copy > build;
    }).map(f => path.relative(REPO_ROOT, f));
    expect(missing, `these Dockerfiles build without scripts/clean-dist.mjs: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('scripts/clean-dist.mjs', () => {
  const run = (cwd: string) => spawnSync(process.execPath, [CLEAN], { cwd, encoding: 'utf8' });

  it('removes dist/ with everything in it, an orphan from a deleted source included', () => {
    const pkg = tmp();
    write(pkg, 'dist/claimGate.js');
    write(pkg, 'dist/test/claims.test.js');
    const r = run(pkg);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(pkg, 'dist'))).toBe(false);
  });

  it('touches nothing but dist/ itself', () => {
    const pkg = tmp();
    write(pkg, 'dist/index.js');
    write(pkg, 'src/index.ts');
    write(pkg, 'src/dist/keep.ts');
    write(pkg, 'dist-keep.txt');
    write(pkg, 'package.json', '{}');
    expect(run(pkg).status).toBe(0);
    for (const kept of ['src/index.ts', 'src/dist/keep.ts', 'dist-keep.txt', 'package.json']) {
      expect(fs.existsSync(path.join(pkg, kept)), `${kept} was removed`).toBe(true);
    }
  });

  it('succeeds when there is no dist/ yet, as on a fresh clone', () => {
    const r = run(tmp());
    expect(r.status, r.stderr).toBe(0);
  });

  it('runs as npm prebuild: a stale file does not survive the build', () => {
    // The real wiring, on a throwaway package: npm runs prebuild, then build.
    const pkg = tmp();
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'clean-dist-probe', version: '0.0.0', private: true,
      scripts: {
        prebuild: `node ${JSON.stringify(CLEAN)}`,
        build: `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.js','fresh')"`,
      },
    }));
    write(pkg, 'dist/stale.js', 'from a deleted source');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(npm, ['run', 'build', '--silent'], { cwd: pkg, encoding: 'utf8', shell: process.platform === 'win32' });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(pkg, 'dist', 'stale.js')), 'the stale file survived the build').toBe(false);
    expect(fs.readFileSync(path.join(pkg, 'dist', 'index.js'), 'utf8')).toBe('fresh');
  });
});
