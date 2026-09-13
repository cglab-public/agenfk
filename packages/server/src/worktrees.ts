/**
 * CGLAB-166 — git worktrees, one per item.
 *
 * Running several coding agents at once against a single working tree is a
 * guaranteed collision: one agent's checkout rips the ground out from under
 * another's edit. A worktree per item gives each agent its own directory and
 * its own branch while sharing one object store, which is what makes parallel
 * agents safe rather than merely concurrent.
 *
 * Every git call goes through execFileSync with an argument array — never a
 * shell string. Branch names arrive from item titles and, ultimately, from
 * users; a name like `foo; rm -rf ~` must reach git as one literal argument.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildWorktreePath } from '@agenfk/core';

export interface WorktreeInfo {
  /** Absolute path of the worktree directory. */
  path: string;
  /** Branch checked out there, or null for a detached HEAD. */
  branchName: string | null;
}

export interface CreateWorktreeOptions {
  /** Root of the repository the worktree is cut from. */
  repoRoot: string;
  /** Directory that holds all worktrees (e.g. ~/.agenfk/worktrees). */
  root: string;
  branchName: string;
}

export interface CreatedWorktree extends WorktreeInfo {
  branchName: string;
  /** False when an equivalent worktree was already there and was reused. */
  created: boolean;
}

/**
 * Is this directory safe to delete as a worktree?
 *
 * A linked worktree has a `.git` FILE (a gitdir pointer), not a directory —
 * that is the cheapest reliable proof we are not about to recursively delete
 * someone's source tree or an unrelated folder.
 */
function isRemovableWorktree(target: string): boolean {
  try {
    return fs.statSync(path.join(target, '.git')).isFile();
  } catch {
    return false;
  }
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Absolute path with symlinks resolved, so two spellings of the same directory
 * compare equal. This is not cosmetic: git reports worktrees by their real
 * path, so on macOS — where /var is a symlink to /private/var, and $TMPDIR
 * lives under it — a plain path.resolve() comparison never matches what git
 * just told us. Idempotency depends on this agreeing.
 *
 * The target directory usually does not exist yet, so we realpath the deepest
 * ancestor that does and re-attach the rest.
 */
function canonical(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let head = abs;
  while (!fs.existsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) return abs;   // hit the filesystem root; nothing to resolve
    tail.unshift(path.basename(head));
    head = parent;
  }
  try {
    return path.join(fs.realpathSync(head), ...tail);
  } catch {
    return abs;
  }
}

/** The namespace a repo's worktrees live under — just its directory name. */
export function repoNameFor(repoRoot: string): string {
  return path.basename(path.resolve(repoRoot));
}

function assertGitRepo(repoRoot: string): void {
  try {
    git(repoRoot, ['rev-parse', '--git-dir']);
  } catch {
    throw new Error(`not a git repository: ${repoRoot}`);
  }
}

function branchExists(repoRoot: string, branchName: string): boolean {
  try {
    // --verify on the full ref avoids matching a tag or a remote of the same name.
    git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `git worktree list --porcelain`. Records are blank-line separated and
 * start with `worktree <path>`; the branch line is absent for a detached HEAD,
 * which is why branchName is nullable rather than defaulted to something.
 */
export function listWorktrees(repoRoot: string): WorktreeInfo[] {
  assertGitRepo(repoRoot);
  const out = git(repoRoot, ['worktree', 'list', '--porcelain']);
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> | null = null;

  const flush = (): void => {
    if (current?.path) {
      worktrees.push({ path: current.path, branchName: current.branchName ?? null });
    }
    current = null;
  };

  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ') && current) {
      current.branchName = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line.trim() === '') {
      flush();
    }
  }
  flush();
  return worktrees;
}

/**
 * Create (or adopt) the worktree for a branch.
 *
 * Idempotent on purpose: this runs on every transition into a working step, so
 * "already there" is the common case, not an error. Three states are reconciled
 * here — a live worktree is reused, a registered-but-deleted one is pruned
 * before retrying (git refuses to re-add an path it still has on file), and an
 * existing branch is checked out rather than re-created.
 */
export function createWorktree(opts: CreateWorktreeOptions): CreatedWorktree {
  const { repoRoot, root, branchName } = opts;
  assertGitRepo(repoRoot);

  const target = canonical(buildWorktreePath(root, repoNameFor(repoRoot), branchName));

  const existing = listWorktrees(repoRoot).find(w => canonical(w.path) === target);
  if (existing && fs.existsSync(target)) {
    // Adopting on path alone is not safe. Two items titled the same produce
    // the same branch slug and therefore the same directory, and a plain path
    // match would hand the second item a worktree checked out on a different
    // branch — two agents, one directory, which is the collision this whole
    // module exists to prevent.
    if (existing.branchName && existing.branchName !== branchName) {
      throw new Error(
        `Worktree at ${target} is on branch '${existing.branchName}', not '${branchName}'. ` +
        `Two items are competing for the same directory — give one of them a distinct branch name.`,
      );
    }
    return { path: target, branchName, created: false };
  }
  if (existing) {
    // Registered but gone from disk — someone deleted the directory by hand.
    // Without this, `worktree add` fails with "already exists" on a path that
    // demonstrably does not.
    git(repoRoot, ['worktree', 'prune']);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });

  const args = branchExists(repoRoot, branchName)
    ? ['worktree', 'add', target, branchName]
    : ['worktree', 'add', '-b', branchName, target];

  try {
    git(repoRoot, args);
  } catch (e: any) {
    const detail = (e?.stderr?.toString() || e?.message || '').trim();
    throw new Error(`git worktree add failed for branch '${branchName}': ${detail}`);
  }

  return { path: target, branchName, created: true };
}

/**
 * Remove a worktree directory and deregister it.
 *
 * --force is deliberate: an agent's worktree is nearly always dirty, and
 * refusing to clean up until it is pristine would strand directories forever.
 * The branch is never deleted, so committed work always survives; only the
 * checkout goes away.
 */
export function removeWorktree(repoRoot: string, worktreePath: string): void {
  assertGitRepo(repoRoot);
  const target = canonical(worktreePath);

  try {
    git(repoRoot, ['worktree', 'remove', '--force', target]);
  } catch {
    // Converge on the desired end state rather than failing a cleanup path —
    // but only ever delete something that is demonstrably a worktree.
    //
    // This fallback fires whenever `git worktree remove` fails for ANY reason,
    // including "that path belongs to a different repository". Unbounded, it
    // is a recursive delete of a caller-supplied path: two repos sharing a
    // directory basename can end up with one item's recorded path pointing at
    // the other repo's live worktree.
    if (fs.existsSync(target) && isRemovableWorktree(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    try {
      git(repoRoot, ['worktree', 'prune']);
    } catch {
      // Nothing further we can do; the directory is gone either way.
    }
  }
}
