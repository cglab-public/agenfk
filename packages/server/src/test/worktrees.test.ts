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
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
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
    fs.rmSync(first.path, { recursive: true, force: true });

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
      fs.rmSync(notARepo, { recursive: true, force: true });
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
