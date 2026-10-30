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
import { buildWorktreePath, containedPath, resolveThroughLinks } from '@agenfk/core';
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
  /** The environment `git worktree add` runs with (SX-3: hooks off for a card an Airlock sandbox touched). */
  gitEnv?: NodeJS.ProcessEnv;
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

/*
 * GitHub #269: `-c core.longpaths=true` on EVERY call, on every platform.
 *
 * Git for Windows otherwise refuses any path past MAX_PATH (260), and a
 * worktree nests the whole repo under the worktree root (by default
 * ~/.agenfk-worktrees/<repo>/<branch-slug>-<digest>, see buildWorktreePath),
 * so a deep file that checks out fine in the main clone fails in its worktree.
 * Per-invocation rather than `git config`: nothing global or repo-local is
 * written, and off Windows the option is a no-op. It goes on every call - not
 * only `worktree add` - because status/remove/prune walk the same paths.
 */
const LONGPATHS = ['-c', 'core.longpaths=true'];

const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): string =>
  execFileSync('git', [...LONGPATHS, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...(env ? { env } : {}) });

/** git redraws its progress with `\r`; these lines are noise in an error. */
const PROGRESS_LINE = /^(Updating files:|Preparing worktree\b)/;
const TOO_LONG = /file ?name too long/i;

/**
 * Turn `git worktree add`'s stderr into the message the user sees (#269).
 *
 * Pure, so the wording is testable without git. A too-long path is named as
 * such, in our words, with the first file git could not create - and without
 * advising `core.longpaths`, which every call here already passes. Anything
 * else keeps git's own detail, minus the progress redraws.
 *
 * Only called after createWorktree's rollback has run. The rollback's outcome
 * is passed in rather than assumed: the too-long message claims a clean slate
 * only when the state after the rollback was checked and found clean, and any
 * failure whose rollback was incomplete names what to remove by hand. Omitted,
 * the outcome defaults to clean (the pure tests and any caller that ran no
 * rollback).
 */
export function describeWorktreeAddFailure(
  branchName: string, stderr: string, rollback: RollbackOutcome = { clean: true, remains: [] },
): string {
  const prefix = `git worktree add failed for branch '${branchName}': `;
  const lines = (stderr ?? '')
    .split(/\r\n|\r|\n/)
    .map(l => l.trim())
    .filter(l => l !== '' && !PROGRESS_LINE.test(l));
  const leftovers = rollback.clean ? '' : describeLeftovers(rollback.remains);

  if (!lines.some(l => TOO_LONG.test(l))) {
    return prefix + (lines.length ? lines.join('\n') : 'git gave no further detail.') + (leftovers ? `\n${leftovers}` : '');
  }

  let culprit: string | null = null;
  for (const l of lines) {
    // Greedy on the name: a file name may itself contain ": ".
    const file = /unable to create file (.+): [^:]+$/i.exec(l);
    const dir = /cannot create directory at '(.+)'/i.exec(l);
    culprit = file?.[1] ?? dir?.[1] ?? null;
    if (culprit) break;
  }

  return prefix
    + 'the worktree path is too long for this system'
    + (culprit ? ` - git could not create '${culprit}'` : '')
    + '. Long-path support is already requested on every git call, so either the full path '
    + 'may still exceed the operating-system limit (on Windows, check that long-path support is enabled) '
    + 'or a single file or folder name is longer than 255 characters. '
    + 'Move the worktree root or the repository to a shorter path and try again. '
    + (rollback.clean ? 'Nothing was left behind: what this attempt created was rolled back.' : leftovers);
}

/** Something a failed `worktree add` made that its rollback could not undo. */
export interface Leftover {
  kind: 'branch' | 'directory' | 'registration';
  /** Branch name, or the path of the directory / registered worktree. */
  name: string;
}

/** What the rollback left, judged by the state AFTER it ran - not by which steps threw. */
export interface RollbackOutcome {
  clean: boolean;
  remains: Leftover[];
}

function describeLeftovers(remains: Leftover[]): string {
  const parts = remains.map(r =>
    r.kind === 'branch' ? `branch '${r.name}' (git branch -D ${r.name})`
      : r.kind === 'directory' ? `directory '${r.name}'`
        : `worktree registration for '${r.name}' (git worktree remove --force ${r.name})`);
  return 'The rollback was incomplete; '
    + (parts.length ? `still there: ${parts.join(', ')}. Remove ${parts.length > 1 ? 'them' : 'it'} by hand before retrying.`
      : 'its state could not be confirmed. Check for a leftover branch or worktree by hand before retrying.');
}

/**
 * Undo what a failed `worktree add` created, best effort (#269).
 *
 * git can fail AFTER creating the `-b` branch and registering the worktree
 * (a checkout that dies on a too-long path, a failing post-checkout hook, and
 * - on git 2.56 - even a target that already exists). Left alone, the next
 * attempt then trips over its own debris.
 *
 * The rule is "only undo what this call made": a branch or directory that was
 * there before is never touched. Every step swallows its own error - the
 * caller reports the ORIGINAL failure, never a rollback's - and the outcome is
 * judged afterwards by looking at what is actually there, because on Windows a
 * step can "succeed" or fail for reasons (a file held open by antivirus) that
 * the exit status alone does not tell you.
 */
