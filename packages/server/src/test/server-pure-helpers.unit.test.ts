/**
 * @file GH-281 — server.ts helpers that decide a run, judged directly.
 *
 * - outsideState (83c1cbca, c03ae9f7, 62f87741): the content beside a
 *   subdirectory project's root, as one hash. A partial run over an entry
 *   needs it unchanged since the entry; dirty-entry-partial-runs keeps one
 *   end-to-end case each way, the input variants are here.
 * - WHOLE_SUITE_FILE / GRAPH_FILE (a36047ea, de5e5a03): the changed files a
 *   related-tests run cannot stand for; affected-capture keeps one end-to-end
 *   case per list.
 * - receiptsModeOf / freshRootClose (RFC-002): Shadow and Enforce alike make
 *   a root card close on a fresh run.
 *
 * Real git, no HTTP: the server module is imported, never started.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

const TEST_DB = testDbPath('server-pure-helpers-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;

import * as server from '../server';
import { posixShell } from './helpers/posixShell';

const dirs: string[] = [];
afterAll(async () => {
  await removeTestDb(TEST_DB, server.closeStorage);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Read through the module so a missing export fails the test that needs it, not the whole file.
const outsideState = (root: string, head: string): string | null => (server as any).outsideState(root, head);
const receiptsModeOf = (project: unknown): 'shadow' | 'enforce' | null => (server as any).receiptsModeOf(project);
const freshRootClose = (item: unknown, project: unknown): boolean => (server as any).freshRootClose(item, project);
const WHOLE_SUITE_FILE = (): RegExp => (server as any).WHOLE_SUITE_FILE;
const GRAPH_FILE = (): RegExp => (server as any).GRAPH_FILE;

const git = (dir: string, cmd: string) => execSync(cmd, { cwd: dir, shell: posixShell(), encoding: 'utf8' }).trim();
const INIT = 'git init -q -b main && git config user.email t@t && git config user.name t';

/** A repository whose project is `top/sub`, with shared.js beside it; `head` is its one commit. */
function subProject() {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-outside-')));
  dirs.push(top);
  const root = path.join(top, 'sub');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(top, 'shared.js'), 'module.exports = 0;\n');
  fs.writeFileSync(path.join(root, 'lib.js'), 'module.exports = 1;\n');
  git(top, `${INIT} && git add . && git commit -qm one`);
  return { top, root, head: git(top, 'git rev-parse HEAD') };
}
/** A repository nested beside the project (vendor/), with one commit. */
function nestedRepo(top: string) {
  const nested = path.join(top, 'vendor');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'x.js'), 'module.exports = 1;\n');
  git(nested, `${INIT} && git add . && git commit -qm one`);
  return nested;
}

