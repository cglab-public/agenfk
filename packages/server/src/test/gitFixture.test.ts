/**
 * The per-worker template behind fixture git repos (#311): what a spec may
 * rely on when it asks for a repo, and what the template saves it - spawns.
 *
 * Every child process the helper could start goes through the recorder below,
 * whichever specifier it imports (`child_process` or `node:child_process`), so
 * "no spawn" is an observation, not a hope. The recorder's own wiring is proven
 * first by a build that does spawn.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { execFileSync as nodeExecFileSync } from 'node:child_process';

const spawns = vi.hoisted(() => ({ calls: [] as { fn: string; args: unknown[] }[] }));

const recordChildProcess = vi.hoisted(() => async (importOriginal: () => Promise<unknown>) => {
  const real = (await importOriginal()) as Record<string, (...a: unknown[]) => unknown>;
  const names = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'] as const;
  const wrapped: Record<string, (...a: unknown[]) => unknown> = {};
  for (const fn of names) {
    wrapped[fn] = (...args: unknown[]) => {
      spawns.calls.push({ fn, args });
      return real[fn](...args);
    };
  }
  return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});
vi.mock('child_process', (importOriginal) => recordChildProcess(importOriginal));
vi.mock('node:child_process', (importOriginal) => recordChildProcess(importOriginal));

import { cloneGitTemplate, gitTemplate, gitTemplateRoot, type GitTemplateBuild } from './helpers/gitFixture';

/** Per file run, so a key never meets a template another file left in this worker's cache. */
const NONCE = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const key = (name: string) => `gitFixture.test:${name}:${NONCE}`;

