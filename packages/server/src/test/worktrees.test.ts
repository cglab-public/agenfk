/**
 * CGLAB-166: git plumbing behind auto-worktree.
 *
 * These tests drive a REAL git repository in a temp directory rather than
 * mocking child_process. Worktrees are exactly the kind of feature where a
 * mock proves nothing: the failure modes that matter (a branch that already
 * exists, a worktree directory deleted behind git's back, two items racing for
 * one branch) are git's behaviour, not ours.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createWorktree, listWorktrees, removeWorktree, repoNameFor } from '../worktrees.js';
import { buildWorktreePath } from '@agenfk/core';
import { linkDir } from '../../../cli/src/test/helpers/links';

let repo: string;
let root: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-wt-repo-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-wt-root-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
});

afterEach(() => {
  for (const dir of [repo, root]) {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe('repoNameFor', () => {
  it('names the worktree namespace after the repository directory', () => {
    expect(repoNameFor(repo)).toBe(path.basename(repo));
  });
});

describe('createWorktree', () => {
  it('creates a real, checked-out worktree on a new branch', () => {
    const wt = createWorktree({ repoRoot: repo, root, branchName: 'feature/alpha' });

    expect(fs.existsSync(wt.path)).toBe(true);
    expect(fs.existsSync(path.join(wt.path, 'README.md'))).toBe(true);
    expect(wt.branchName).toBe('feature/alpha');
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/alpha');
  });

  it('leaves the main working tree untouched and still on its own branch', () => {
    createWorktree({ repoRoot: repo, root, branchName: 'feature/alpha' });
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });

  it('isolates two items: edits in one worktree are invisible in the other', () => {
    const a = createWorktree({ repoRoot: repo, root, branchName: 'feature/alpha' });
    const b = createWorktree({ repoRoot: repo, root, branchName: 'feature/beta' });

    expect(a.path).not.toBe(b.path);
    fs.writeFileSync(path.join(a.path, 'only-in-a.txt'), 'a');
    expect(fs.existsSync(path.join(b.path, 'only-in-a.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'only-in-a.txt'))).toBe(false);
  });

  it('is idempotent — asking twice returns the same worktree instead of failing', () => {
    const first = createWorktree({ repoRoot: repo, root, branchName: 'feature/alpha' });
    const second = createWorktree({ repoRoot: repo, root, branchName: 'feature/alpha' });
    expect(second.path).toBe(first.path);
    expect(second.created).toBe(false);
    expect(first.created).toBe(true);
  });

  it('checks out an existing branch rather than refusing to start', () => {
    git(repo, 'branch', 'feature/preexisting');
    const wt = createWorktree({ repoRoot: repo, root, branchName: 'feature/preexisting' });
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/preexisting');
  });

  it('recreates a worktree whose directory was deleted behind git\'s back', () => {
    const first = createWorktree({ repoRoot: repo, root, branchName: 'feature/alpha' });
    fs.rmSync(first.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    // git still lists it as "prunable"; a naive `worktree add` fails here.
    const again = createWorktree({ repoRoot: repo, root, branchName: 'feature/alpha' });
    expect(fs.existsSync(again.path)).toBe(true);
    expect(git(again.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/alpha');
  });

  it('keeps a nested branch name inside the worktree root, not nested on disk', () => {
    // "feature/a/b/c" is a perfectly valid refname. It must not turn into
    // nested directories, and must not climb out of the root.
    const wt = createWorktree({ repoRoot: repo, root, branchName: 'feature/a/b/c' });
    const rootReal = fs.realpathSync(root);
    expect(wt.path.startsWith(rootReal)).toBe(true);
    expect(path.relative(rootReal, wt.path).split(path.sep)).toHaveLength(2); // <repo>/<leaf>
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/a/b/c');
  });

  it('fails loudly on a refname git itself rejects, creating nothing', () => {
    // git forbids ".." in a refname. We must surface that rather than paper
    // over it, and must not leave a half-made directory behind.
    expect(() => createWorktree({ repoRoot: repo, root, branchName: 'feature/../../escape' }))
      .toThrow(/worktree add failed/i);
    const rootReal = fs.realpathSync(root);
    const stray = fs.readdirSync(rootReal)
      .flatMap(d => {
        const sub = path.join(rootReal, d);
        return fs.statSync(sub).isDirectory() ? fs.readdirSync(sub) : [];
      });
    expect(stray).toHaveLength(0);
  });

  it('reports a clear error when the repo path is not a git repository', () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-wt-norepo-'));
    try {
      expect(() => createWorktree({ repoRoot: notARepo, root, branchName: 'feature/x' }))
        .toThrow(/not a git repository/i);
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe('listWorktrees', () => {
  it('lists nothing but the main tree for a fresh repo', () => {
    expect(listWorktrees(repo).filter(w => w.branchName !== 'main')).toHaveLength(0);
  });

  it('reports each created worktree with its branch and path', () => {
    const a = createWorktree({ repoRoot: repo, root, branchName: 'feature/alpha' });
    createWorktree({ repoRoot: repo, root, branchName: 'feature/beta' });

    const listed = listWorktrees(repo);
    const branches = listed.map(w => w.branchName);
    expect(branches).toContain('feature/alpha');
    expect(branches).toContain('feature/beta');

    const alpha = listed.find(w => w.branchName === 'feature/alpha');
    expect(path.resolve(alpha!.path)).toBe(path.resolve(a.path));
  });
});

describe('removeWorktree', () => {
  it('removes the directory and drops it from git\'s list', () => {
    const wt = createWorktree({ repoRoot: repo, root, branchName: 'feature/alpha' });
    removeWorktree(repo, wt.path);

    expect(fs.existsSync(wt.path)).toBe(false);
    expect(listWorktrees(repo).map(w => w.branchName)).not.toContain('feature/alpha');
  });

  it('removes a worktree that still has uncommitted changes', () => {
    const wt = createWorktree({ repoRoot: repo, root, branchName: 'feature/alpha' });
    fs.writeFileSync(path.join(wt.path, 'dirty.txt'), 'uncommitted');
    expect(() => removeWorktree(repo, wt.path)).not.toThrow();
    expect(fs.existsSync(wt.path)).toBe(false);
  });

  it('is idempotent — removing twice is not an error', () => {
    const wt = createWorktree({ repoRoot: repo, root, branchName: 'feature/alpha' });
    removeWorktree(repo, wt.path);
    expect(() => removeWorktree(repo, wt.path)).not.toThrow();
  });

  it('leaves the branch intact so the work is never destroyed', () => {
    const wt = createWorktree({ repoRoot: repo, root, branchName: 'feature/alpha' });
    fs.writeFileSync(path.join(wt.path, 'work.txt'), 'work');
    git(wt.path, 'add', '.');
    git(wt.path, 'commit', '-m', 'work in the worktree');
    removeWorktree(repo, wt.path);

    expect(git(repo, 'branch', '--list', 'feature/alpha').trim()).toContain('feature/alpha');
  });
});

describe('collision safety (CGLAB-166 review)', () => {
  it('never hands two different branches the same directory', () => {
    // Two items titled the same produce the same branch slug. Matching an
    // existing worktree on PATH alone would adopt it for a branch that is not
    // the one checked out there — two agents, one directory, one branch:
    // exactly the collision this feature exists to prevent.
    const a = createWorktree({ repoRoot: repo, root, branchName: 'feature/same-title' });
    // Ask for a DIFFERENT branch that hashes to the same intended path by
    // reusing the first worktree's directory.
    const listed = listWorktrees(repo).find(w => path.resolve(w.path) === path.resolve(a.path));
    expect(listed?.branchName).toBe('feature/same-title');

    const b = createWorktree({ repoRoot: repo, root, branchName: 'feature/other-title' });
    expect(path.resolve(b.path)).not.toBe(path.resolve(a.path));
    expect(git(b.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/other-title');
  });

  it('refuses to adopt a directory whose checked-out branch is not the one asked for', () => {
    const a = createWorktree({ repoRoot: repo, root, branchName: 'feature/alpha' });
    // Force the mismatch the path-only check could not see.
    git(a.path, 'checkout', '-q', '-b', 'feature/hijacked');
    expect(() => createWorktree({ repoRoot: repo, root, branchName: 'feature/alpha' }))
      .toThrow(/branch/i);
  });
});

describe('removeWorktree — bounded destruction', () => {
  it('refuses to delete a path outside the worktree root', () => {
    // The fs.rmSync fallback fires whenever `git worktree remove` fails for any
    // reason, including "belongs to another repository". Unbounded, that is a
    // recursive delete of a caller-supplied path.
    const outsider = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-outsider-'));
    fs.writeFileSync(path.join(outsider, 'precious.txt'), 'do not delete me');
    try {
      removeWorktree(repo, outsider);
      expect(fs.existsSync(path.join(outsider, 'precious.txt'))).toBe(true);
    } finally {
      fs.rmSync(outsider, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('refuses to delete a directory that is not a worktree', () => {
    const notAWorktree = path.join(root, 'looks-right', 'but-is-not');
    fs.mkdirSync(notAWorktree, { recursive: true });
    fs.writeFileSync(path.join(notAWorktree, 'keep.txt'), 'keep');
    removeWorktree(repo, notAWorktree);
    expect(fs.existsSync(path.join(notAWorktree, 'keep.txt'))).toBe(true);
  });
});

/**
 * The setup decision, made against the worktree that was just cut (CGLAB-203).
 *
 * The module that decides this had NO caller: it was complete, tested, and
 * wired to nothing, so the answer it computed reached nobody. These tests exist
 * against `createWorktree` rather than against the planner because the planner
 * was already green while the feature did not work.
 */