describe('outsideState: the content beside a subdirectory project', () => {
  it('a project at the repository top has nothing beside it', () => {
    const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-outside-top-')));
    dirs.push(top);
    fs.writeFileSync(path.join(top, 'a.js'), '1\n');
    git(top, `${INIT} && git add . && git commit -qm one`);
    fs.writeFileSync(path.join(top, 'a.js'), '2\n');
    expect(outsideState(top, git(top, 'git rev-parse HEAD'))).toBe('');
  });

  it('nothing changed beside it is the empty state, whatever changed inside the root', () => {
    const p = subProject();
    fs.writeFileSync(path.join(p.root, 'lib.js'), 'module.exports = 2;\n');
    expect(outsideState(p.root, p.head)).toBe('');
  });

  it('the same work beside it reads as the same state again (tracked edits and untracked files alike)', () => {
    const p = subProject();
    fs.writeFileSync(path.join(p.top, 'shared.js'), 'module.exports = 99;\n');
    fs.writeFileSync(path.join(p.top, 'scratch.txt'), "someone else's untracked file\n");
    const first = outsideState(p.root, p.head);
    expect(first).toEqual(expect.any(String));
    expect(first).not.toBe('');
    fs.writeFileSync(path.join(p.root, 'lib.js'), 'module.exports = 3;\n');
    expect(outsideState(p.root, p.head)).toBe(first);
  });

  it('work beside it that moved on is another state', () => {
    const p = subProject();
    fs.writeFileSync(path.join(p.top, 'shared.js'), 'module.exports = 99;\n');
    const first = outsideState(p.root, p.head);
    fs.writeFileSync(path.join(p.top, 'shared.js'), 'module.exports = 100;\n');
    expect(outsideState(p.root, p.head)).not.toBe(first);
  });

  it('work beside it that was reverted since is another state than the one with it', () => {
    const p = subProject();
    fs.writeFileSync(path.join(p.top, 'shared.js'), 'module.exports = 99;\n');
    const withWork = outsideState(p.root, p.head);
    git(p.top, 'git checkout -q -- shared.js');
    const after = outsideState(p.root, p.head);
    expect(after).toBe('');
    expect(after).not.toBe(withWork);
  });

  it('a user\'s diff.relative does not hide an edit beside the root', () => {
    const p = subProject();
    git(p.top, 'git config diff.relative true');
    fs.writeFileSync(path.join(p.top, 'shared.js'), 'module.exports = 99;\n');
    const first = outsideState(p.root, p.head);
    expect(first).not.toBe('');
    fs.writeFileSync(path.join(p.top, 'shared.js'), 'module.exports = 100;\n');
    expect(outsideState(p.root, p.head)).not.toBe(first);
  });

  it('a repository nested beside it is read by its commit: moved to another commit, another state', () => {
    const p = subProject();
    const nested = nestedRepo(p.top);
    const first = outsideState(p.root, p.head);
    expect(first).not.toBe('');
    expect(outsideState(p.root, p.head)).toBe(first);
    fs.writeFileSync(path.join(nested, 'x.js'), 'module.exports = 2;\n');
    git(nested, 'git commit -qam two');
    expect(outsideState(p.root, p.head)).not.toBe(first);
  });

  it('a repository nested beside it with uncommitted work cannot be read: no state, so no partial run', () => {
    const p = subProject();
    const nested = nestedRepo(p.top);
    fs.writeFileSync(path.join(nested, 'x.js'), 'module.exports = 2;\n');
    expect(outsideState(p.root, p.head)).toBeNull();
  });
});

describe('the changed files a related-tests run cannot stand for', () => {
  it('a runner config, manifest, lockfile or setup file means the whole suite', () => {
    for (const f of ['package.json', 'pkg/a/package-lock.json', 'yarn.lock', 'vitest.config.js', 'vite.config.mts', 'tsconfig.base.json', 'test/setup.ts', 'conftest.py', 'pyproject.toml']) {
      expect(WHOLE_SUITE_FILE().test(f), f).toBe(true);
    }
    for (const f of ['lib.js', 'src/config.ts', 'packages.md']) expect(WHOLE_SUITE_FILE().test(f), f).toBe(false);
  });

  it('only JS and TS sources are followed through imports: a snapshot, a fixture or data file is not', () => {
    for (const f of ['lib.js', 'my lib.js', 'src/a.ts', 'ui/b.tsx', 'c.mjs', 'd.cts']) expect(GRAPH_FILE().test(f), f).toBe(true);
    for (const f of ['__snapshots__/a.test.js.snap', 'fixture.json', 'data.yml', 'README.md']) expect(GRAPH_FILE().test(f), f).toBe(false);
  });
});

describe('receiptsModeOf / freshRootClose (RFC-002): Shadow and Enforce are treated alike', () => {
  const project = (receiptsMode?: unknown) => ({ hubRepoSettings: receiptsMode === undefined ? {} : { receiptsMode } });

  it('reads Shadow and Enforce from the hub settings, and nothing else', () => {
    expect(receiptsModeOf(project('shadow'))).toBe('shadow');
    expect(receiptsModeOf(project('enforce'))).toBe('enforce');
    for (const m of ['off', 'ENFORCE', '', 1, null, undefined]) expect(receiptsModeOf(project(m)), String(m)).toBeNull();
    expect(receiptsModeOf(undefined)).toBeNull();
    expect(receiptsModeOf({})).toBeNull();
  });

  it('a root card closes on a fresh run under Shadow exactly as under Enforce', () => {
    for (const m of ['shadow', 'enforce']) expect(freshRootClose({ id: 'r' }, project(m)), m).toBe(true);
  });

  it('a child card never does, nor any card when receipts are off', () => {
    for (const m of ['shadow', 'enforce']) expect(freshRootClose({ id: 'c', parentId: 'r' }, project(m)), m).toBe(false);
    expect(freshRootClose({ id: 'r' }, project('off'))).toBe(false);
    expect(freshRootClose({ id: 'r' }, project())).toBe(false);
  });
});