const made: string[] = [];
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const clone = (k: string, build: GitTemplateBuild, prefix?: string) => {
  const dir = cloneGitTemplate(k, build, prefix);
  made.push(dir);
  return dir;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

/** The template is read-only for callers: plain `git status` would refresh (rewrite) its index. */
const gitNoLocks = (cwd: string, ...args: string[]) => git(cwd, '--no-optional-locks', ...args);

/** The worker's HOME as the setup file pinned it, before any test re-points it. */
const WORKER_HOME = process.env.HOME;

/** A one-commit repo; `marker` makes the content (and so the commit) differ per key. */
const repoBuild = (marker: string): GitTemplateBuild => (dir) => {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false'); // quiet the LF/CRLF warnings on Windows; content is LF either way
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'impl.json'), JSON.stringify({ marker }));
  fs.writeFileSync(path.join(dir, 'README.md'), `fixture ${marker}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'one');
};

/** The same directory, compared the way git and the server compare it: slashes and (on win32) case folded. */
const samePath = (a: string, b: string) => {
  const norm = (p: string) => {
    const r = path.resolve(p).replace(/\\/g, '/');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
};

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

beforeEach(() => { spawns.calls.length = 0; });

describe('a clone is a real, independent repository', () => {
  it('is clean, has a HEAD and its own .git, and writes in one clone reach neither the other clone nor the template', () => {
    const k = key('independent');
    const build = repoBuild('independent');
    const a = clone(k, build);
    const b = clone(k, build);
    const template = gitTemplate(k, build);

    expect(a).not.toBe(b);
    expect(samePath(a, template)).toBe(false);
    expect(samePath(b, template)).toBe(false);

    for (const dir of [a, b]) {
      expect(git(dir, 'status', '--porcelain')).toBe('');
      expect(git(dir, 'rev-parse', 'HEAD')).toMatch(/^[0-9a-f]{40}$/);
      expect(git(dir, 'config', 'user.email')).toBe('t@t');
      // Its own repository, not a gitfile/worktree/alternate pointing back at the template.
      expect(fs.statSync(path.join(dir, '.git')).isDirectory()).toBe(true);
      expect(samePath(git(dir, 'rev-parse', '--absolute-git-dir'), path.join(dir, '.git'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    }
    expect(fs.readFileSync(path.join(a, 'src', 'impl.json'), 'utf8')).toBe(JSON.stringify({ marker: 'independent' }));

    const headBefore = git(b, 'rev-parse', 'HEAD');
    const templateIndexMtime = fs.statSync(path.join(template, '.git', 'index')).mtimeMs;
    fs.writeFileSync(path.join(a, 'only-in-a.txt'), 'a\n');
    fs.writeFileSync(path.join(a, 'README.md'), 'changed in a\n');
    git(a, 'add', '.');
    git(a, 'commit', '-qm', 'two');
    fs.writeFileSync(path.join(a, 'untracked-in-a.txt'), 'u\n');

    expect(git(a, 'rev-parse', 'HEAD')).not.toBe(headBefore);
    for (const other of [b, template]) {
      expect(fs.existsSync(path.join(other, 'only-in-a.txt'))).toBe(false);
      expect(fs.existsSync(path.join(other, 'untracked-in-a.txt'))).toBe(false);
      expect(fs.readFileSync(path.join(other, 'README.md'), 'utf8')).toBe('fixture independent\n');
      expect(git(other, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(gitNoLocks(other, 'status', '--porcelain')).toBe('');
    }
    // Nothing above wrote to the template (the check itself took no optional locks).
    expect(fs.statSync(path.join(template, '.git', 'index')).mtimeMs).toBe(templateIndexMtime);

    // A clone made after the writes still starts from the template, not from clone A.
    const c = clone(k, build);
    expect(git(c, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(fs.existsSync(path.join(c, 'only-in-a.txt'))).toBe(false);
  });

  it('shares the template commit SHA - the property phase 2 audits specs for', () => {
    const k = key('shared-sha');
    const build = repoBuild('shared-sha');
    const a = clone(k, build);
    const b = clone(k, build);
    expect(git(a, 'rev-parse', 'HEAD')).toBe(git(b, 'rev-parse', 'HEAD'));
  });

  it('keeps the template files\' modification times (preserveTimestamps)', () => {
    const k = key('mtimes');
    const build = repoBuild('mtimes');
    const template = gitTemplate(k, build);
    const a = clone(k, build);
    // Within a millisecond: utimes on Windows keeps 100 ns ticks, not every bit of a double mtimeMs.
    // Without preserveTimestamps the copy is stamped "now" - after a build of several spawns, far more than 1 ms.
    for (const rel of ['README.md', path.join('src', 'impl.json'), path.join('.git', 'index'), path.join('.git', 'HEAD')]) {
      const drift = Math.abs(fs.statSync(path.join(a, rel)).mtimeMs - fs.statSync(path.join(template, rel)).mtimeMs);
      expect(drift, rel).toBeLessThan(1);
    }
  });

  it('is named with the requested prefix', () => {
    const k = key('prefix');
    const build = repoBuild('prefix');
    expect(path.basename(clone(k, build, 'agenfk-prefix-probe-'))).toMatch(/^agenfk-prefix-probe-/);
    expect(path.basename(clone(k, build))).toMatch(/^agenfk-git-fixture-/);
  });
});

describe('the build runs once per key per worker', () => {
  it('builds a key once however many clones are made, and each key separately', () => {
    const buildA = vi.fn(repoBuild('key-a'));
    const buildB = vi.fn(repoBuild('key-b'));
    const ka = key('once-a');
    const kb = key('once-b');

    const a1 = clone(ka, buildA);
    const a2 = clone(ka, buildA);
    const a3 = clone(ka, buildA);
    expect(buildA).toHaveBeenCalledTimes(1);
    expect(buildB).not.toHaveBeenCalled();

    const b1 = clone(kb, buildB);
    clone(kb, buildB);
    expect(buildA).toHaveBeenCalledTimes(1);
    expect(buildB).toHaveBeenCalledTimes(1);

    // Each key built its own content: the keys did not share one template.
    for (const d of [a1, a2, a3]) expect(fs.readFileSync(path.join(d, 'src', 'impl.json'), 'utf8')).toBe(JSON.stringify({ marker: 'key-a' }));
    expect(fs.readFileSync(path.join(b1, 'src', 'impl.json'), 'utf8')).toBe(JSON.stringify({ marker: 'key-b' }));
    expect(git(a1, 'rev-parse', 'HEAD')).not.toBe(git(b1, 'rev-parse', 'HEAD'));

    // gitTemplate shares the cache with cloneGitTemplate.
    expect(fs.existsSync(path.join(gitTemplate(ka, buildA), '.git'))).toBe(true);
    expect(buildA).toHaveBeenCalledTimes(1);
  });

  it('hands the build an empty directory that exists', () => {
    const seen: string[][] = [];
    const build: GitTemplateBuild = (dir) => {
      seen.push(fs.readdirSync(dir));
      repoBuild('empty-dir')(dir);
    };
    clone(key('empty-dir'), build);
    expect(seen).toEqual([[]]);
  });

  it('survives a fresh module instance - the next file on this worker reuses the template', async () => {
    const k = key('across-files');
    const first = vi.fn(repoBuild('across-files'));
    clone(k, first);
    expect(first).toHaveBeenCalledTimes(1);

    // Vitest evaluates modules afresh for every file a worker runs; an in-memory memo alone would rebuild.
    vi.resetModules();
    const fresh = await import('./helpers/gitFixture');
    const second = vi.fn(repoBuild('across-files'));
    const dir = fresh.cloneGitTemplate(k, second);
    made.push(dir);
    expect(second).not.toHaveBeenCalled();
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('caches nothing from a build that throws: the error reaches the caller, its directory is gone, and the next call builds again', () => {
    const k = key('throws');
    const boom = new Error('build failed on purpose');
    // ONE build function (one source, so one on-disk slot) that fails the first time only:
    // a second function would hash to a slot of its own and pass without the cache being right.
    const handed: string[] = [];
    let fail = true;
    const build = vi.fn((dir: string) => {
      handed.push(dir);
      if (fail) {
        fs.writeFileSync(path.join(dir, 'half-built.txt'), 'x\n');
        throw boom;
      }
      repoBuild('throws')(dir);
    });
    expect(() => cloneGitTemplate(k, build)).toThrow(boom);
    expect(build).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(handed[0]), 'a failed build leaves nothing behind').toBe(false);

    fail = false;
    const dir = clone(k, build);
    expect(build).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(dir, 'half-built.txt'))).toBe(false);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('never adopts a half-built template left by a worker killed mid-build (temp dir + rename)', async () => {
    const k = key('killed');
    // A killed worker runs no catch/finally: replay that by restoring the build's directory,
    // half-built, after the helper has cleaned it up - exactly what a SIGKILL would leave on disk.
    const handed: string[] = [];
    const seen: string[][] = [];
    let crash = true;
    let stash = '';
    const build: GitTemplateBuild = (dir) => {
      handed.push(dir);
      seen.push(fs.readdirSync(dir));
      if (crash) {
        fs.mkdirSync(path.join(dir, '.git'));
        fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        fs.writeFileSync(path.join(dir, 'half-built.txt'), 'x\n');
        stash = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-git-fixture-stash-'));
        made.push(stash);
        fs.cpSync(dir, stash, { recursive: true });
        throw new Error('killed mid-build');
      }
      repoBuild('killed')(dir);
    };
    expect(() => cloneGitTemplate(k, build)).toThrow('killed mid-build');
    const partial = handed[0];
    expect(inside(partial, gitTemplateRoot()), 'the build runs inside the template root, so the rename stays on one volume').toBe(true);
    fs.cpSync(stash, partial, { recursive: true });

    // The next worker given this pool id: a fresh module, the stale partial still on disk.
    crash = false;
    vi.resetModules();
    const fresh = await import('./helpers/gitFixture');
    const dir = fresh.cloneGitTemplate(k, build);
    made.push(dir);
    expect(handed).toHaveLength(2);
    expect(seen[1], 'the rebuild starts from an empty directory, not from the partial').toEqual([]);
    expect(fs.existsSync(path.join(dir, 'half-built.txt'))).toBe(false);
    expect(git(dir, 'rev-parse', 'HEAD')).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    // Built in a temporary directory and renamed: the template path is never the build's working directory.
    const template = fresh.gitTemplate(k, build);
    for (const d of handed) expect(samePath(d, template)).toBe(false);
  });
});

describe('keys are namespaced and the build source is part of the slot', () => {
  it('refuses a key that is not `<module>:<name>`, before building anything', () => {
    for (const bad of ['bare', ':name', 'module:', '']) {
      const build = vi.fn(repoBuild('bad-key'));
      expect(() => cloneGitTemplate(bad, build), JSON.stringify(bad)).toThrow(/<module>:<name>/);
      expect(() => gitTemplate(bad, build), JSON.stringify(bad)).toThrow(/<module>:<name>/);
      expect(build).not.toHaveBeenCalled();
    }
  });

  it('gives the same key with the same build one template, built once', () => {
    const k = key('same-build');
    let runs = 0;
    const build: GitTemplateBuild = (dir) => { runs++; repoBuild('same-build')(dir); };
    const t1 = gitTemplate(k, build);
    const t2 = gitTemplate(k, build);
    expect(samePath(t1, t2)).toBe(true);
    expect(runs).toBe(1);
  });

  it('gives the same key with a different build (different source) a different template, not the first one\'s repo', () => {
    const k = key('collide');
    let xRuns = 0;
    let yRuns = 0;
    // Two modules that picked one key: the builds' sources differ, so must their templates.
    const buildX: GitTemplateBuild = (dir) => { xRuns++; repoBuild('collide-x')(dir); };
    const buildY: GitTemplateBuild = function (dir) { yRuns += 1; repoBuild('collide-y')(dir); };
    expect(buildX.toString()).not.toBe(buildY.toString());

    const tx = gitTemplate(k, buildX);
    const ty = gitTemplate(k, buildY);
    expect(samePath(tx, ty)).toBe(false);
    expect([xRuns, yRuns]).toEqual([1, 1]);
    expect(fs.readFileSync(path.join(clone(k, buildX), 'src', 'impl.json'), 'utf8')).toBe(JSON.stringify({ marker: 'collide-x' }));
    expect(fs.readFileSync(path.join(clone(k, buildY), 'src', 'impl.json'), 'utf8')).toBe(JSON.stringify({ marker: 'collide-y' }));
    expect([xRuns, yRuns]).toEqual([1, 1]);
  });
});

describe('a clone of a built key spawns nothing', () => {
  it('the recorder sees spawns made through either specifier (the spy is wired)', () => {
    execFileSync('git', ['--version'], { windowsHide: true });
    nodeExecFileSync('git', ['--version'], { windowsHide: true });
    expect(spawns.calls.map(c => c.fn)).toEqual(['execFileSync', 'execFileSync']);
  });

  it('the first clone of a key runs the build (whose spawns are recorded); the second clone runs none', () => {
    const k = key('no-spawn');
    const build = vi.fn(repoBuild('no-spawn'));
    clone(k, build);
    expect(build).toHaveBeenCalledTimes(1);
    expect(spawns.calls.length).toBeGreaterThan(0);

    spawns.calls.length = 0;
    const dir = clone(k, build);
    expect(spawns.calls).toEqual([]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(dir, '.git', 'HEAD'))).toBe(true);
  });

  it('gitTemplate of a built key spawns nothing either', () => {
    const k = key('no-spawn-template');
    const build = repoBuild('no-spawn-template');
    gitTemplate(k, build);
    spawns.calls.length = 0;
    gitTemplate(k, build);
    expect(spawns.calls).toEqual([]);
  });
});

describe('where templates and clones live', () => {
  it('keeps templates in <runHome>/git-templates/<poolId>: inside the run\'s sandbox, outside the worker\'s HOME', () => {
    const runHome = process.env.AGENFK_TEST_RUN_HOME;
    const poolId = process.env.VITEST_POOL_ID;
    expect(runHome, 'the vitest config sets AGENFK_TEST_RUN_HOME').toBeTruthy();
    expect(poolId, 'vitest sets VITEST_POOL_ID').toBeTruthy();
    const root = gitTemplateRoot();
    expect(samePath(root, path.join(fs.realpathSync.native(runHome!), 'git-templates', poolId!))).toBe(true);
    expect(inside(gitTemplate(key('in-sandbox'), repoBuild('in-sandbox')), root)).toBe(true);
    // A spec that cleans or lists its HOME cannot reach them.
    expect(WORKER_HOME, 'the setup file pins a HOME per worker').toBeTruthy();
    expect(inside(root, WORKER_HOME!) || inside(root, fs.realpathSync.native(WORKER_HOME!))).toBe(false);
  });

  it('does not follow a spec that re-points HOME mid-file (as useEngineServer does)', () => {
    const k = key('home-moves');
    const build = vi.fn(repoBuild('home-moves'));
    clone(k, build);
    const rootBefore = gitTemplateRoot();

    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-git-fixture-otherhome-'));
    made.push(elsewhere);
    try {
      process.env.HOME = process.env.USERPROFILE = elsewhere;
      expect(gitTemplateRoot()).toBe(rootBefore);
      clone(k, build);
      expect(build).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    } finally {
      process.env.HOME = saved.HOME;
      process.env.USERPROFILE = saved.USERPROFILE;
    }
  });

  it('gives a clone path in the spelling git reports for it', () => {
    const dir = clone(key('toplevel'), repoBuild('toplevel'));
    expect(path.isAbsolute(dir)).toBe(true);
    // On macOS this is /private/var vs /var; on Windows the 8.3 vs long name (#208).
    expect(samePath(git(dir, 'rev-parse', '--show-toplevel'), dir)).toBe(true);
    expect(samePath(fs.realpathSync.native(dir), dir)).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('gives long-form paths (no 8.3 `~1` segments) even when TEMP is spelled short', () => {
    const k = key('long-form');
    const build = repoBuild('long-form');
    const longTmp = fs.realpathSync.native(os.tmpdir());
    const shortTmp = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${longTmp}") do @echo %~sI`],
      { windowsVerbatimArguments: true, encoding: 'utf8', windowsHide: true }).trim();

    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    let dir: string;
    try {
      // When the volume has 8.3 names this is the spelling a real Windows TEMP has; otherwise it is the long one.
      process.env.TEMP = process.env.TMP = shortTmp;
      dir = clone(k, build);
    } finally {
      process.env.TEMP = saved.TEMP;
      process.env.TMP = saved.TMP;
    }
    const shortSegment = /(^|[\\/])[^\\/]*~\d+([\\/]|$)/;
    expect(dir).not.toMatch(shortSegment);
    expect(gitTemplateRoot()).not.toMatch(shortSegment);
    expect(gitTemplate(k, build)).not.toMatch(shortSegment);
    expect(dir).toBe(fs.realpathSync.native(dir));
  });
});