describe('createWorktree reports what the worktree still needs', () => {
  it('says the dependencies are missing when the repo has a manifest and no command', () => {
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture"}\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'add manifest');

    const wt = createWorktree({ repoRoot: repo, root, branchName: 'feature/needs-install' });

    expect(wt.setup.ready, 'a worktree with no node_modules reported itself usable').toBe(false);
    expect(wt.setup.notice).toMatch(/no dependencies installed/i);
  });

  it('never infers a command from the manifest', () => {
    // The expensive guess: minutes of running, wrong for any repo that needs a
    // build step or another package manager first.
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture"}\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'add manifest');

    const wt = createWorktree({ repoRoot: repo, root, branchName: 'feature/no-guess' });
    expect(wt.setup.command, 'it invented an install command').toBeNull();
  });

  it('passes the project\'s declared command through', () => {
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture"}\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'add manifest');

    const wt = createWorktree({
      repoRoot: repo, root, branchName: 'feature/declared', setupCommand: 'npm ci',
    });
    expect(wt.setup.command).toBe('npm ci');
  });

  it('reports a repo with no manifest as ready, not as missing a script', () => {
    // The fixture repo has only a README. Nothing to install is not a gap, and
    // saying "no setup declared" would send somebody to write one.
    const wt = createWorktree({ repoRoot: repo, root, branchName: 'feature/nothing' });
    expect(wt.setup.ready).toBe(true);
  });

  it('decides against the WORKTREE, not the repository it was cut from', () => {
    /*
     * They are usually the same, and a branch that adds a manifest makes them
     * differ. Measuring repoRoot would report the wrong answer for exactly the
     * directory somebody is about to work in.
     */
    git(repo, 'checkout', '-b', 'feature/adds-manifest');
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture"}\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'manifest on the branch only');
    git(repo, 'checkout', 'main');

    expect(fs.existsSync(path.join(repo, 'package.json')), 'fixture is wrong').toBe(false);

    const wt = createWorktree({ repoRoot: repo, root, branchName: 'feature/adds-manifest' });
    expect(wt.setup.ready, 'it measured the primary checkout instead of the worktree').toBe(false);
  });

  it('answers for a REUSED worktree too, not only a freshly created one', () => {
    /*
     * Adopting an existing worktree is the common case - this runs on every
     * transition into a working step. Whether its dependencies are there is a
     * fact about the directory, so a decision made only on creation would be
     * absent exactly when it is asked for most.
     */
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture"}\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'add manifest');

    const first = createWorktree({ repoRoot: repo, root, branchName: 'feature/reused' });
    const second = createWorktree({ repoRoot: repo, root, branchName: 'feature/reused' });

    expect(second.created, 'fixture did not exercise the reuse path').toBe(false);
    expect(second.setup.ready).toBe(false);
    expect(second.setup.notice).toBe(first.setup.notice);
  });
});