function rollbackWorktreeAdd(
  repoRoot: string, target: string, branchName: string,
  before: { branchExisted: boolean; dirExisted: boolean },
): RollbackOutcome {
  const isRegistered = (): boolean | null => {
    try {
      return listWorktrees(repoRoot).some(w => canonical(w.path) === target);
    } catch {
      return null; // unknown
    }
  };

  if (isRegistered()) {
    try { git(repoRoot, ['worktree', 'remove', '--force', target]); } catch { /* best effort */ }
  }
  if (!before.dirExisted && fs.existsSync(target) && isRemovableWorktree(target)) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  try { git(repoRoot, ['worktree', 'prune']); } catch { /* best effort */ }
  if (!before.branchExisted && branchExists(repoRoot, branchName)) {
    try { git(repoRoot, ['branch', '-D', branchName]); } catch { /* best effort */ }
  }
  /*
   * git accepts an EMPTY existing directory as the add target, and
   * `worktree remove --force` then takes it away with the rest. The directory
   * was there before the call, so it is put back - empty, as git found it
   * (git refuses a non-empty one before touching anything).
   */
  if (before.dirExisted && !fs.existsSync(target)) {
    try { fs.mkdirSync(target, { recursive: true }); } catch { /* reported below */ }
  }

  const remains: Leftover[] = [];
  let unknown = false;
  const registered = isRegistered();
  if (registered === null) unknown = true;
  else if (registered) remains.push({ kind: 'registration', name: target });
  if (!before.dirExisted && fs.existsSync(target)) remains.push({ kind: 'directory', name: target });
  if (before.dirExisted && !fs.existsSync(target)) unknown = true; // the user's directory is gone and could not be restored
  if (!before.branchExisted && branchExists(repoRoot, branchName)) remains.push({ kind: 'branch', name: branchName });

  return { clean: !unknown && remains.length === 0, remains };
}

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
  // One implementation, in core. This was a line-for-line copy of the same walk
  // in server.ts - two copies of a security primitive is two places for it to
  // drift, and the drift would be silent.
  return resolveThroughLinks(p, {
    resolve: path.resolve, dirname: path.dirname, basename: path.basename,
    join: path.join, exists: fs.existsSync, realpath: fs.realpathSync,
  });
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
   * CONTAINMENT, AND THE VERSION THAT MEANT NOTHING.
   *
   * This was `containedPath(canonical(root), canonical(built))`, with a comment
   * claiming it caught symlinked roots. It caught nothing: `root` is the
   * caller's string, so resolving it and then asking whether a path DERIVED
   * from it sits inside the resolved version of itself is a tautology. Tested
   * afterwards, it refused 0 of 40 attacker-chosen pairs - `root=/etc` and
   * `root=/` both sailed through. The fence and the thing inside it came from
   * the same hand.
   *
   * What this can honestly assert is narrower and still worth having: the path
   * BUILT from the branch name stays under the root it was given. That catches
   * a symlink in the repo or slug segments, which is the part this module
   * owns.
   *
   * WHAT IT CANNOT DO IS VALIDATE ITS OWN `root`. Nothing here knows which
   * roots are legitimate; only the caller does. `POST /items/:id/worktree`
   * takes that from the request body and is where the real check belongs -
   * see the resolve-then-compare there, which follows symlinks rather than
   * comparing strings.
   */
  const base = canonical(root);
  const target = containedPath(base, canonical(buildWorktreePath(root, repoNameFor(repoRoot), branchName)));
  if (target === null) {
    throw new Error(
      `Refusing to make a worktree outside ${root}: the path built from the branch name `
      + 'resolves somewhere else, which means a directory under the root is a symlink.',
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
     * A reused worktree is the common case, and whether its dependencies are
     * there is a fact about the directory rather than about this call.
     */
    return { path: target, branchName, created: false, setup: planWorktreeSetup({ declared: setupCommand, hasManifest: hasManifest(target), reused: true }) };
  }
  if (existing) {
    // Registered but gone from disk — someone deleted the directory by hand.
    // Without this, `worktree add` fails with "already exists" on a path that
    // demonstrably does not.
    git(repoRoot, ['worktree', 'prune']);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });

  // Recorded BEFORE the add, so the rollback only ever undoes what it made.
  const branchExisted = branchExists(repoRoot, branchName);
  const dirExisted = fs.existsSync(target);

  // `-b` with no commit-ish branches from whatever HEAD happens to be. When
  // the caller knows where the branch should start — a fetched remote ref —
  // say so, or the directory is named after work it does not contain.
  const args = branchExisted
    ? ['worktree', 'add', target, branchName]
    : startPoint
      ? ['worktree', 'add', '-b', branchName, target, startPoint]
      : ['worktree', 'add', '-b', branchName, target];

  try {
    // SX-3: a covered card's worktree is added with the repository's hooks off (post-checkout is its code).
    git(repoRoot, args, opts.gitEnv);
  } catch (e: any) {
    const stderr = e?.stderr?.toString() || e?.message || '';
    const outcome = rollbackWorktreeAdd(repoRoot, target, branchName, { branchExisted, dirExisted });
    throw new Error(describeWorktreeAddFailure(branchName, stderr, outcome));
  }

  /*
   * Measured on the NEW worktree rather than on repoRoot. They are usually the
   * same repository, but a branch that adds or removes a manifest makes them
   * differ - and the directory somebody is about to work in is the one whose
   * answer matters.
   */
  /*
   * PLANNED, not executed. A fresh worktree certainly needs its dependencies,
   * but running the install HERE would run it inside the status transition that
   * created the worktree, and a dependency install takes minutes - the same
   * reason `verify` runs in the background rather than in its request. The CALLER starts the
   * command and posts the outcome (712a4752); this stays a pure decision.
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
