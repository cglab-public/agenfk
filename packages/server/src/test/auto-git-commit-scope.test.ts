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
    // Documents the contract; it does NOT discriminate — it stages with
    // `git add -A` itself, so every candidate implementation passes. The test
    // that actually rules `git add -u` out is the UNSTAGED rename below, where
    // -u stages the deletion and skips the addition, producing a commit whose
    // surviving files import a path that no longer exists.
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

  it('names awkward paths as the author would recognise them', async () => {
    // git quotes any path with a space or a non-ASCII byte, so without -z the
    // report hands the reader "uni-caf\303\251.txt" — an escape sequence
    // presented as the name of their own file — and every spaced path wrapped
    // in quotes it does not have.
    const { dir } = repo();
    try {
      fs.writeFileSync(path.join(dir, 'with space.txt'), 'a\n');
      fs.writeFileSync(path.join(dir, 'café.txt'), 'b\n');
      const r = await close(dir);
      expect(r.unstaged).toEqual(expect.arrayContaining(['with space.txt', 'café.txt']));
      expect(r.unstaged.some(p => p.includes('\\3') || p.startsWith('"'))).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports a rename as one path, not as a mangled arrow', async () => {
    // A rename entry is `R  new` with the OLD path in the following field; not
    // consuming it makes the source look like a separate unstaged file.
    const { dir, git } = repo();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
      git('add a.txt'); git('commit -q -m a');
      git('mv a.txt b.txt');       // staged rename
      fs.writeFileSync(path.join(dir, 'loose.txt'), 'y\n'); // the only unstaged thing

      const r = await close(dir, 'abc129', 'TASK', 'renames');
      expect(r.committed).toBe(true);
      expect(r.unstaged).toEqual(['loose.txt']);
      expect(r.unstaged.join(' ')).not.toContain('->');
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

describe('it never claims a commit it did not make', () => {
  // The branch an earlier version had no case for: a FAILED commit reported
  // committed:false, so the agent was told "nothing was staged" — its work had
  // been there all along — and went off to push a branch without it.
  it('says the commit FAILED, not that nothing was staged', async () => {
    const { dir, git } = repo();
    try {
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v2\n');
      git('add tracked.txt');
      // A pre-commit hook that refuses, which is an ordinary CI-adjacent setup.
      const hooks = path.join(dir, '.git', 'hooks');
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

      const r = await close(dir);
      expect(r.outcome).toBe('failed');
      expect(r.success).toBe(false);
      expect(r.committed).toBe(false);
      // The staged work is still staged — the agent must be told to deal with it.
      expect(git('diff --cached --name-only')).toContain('tracked.txt');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('declines a merge in progress instead of stealing it', async () => {
    // An unfinished merge leaves the index full of somebody else's resolution.
    // Committing it produces a two-parent merge commit titled after this item —
    // the same provenance theft, in a shape no staging rule can catch.
    const { dir, git } = repo();
    try {
      git('checkout -q -b side');
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'side\n');
      git('commit -q -am side');
      git('checkout -q main');
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'main\n');
      git('commit -q -am main');
      try { git('merge side'); } catch { /* conflicts, which is the point */ }
      expect(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(true);

      const r = await close(dir);
      expect(r.outcome).toBe('declined');
      expect(r.committed).toBe(false);
      expect(r.detail).toMatch(/merge/i);
      // No commit was made, so the merge is still the author's to finish.
      expect(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports a directory that is not a git repository', async () => {
    // Swallowing git's own refusal made a server started outside a repo — or
    // pointed at one by a stale projectRoot — report every close as a clean
    // "nothing staged", forever.
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agenfk-notarepo-'));
    try {
      const r = await close(dir);
      expect(r.outcome).toBe('failed');
      expect(r.success).toBe(false);
      expect(r.detail).toMatch(/not a git repository/i);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
