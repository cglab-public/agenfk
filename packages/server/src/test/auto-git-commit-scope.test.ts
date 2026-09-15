/**
 * @file BUG 315edc11 / CGLAB-22 — the close commit must carry the item's work,
 * and only the item's work.
 *
 * When an item reaches its final flow step the server makes a `close(<type>)`
 * commit. It ran `git add -A`, staging every untracked file in the repository,
 * so closing one item swept in whatever happened to be lying around — including
 * work in progress belonging to a different task or branch. Observed: a
 * close(bug) commit carrying another item's WIP test, which had no
 * implementation on that branch and would have failed CI under someone else's
 * name.
 *
 * `git add -u` was tried and rejected — see the tests below that pin WHY, since
 * a future reader will otherwise reach for it as the obvious answer. What
 * shipped instead: the server stages nothing and commits the INDEX, which is
 * the only thing here that carries provenance. Anything the author left
 * unstaged is reported back rather than silently dropped.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { autoGitCommit } from '../server.js';

/** A throwaway repo with one tracked file and one commit. */
const repo = () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agenfk-autocommit-'));
  const git = (cmd: string) => execSync('git ' + cmd, { cwd: dir, stdio: 'pipe' }).toString();
  git('init -q');
  git('config user.email test@example.com');
  git('config user.name Tester');
  git('checkout -q -b main');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v1\n');
  git('add tracked.txt');
  git('commit -q -m initial');
  return { dir, git, tree: () => git('ls-tree -r --name-only HEAD').split('\n').map(s => s.trim()).filter(Boolean) };
};
const close = (dir: string, id = 'abc123', type = 'BUG', title = 'demo bug') =>
  autoGitCommit({ id, type, title } as any, dir);

describe('the close commit carries what the author staged', () => {
  it('commits the staged work and names it after the item', async () => {
    const { dir, git, tree } = repo();
    try {
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v2\n');
      fs.writeFileSync(path.join(dir, 'new.txt'), 'mine\n');
      git('add -A');

      const r = await close(dir);
      expect(r.success).toBe(true);
      expect(r.committed).toBe(true);
      expect(git('log -1 --pretty=%s').trim()).toBe('close(bug): demo bug [abc123]');
      expect(tree()).toContain('new.txt');
      expect(git('show HEAD:tracked.txt')).toBe('v2\n');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('never sweeps in an untracked file the author did not stage', async () => {
    // The reported incident: another item's WIP test, with no implementation on
    // this branch, committed under this item's name.
    const { dir, git, tree } = repo();
    try {
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v2\n');
      git('add tracked.txt');
      fs.writeFileSync(path.join(dir, 'somebody-elses-wip.test.ts'), 'wip\n');

      const r = await close(dir);
      expect(r.committed).toBe(true);
      expect(tree()).not.toContain('somebody-elses-wip.test.ts');
      expect(git('status --porcelain')).toContain('?? somebody-elses-wip.test.ts');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('never sweeps in a TRACKED file the author did not stage either', async () => {
    // Which is why `git add -u` is not the fix: it narrows to tracked files,
    // an axis orthogonal to "whose work is this", and a colleague's in-flight
    // edit to an already-tracked file is swept in exactly as before.
    const { dir, git, tree } = repo();
    try {
      fs.writeFileSync(path.join(dir, 'other.txt'), 'theirs v1\n');
      git('add other.txt'); git('commit -q -m other');
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'mine v2\n');
      git('add tracked.txt');
      fs.writeFileSync(path.join(dir, 'other.txt'), 'their in-flight edit\n'); // NOT staged

      const r = await close(dir);
      expect(r.committed).toBe(true);
      expect(git('show HEAD:other.txt')).toBe('theirs v1\n');
      expect(r.unstaged).toContain('other.txt');
      expect(tree()).toContain('tracked.txt');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('carries BOTH halves of a rename', async () => {
    // The case that rules `git add -u` out outright: it stages the deletion
    // (tracked) and skips the addition (untracked), producing a commit whose
    // remaining files import a path that no longer exists. Not an incomplete
    // commit — one that does not build, pushed under the item's name.
    const { dir, git, tree } = repo();
    try {
      fs.writeFileSync(path.join(dir, 'old.ts'), 'export const x = 1;\n');
      fs.writeFileSync(path.join(dir, 'index.ts'), "export * from './old.js';\n");
      git('add -A'); git('commit -q -m before');

      fs.renameSync(path.join(dir, 'old.ts'), path.join(dir, 'new.ts'));
      fs.writeFileSync(path.join(dir, 'index.ts'), "export * from './new.js';\n");
      git('add -A');

      const r = await close(dir, 'abc126', 'TASK', 'renames a file');
      expect(r.committed).toBe(true);
      const t = tree();
      expect(t).toContain('new.ts');
      expect(t).not.toContain('old.ts');
      // The half that matters: index.ts points at a file that EXISTS in HEAD.
      expect(git('show HEAD:index.ts')).toContain('./new.js');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('never half-commits an UNSTAGED rename', async () => {
    // The precise shape `git add -u` produced: the deletion is tracked so it
    // stages, the new path is untracked so it does not, and HEAD ends up with
    // an index.ts importing a file that is not there. Nothing is staged here,
    // so the right answer is to commit nothing and say what was skipped.
    const { dir, git, tree } = repo();
    try {
      fs.writeFileSync(path.join(dir, 'old.ts'), 'export const x = 1;\n');
      fs.writeFileSync(path.join(dir, 'index.ts'), "export * from './old.js';\n");
      git('add -A'); git('commit -q -m before');

      fs.renameSync(path.join(dir, 'old.ts'), path.join(dir, 'new.ts'));
      const r = await close(dir, 'abc128', 'TASK', 'unstaged rename');

      expect(r.committed).toBe(false);
      // Crucially: old.ts is STILL in HEAD. A commit deleting it without
      // adding new.ts would not build.
      expect(tree()).toContain('old.ts');
      expect(r.unstaged).toEqual(expect.arrayContaining(['old.ts', 'new.ts']));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('carries a deletion the author staged', async () => {
    const { dir, git, tree } = repo();
    try {
      git('rm -q tracked.txt');
      const r = await close(dir, 'abc127', 'TASK', 'removes a file');
      expect(r.committed).toBe(true);
      expect(tree()).not.toContain('tracked.txt');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('an empty index is not a failure', () => {
  it('makes no commit, reports success, and says so', async () => {
    // The well-behaved case: the author committed their own work before
    // verifying. Reporting that as a failure — which the old code did, because
    // `git add -A && git commit` exits non-zero on a clean tree — teaches
    // everyone to ignore the log line that matters.
    const { dir, git } = repo();
    try {
      const before = git('rev-parse HEAD').trim();
      const r = await close(dir);
      expect(r.success).toBe(true);
      expect(r.committed).toBe(false);
      expect(git('rev-parse HEAD').trim()).toBe(before);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('still names what it declined to carry, so nothing is lost silently', async () => {
    // Dropping a file the author expected to land is the same defect as
    // silently adding one they did not.
    const { dir } = repo();
    try {
      fs.writeFileSync(path.join(dir, 'forgot-to-add.ts'), 'work\n');
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'edited but not staged\n');
      const r = await close(dir);
      expect(r.committed).toBe(false);
      expect(r.unstaged).toEqual(expect.arrayContaining(['forgot-to-add.ts', 'tracked.txt']));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
