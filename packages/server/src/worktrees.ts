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
import { buildWorktreePath, containedPath } from '@agenfk/core';
import { planWorktreeSetup, type SetupDecision } from './worktreeSetup.js';

/**
 * Files that mean "this repository has dependencies to install".
 *
 * Presence only. What to DO about them is never inferred from this list - see
 * worktreeSetup - because a manifest says a repo has dependencies, not how it
 * is built.
 */
const MANIFESTS = [
  'package.json', 'Cargo.toml', 'go.mod', 'go.work', 'requirements.txt',
  'pyproject.toml', 'Pipfile', 'Gemfile', 'composer.json',
  // Gradle's Kotlin DSL is the current default, so `build.gradle` alone catches
  // only the Groovy form - and the miss is silent: the worktree reports itself
  // READY, which is a confident wrong answer rather than an absent one.
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'pom.xml', 'mix.exs', 'Package.swift',
];

/** Extensions that are a manifest whatever the file is called. */
const MANIFEST_EXTENSIONS = ['.csproj', '.fsproj', '.sln'];

function hasManifest(dir: string): boolean {
  if (MANIFESTS.some(m => fs.existsSync(path.join(dir, m)))) return true;
  /*
   * .NET names its project file after the project, so there is no fixed name
   * to look for. Directory read rather than a guessed filename, and it is the
   * reason this is not a plain list.
   */
  try {
    return fs.readdirSync(dir).some(f => MANIFEST_EXTENSIONS.some(e => f.endsWith(e)));
  } catch {
    // An unreadable directory is not evidence of anything. Reporting "no
    // manifest" would hand back a confident READY for a worktree we could not
    // even list.
    return false;
  }
}

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
  /**
   * Where a NEW branch starts from, when there is no local branch of that name.
   *
   * Ignored when the branch already exists locally — that checkout is the
   * user's own work and must not be re-pointed at something else.
   *
   * This exists because of a defect found in review: importing a pull request
   * fetched `refs/remotes/origin/<branch>` and then got a worktree with none of
   * the PR's commits in it. `branchExists` only looks at `refs/heads/`, so a
   * freshly fetched branch took the `-b` arm with no start point, and `-b` with
   * no commit-ish branches from local HEAD. The directory was named after the
   * PR and contained the local main — which is worse than failing, because an
   * agent then works in it and pushes.
   */
  startPoint?: string;
  /**
   * The project's declared setup command, when it has one (CGLAB-203).
   *
   * Passed in rather than read here: this module knows about git, not about
   * projects, and a worktree module that reached for storage would be two
   * concerns in one place.
   */
  setupCommand?: string | null;
}

export interface CreatedWorktree extends WorktreeInfo {
  branchName: string;
  /** False when an equivalent worktree was already there and was reused. */
  created: boolean;
  /**
   * What still has to happen before anybody can work in here (CGLAB-203).
   *
   * Always present, including on a reused worktree: whether its dependencies
   * are installed is a fact about the DIRECTORY, not about whether this call
   * made it, and reporting it only on creation would leave the common case -
   * adopting an existing worktree - silent about the thing most likely to be
   * wrong with it.
   */
  setup: SetupDecision;
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
  const { repoRoot, root, branchName, startPoint, setupCommand } = opts;
  assertGitRepo(repoRoot);

  /*
   * CONTAINMENT ASSERTED AT THE POINT OF USE, after `canonical`.
   *
   * `buildWorktreePath` already collapses a hostile branch name into one
   * segment - `../../.ssh` becomes `ssh-2650503b` - so the arithmetic is safe.
   * What it cannot speak for is `canonical`, which resolves SYMLINKS: if the
   * worktree root, or the repo segment under it, is a link pointing elsewhere,
   * the resolved target lands outside `root` while every string operation
   * before it looked correct.
   *
   * So the check is here rather than trusted from upstream, and it uses the
   * returned value: everything below operates on a path that was verified
   * AFTER every transformation, not before them.
   */
  const target = containedPath(canonical(root), canonical(buildWorktreePath(root, repoNameFor(repoRoot), branchName)));
  if (target === null) {
    throw new Error(
      `Refusing to make a worktree outside ${root}. The branch name is sanitised before it `
      + 'becomes a directory, so this means the worktree root or a directory under it is a '
      + 'symlink pointing somewhere else.',
    );
  }

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
    /*
     * The setup decision is made against the EXISTING directory, not skipped.
     * A reused worktree is the common case, and whether its node_modules are
     * there is a fact about the directory rather than about this call.
     */
    return { path: target, branchName, created: false, setup: planWorktreeSetup({ declared: setupCommand, hasManifest: hasManifest(target) }) };
  }
  if (existing) {
    // Registered but gone from disk — someone deleted the directory by hand.
    // Without this, `worktree add` fails with "already exists" on a path that
    // demonstrably does not.
    git(repoRoot, ['worktree', 'prune']);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });

  // `-b` with no commit-ish branches from whatever HEAD happens to be. When
  // the caller knows where the branch should start — a fetched remote ref —
  // say so, or the directory is named after work it does not contain.
  const args = branchExists(repoRoot, branchName)
    ? ['worktree', 'add', target, branchName]
    : startPoint
      ? ['worktree', 'add', '-b', branchName, target, startPoint]
      : ['worktree', 'add', '-b', branchName, target];

  try {
    git(repoRoot, args);
  } catch (e: any) {
    const detail = (e?.stderr?.toString() || e?.message || '').trim();
    throw new Error(`git worktree add failed for branch '${branchName}': ${detail}`);
  }

  /*
   * Measured on the NEW worktree rather than on repoRoot. They are usually the
   * same repository, but a branch that adds or removes a manifest makes them
   * differ - and the directory somebody is about to work in is the one whose
   * answer matters.
   */
  return {
    path: target,
    branchName,
    created: true,
    setup: planWorktreeSetup({ declared: setupCommand, hasManifest: hasManifest(target) }),
  };
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
