/**
 * Fixture git repositories from a per-worker template (#311).
 *
 * Building a fixture repo from scratch costs five or more git spawns
 * (`git init`, `git config` x2, `git add`, `git commit`), and on Windows each
 * spawn is 100-300 ms. A template is built ONCE per worker per key - the
 * `build` callback runs in an empty directory and leaves a repository there -
 * and every test gets its own copy of it, made with the filesystem alone: no
 * child process at all once the key is built.
 *
 * Contract (pinned by gitFixture.test.ts):
 *  - a clone is a real, independent repository: clean status, its own .git,
 *    writes and commits in one clone are invisible to every other clone and
 *    to the template. A clone is `copyTree(template, mkdtemp)` (cpSync with
 *    preserveTimestamps, in plain JS), so file mtimes match the template's;
 *  - `build` runs once per key per worker - across the worker's files too, so
 *    the template lives on disk, not only in memory - and a build that throws
 *    caches nothing and leaves nothing behind;
 *  - templates live in `<AGENFK_TEST_RUN_HOME>/git-templates/<VITEST_POOL_ID>`
 *    (gitTemplateRoot): inside the run's sandbox, so its teardown removes
 *    them, and BESIDE the worker's HOME (`<runHome>/worker-<poolId>`), not in
 *    it, so a spec that cleans, lists or re-points HOME (useEngineServer does)
 *    can neither touch the templates nor move the cache;
 *  - crash safety: `build` runs in a temporary directory inside
 *    gitTemplateRoot (same volume) and the result is renamed onto the
 *    template's path only once `build` returns. The template path therefore
 *    exists only complete. A worker killed mid-build leaves at most a stale
 *    temporary directory, and the next worker given that pool id ignores it
 *    and builds again into an empty directory - it never adopts a half-built
 *    template. (Stale temporaries are not swept; the run's teardown removes
 *    them with the sandbox.)
 *  - clone paths are long-form on Windows (no `~1` 8.3 segments, #208), i.e.
 *    the spelling git itself reports for the checkout.
 *
 * KEYS. The cache is shared ACROSS FILES on disk: every spec file the worker
 * runs sees the same templates. A key must therefore uniquely identify the
 * template's CONTENT across the whole run, not just within one file, and is
 * namespaced `<module>:<name>` - the spec or helper module that owns it, then
 * a name unique within that module, carrying every parameter the content
 * depends on (e.g. `review-records:two-commits`). A key without a non-empty
 * module and name around a `:` is refused with an error naming that form,
 * before anything is built.
 *
 * The on-disk slot is the key PLUS a hash of `build.toString()`. Chosen
 * because it is free and turns the commonest collision - two modules picking
 * the same key for different build functions - into two templates instead of
 * one module silently getting the other's repo. Trade-off: it is only a
 * safety net, not a substitute for a unique key. It sees the build's SOURCE,
 * not its closure, so builds made by one factory with different arguments
 * (`repoBuild('a')` vs `repoBuild('b')`) and any `vi.fn(...)` wrappers hash
 * the same - the key must carry those arguments. And editing a build's source
 * (or instrumenting it differently) moves it to a new slot, which costs one
 * rebuild and is harmless within a run.
 *
 * Clones share commit SHAs with the template and with each other. A spec that
 * needs SHAs unique across repositories must build its own repo.
 *
 * PHASE-2 CONSTRAINTS (for migrating specs onto the helper):
 *  - never set a fixed GIT_AUTHOR_DATE / GIT_COMMITTER_DATE in a template
 *    build: review-records.test.ts (~:210) and review-range-auto.test.ts
 *    (~:233) depend on real commit dates;
 *  - receipts-e2e's makeProducer keeps its own per-test builds - it needs
 *    trees unique per test, which a shared template cannot give;
 *  - never use index-trusting plumbing (`git diff-files`, `git diff-index`
 *    without a prior `git update-index --refresh` / `git status`) on a
 *    clone: the copy preserves mtimes but not ctime/inode, which Linux git
 *    keeps in the index, so the index's stat data is stale in every clone.
 *    Porcelain (`git status`, `git diff`) refreshes and is fine;
 *  - the template is read-only for callers: check it through a clone, or with
 *    `git --no-optional-locks` (plain `git status` rewrites its index).
 *
 * Lives with the server's other test helpers; cli and hub specs can import it
 * by relative path (`../../../server/src/test/helpers/gitFixture`) - it pulls
 * in nothing from the server itself.
 *
 * CONVENIENCES for builds (and specs): `gitSync(dir, ...args)` runs git with
 * no shell and returns trimmed stdout; `writeFiles(dir, { 'a/b.txt': '...' })`
 * writes files, creating parent directories. A typical `makeRepo()`:
 *
 *   const buildOneCommit: GitTemplateBuild = (d) => {
 *     gitSync(d, 'init', '-q', '-b', 'main');
 *     gitSync(d, 'config', 'user.email', 't@t');
 *     gitSync(d, 'config', 'user.name', 't');
 *     writeFiles(d, { 'README.md': 'x\n' });
 *     gitSync(d, 'add', '.');
 *     gitSync(d, 'commit', '-qm', 'init');
 *   };
 *   const repo = cloneGitTemplate('my-spec:one-commit', buildOneCommit);
 *   // ... afterEach: fs.rmSync(repo, { recursive: true, force: true })
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Builds a template repository in `dir`, an empty directory that exists. */
export type GitTemplateBuild = (dir: string) => void;