/**
 * Where the worktree may be made (CodeQL js/path-injection).
 *
 * `buildWorktreePath` collapses a hostile branch name into one segment -
 * `../../.ssh` becomes `ssh-2650503b` - so the string arithmetic is already
 * safe, and the five alerts on this file are the tool being unable to see
 * through it.
 *
 * What the sanitiser cannot speak for is `canonical`, which resolves SYMLINKS
 * after the arithmetic is done. That is the gap worth closing, and it is the
 * reason the check lives at the point of use rather than being trusted from
 * upstream.
 */
describe('it refuses to build outside the worktree root', () => {
  it('catches a repo directory INSIDE the root that links somewhere else', () => {
    /*
     * THE test, and it took two wrong guesses to find. No branch name can
     * produce this: the escape arrives from the FILESYSTEM, after every string
     * transformation has already been done correctly.
     *
     * Not a symlinked ROOT - that was the first guess and it is wrong. Both
     * sides are canonicalised, so a root the user deliberately placed behind a
     * link resolves consistently and the worktree still lands under it. Which
     * is the right answer, and the reason the check compares resolved against
     * resolved rather than resolved against raw.
     *
     * The real escape is one level in: `<root>/<repo>` linking elsewhere, so
     * the target resolves out from under a root that did not move.
     */
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-wt-elsewhere-'));
    fs.mkdirSync(root, { recursive: true });
    // A junction on Windows, where a symlink needs admin: it resolves out the same way.
    linkDir(elsewhere, path.join(root, repoNameFor(repo)));

    try {
      expect(() => createWorktree({ repoRoot: repo, root, branchName: 'feat/linked-out' }))
        .toThrow(/outside|symlink/i);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('never lets a branch name reach the filesystem as traversal', () => {
    /*
     * Measured on the PATH rather than by making a worktree, because git
     * refuses `../../.ssh` as a ref name before the directory is ever built -
     * which is its own layer of defence and worth knowing, but it means a
     * createWorktree call proves nothing about the path arithmetic.
     *
     * So this asserts the thing the alert is actually about: where the
     * directory would END UP.
     */
    for (const hostile of ['../../.ssh', '/etc/passwd', '....//....//etc']) {
      const built = buildWorktreePath(root, repoNameFor(repo), hostile);
      expect(built.startsWith(`${root}/`), `${hostile} escaped to ${built}`).toBe(true);
      expect(built).not.toMatch(/\.\./);
    }
  });
});

/**
 * The escape the lexical checks could not see (CodeQL js/path-injection).
 *
 * `path.resolve(x).startsWith(base)` is a STRING comparison. It collapses `..`
 * and stops - it does not follow symlinks, so a path made of innocent-looking
 * segments under the worktree area, where one segment is a link pointing out,
 * passes it. Then `git worktree add` checks out a whole repository at the
 * link's target.
 *
 * The prerequisite is not exotic in a workspace monorepo: `npm install` inside
 * a worktree creates `node_modules/@scope/pkg` links that leave it, and the
 * route that accepts this value has no token gate.
 *
 * The guard that was supposed to catch it asserted nothing: it canonicalised
 * the CALLER'S root and asked whether a path derived from that root sat inside
 * it - true by construction. Measured afterwards, it refused 0 of 40
 * attacker-chosen pairs, `root=/etc` among them.
 */
describe('a symlink pointing out of the root', () => {
  it('does not let the built path land outside the root it was given', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-wt-outside-'));
    // A link sitting where the repo segment would go, which is what an
    // install inside a worktree produces.
    fs.mkdirSync(root, { recursive: true });
    // A junction on Windows, where a symlink needs admin (and what npm makes there).
    linkDir(outside, path.join(root, repoNameFor(repo)));

    try {
      expect(() => createWorktree({ repoRoot: repo, root, branchName: 'feat/escapes' }))
        .toThrow(/outside|symlink/i);
      // And nothing was created out there on the way to refusing.
      expect(fs.readdirSync(outside), 'it wrote outside the root before refusing').toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

/**
 * GitHub #269: a failed `git worktree add` must not leave debris behind.
 *
 * git's own failure modes are what matter here, so this drives real git. The
 * failure is forced with a post-checkout hook that exits 1 (a repo-local
 * core.hooksPath, so nothing global is touched): git 2.56 then exits non-zero
 * AFTER creating the `-b` branch and registering the worktree - the same
 * half-made state a "Filename too long" checkout leaves on Windows, without
 * needing a real 260-character path. Git for Windows runs the hook through its
 * own sh, so the shebang script works on every CI shard.
 *
 * No `gitEnv` is passed: SX-3's hooks-off environment would switch the hook
 * off and the failure would never happen.
 */
describe('createWorktree rolls back what a failed `worktree add` created (#269)', () => {
  let hooks: string;

  beforeEach(() => {
    hooks = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-wt-hooks-'));
    const hook = path.join(hooks, 'post-checkout');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    git(repo, 'config', 'core.hooksPath', hooks.replace(/\\/g, '/'));
  });

  afterEach(() => {
    if (hooks && fs.existsSync(hooks)) fs.rmSync(hooks, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const targetFor = (branchName: string): string => buildWorktreePath(root, repoNameFor(repo), branchName);
  const registeredBranches = (): Array<string | null> => listWorktrees(repo).map(w => w.branchName);

  it('R1: deletes the branch it created, deregisters the worktree and removes its directory', () => {
    const branch = 'feature/hook-fails-new';
    expect(() => createWorktree({ repoRoot: repo, root, branchName: branch }))
      .toThrow(/git worktree add failed for branch 'feature\/hook-fails-new'/);

    expect(git(repo, 'branch', '--list', branch).trim(), 'the new branch was left behind').toBe('');
    expect(registeredBranches(), 'the worktree is still registered').not.toContain(branch);
    expect(listWorktrees(repo), 'something other than the main tree is registered').toHaveLength(1);
    expect(fs.existsSync(targetFor(branch)), 'the worktree directory was left behind').toBe(false);
  });

  it('R2: never deletes a branch that existed before the call, and leaves it where it was', () => {
    const branch = 'feature/hook-fails-existing';
    git(repo, 'branch', branch);
    const before = git(repo, 'rev-parse', `refs/heads/${branch}`).trim();

    expect(() => createWorktree({ repoRoot: repo, root, branchName: branch }))
      .toThrow(/git worktree add failed/);

    expect(git(repo, 'rev-parse', `refs/heads/${branch}`).trim(), 'the user\'s branch moved or vanished').toBe(before);
    expect(registeredBranches(), 'the worktree is still registered').not.toContain(branch);
    expect(fs.existsSync(targetFor(branch)), 'the worktree directory was left behind').toBe(false);
  });

  it('R3: an invalid start point surfaces git\'s reason and leaves nothing behind', () => {
    const branch = 'feature/bad-start';
    expect(() => createWorktree({ repoRoot: repo, root, branchName: branch, startPoint: 'refs/remotes/origin/does-not-exist' }))
      .toThrow(/git worktree add failed for branch 'feature\/bad-start':[^]*(invalid reference|not a valid)/i);

    expect(git(repo, 'branch', '--list', branch).trim()).toBe('');
    expect(listWorktrees(repo)).toHaveLength(1);
    expect(fs.existsSync(targetFor(branch))).toBe(false);
  });

  it('R4: never deletes a target directory that was already there before the call', () => {
    // A directory that LOOKS like a worktree (a .git file) and so would pass
    // isRemovableWorktree. git refuses to add into a non-empty directory; the
    // rollback must not then delete what the call did not create.
    const branch = 'feature/dir-was-there';
    const target = targetFor(branch);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '.git'), 'gitdir: /somewhere/else\n');
    fs.writeFileSync(path.join(target, 'precious.txt'), 'keep me');

    expect(() => createWorktree({ repoRoot: repo, root, branchName: branch })).toThrow(/git worktree add failed/);

    expect(fs.existsSync(path.join(target, 'precious.txt')), 'rollback deleted a directory it did not create').toBe(true);
    expect(git(repo, 'branch', '--list', branch).trim()).toBe('');
  });

  it('R5: a pre-existing EMPTY target directory survives the rollback', () => {
    // git accepts an empty existing directory as the add target, so here the
    // add gets far enough to register the worktree before the hook fails - and
    // `worktree remove --force` takes the whole directory with it.
    const branch = 'feature/empty-dir-was-there';
    const target = targetFor(branch);
    fs.mkdirSync(target, { recursive: true });

    expect(() => createWorktree({ repoRoot: repo, root, branchName: branch })).toThrow(/git worktree add failed/);

    expect(fs.existsSync(target), 'rollback deleted a directory that was there before the call').toBe(true);
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(registeredBranches(), 'the worktree is still registered').not.toContain(branch);
    expect(git(repo, 'branch', '--list', branch).trim(), 'the new branch was left behind').toBe('');
  });
});