/** Long-form spelling of a directory that exists (no 8.3 `~1` segments on Windows). */
function longForm(dir: string): string {
  try { return fs.realpathSync.native(dir); } catch { return path.resolve(dir); }
}

/** Synchronous pause, for retrying a filesystem call Windows briefly refuses (AV, indexer). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function retryBusy<T>(fn: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) throw err;
      pause(50);
    }
  }
}

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * The directory holding this worker's built templates:
 * `<AGENFK_TEST_RUN_HOME>/git-templates/<VITEST_POOL_ID>`, long-form. Fixed
 * for the worker's life - it does not follow HOME.
 */
export function gitTemplateRoot(): string {
  const runHome = process.env.AGENFK_TEST_RUN_HOME;
  const poolId = process.env.VITEST_POOL_ID;
  if (!runHome || !poolId) {
    throw new Error('gitFixture needs AGENFK_TEST_RUN_HOME and VITEST_POOL_ID: run the spec through the root vitest config');
  }
  const root = path.join(longForm(runHome), 'git-templates', poolId);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

const KEY_FORM = /^[^:]+:.+$/;

/** The on-disk slot for a key and build source: a hash, so it is a safe file name on every platform. */
function slotFor(key: string, build: GitTemplateBuild): string {
  if (typeof key !== 'string' || !KEY_FORM.test(key)) {
    throw new Error(`gitFixture: key ${JSON.stringify(key)} is not of the form <module>:<name> (a non-empty module and name around a ':')`);
  }
  const buildHash = createHash('sha256').update(build.toString()).digest('hex');
  return createHash('sha256').update(`${key}\0${buildHash}`).digest('hex').slice(0, 40);
}

/**
 * The built template for `key` (`<module>:<name>`, see KEYS), building it with
 * `build` the first time this worker asks for that key and build source.
 * Read-only for callers: copy it with cloneGitTemplate.
 */
export function gitTemplate(key: string, build: GitTemplateBuild): string {
  const slot = slotFor(key, build);
  const root = gitTemplateRoot();
  const template = path.join(root, slot);
  if (fs.existsSync(template)) return template;

  // Build beside the template (same volume) and rename into place only once complete.
  const work = fs.mkdtempSync(path.join(root, `.building-${slot.slice(0, 12)}-`));
  try {
    build(work);
  } catch (err) {
    removeDir(work);
    throw err;
  }
  try {
    retryBusy(() => fs.renameSync(work, template));
  } catch (err) {
    removeDir(work);
    if (fs.existsSync(template)) return template;
    throw err;
  }
  return template;
}

/**
 * A fresh, independent copy of the template for `key`, in a new long-form temp
 * directory named `<prefix>XXXXXX`. Spawns nothing once the key is built. The
 * caller removes it.
 */
export function cloneGitTemplate(key: string, build: GitTemplateBuild, prefix = 'agenfk-git-fixture-'): string {
  const template = gitTemplate(key, build);
  const dir = fs.mkdtempSync(path.join(longForm(os.tmpdir()), prefix));
  try {
    copyTree(template, dir);
  } catch (err) {
    removeDir(dir);
    throw err;
  }
  return dir;
}

/**
 * Copies the directory tree `src` into `dst` (an existing directory), keeping
 * each file's modification time - as `fs.cpSync(src, dst, { recursive,
 * preserveTimestamps })` would, in plain JS. Node 22's cpSync aborts the
 * process natively on Windows when a path has non-ASCII letters (no exception:
 * the vitest worker just dies), and the Windows CI job runs every spec under
 * such a HOME (AGENFK_TEST_UNICODE_HOME, #201). A fixture repo holds no
 * symbolic link, and one could not be recreated faithfully on Windows (file vs
 * directory link, junctions, EPERM without Developer Mode), so a link throws
 * rather than being followed out of the tree or copied wrong.
 */
export function copyTree(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isSymbolicLink()) {
      throw new Error(`copyTree: ${from} is a symbolic link; fixture trees must not contain links`);
    } else {
      fs.copyFileSync(from, to);
      const st = fs.statSync(from);
      fs.utimesSync(to, st.atime, st.mtime);
    }
  }
}

/** Variables that would point git at another repository than `cwd`'s (set inside git hooks). */
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'];

/** Runs `git <args>` in `dir` with no shell; returns stdout, trimmed. Throws on a non-zero exit. */
export function gitSync(dir: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const name of REPO_ENV) delete env[name];
  return execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Writes each `relativePath: content` under `dir`, creating parent directories. */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}
