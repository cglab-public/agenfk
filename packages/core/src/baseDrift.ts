/**
 * How far a card's branch has fallen behind, and what to say about it
 * (CGLAB-197).
 *
 * An agent that starts work against a base that has moved is working against a
 * world that no longer exists, and finds out at the merge - which is the most
 * expensive moment available.
 *
 * TWO HALVES, AND THEY ARE INDEPENDENT. That separation is the whole design,
 * and collapsing it is the obvious mistake:
 *
 *   THE WARNING GOES OUT whenever the branch is behind at all, with what
 *   landed. Knowing the base moved is useful even when the dispatch proceeds
 *   normally - most drift is harmless and worth a glance, not a stop.
 *
 *   THE THRESHOLD ONLY DECIDES WHETHER THE DISPATCH WAITS. It is a SKIP: the
 *   card stays ready and is picked up again next round, not refused for good.
 *
 * Tying the warning to the threshold produces the worst design available -
 * blocking silently below it, and saying nothing until it is too late to be
 * cheap.
 *
 * Injectable runner, like closeCommit and gitStatus, so the ARGUMENT LIST is
 * something a test can read back. Every git defect found in this server was
 * invisible until the arguments were observable.
 */

/** Commits behind before a dispatch waits for a rebase. */
export const DISPATCH_STALE_THRESHOLD = 20;

export interface BaseDriftDeps {
  /** Run git with these arguments and return stdout. Throws if git fails. */
  readonly run: (args: string[]) => string;
}

export interface BaseDrift {
  /** Commits on the base that this branch does not have. */
  readonly behind: number;
  /** The base it was compared against. */
  readonly base: string;
  /** Subjects of what landed, newest first. Empty when not behind. */
  readonly landed: readonly string[];
  /**
   * Whether the dispatch should WAIT. Never a permanent refusal - the card
   * stays ready and is retried, so this is "not yet" rather than "no".
   */
  readonly shouldWait: boolean;
  /**
   * What to tell the agent, or null when the branch is current.
   *
   * Present whenever it is behind AT ALL, independent of `shouldWait`: the
   * point of the warning is that it arrives while acting on it is still cheap.
   */
  readonly notice: string | null;
}

const CURRENT = (base: string): BaseDrift =>
  ({ behind: 0, base, landed: [], shouldWait: false, notice: null });

/**
 * Measure one branch against its base.
 *
 * Never throws. A card being dispatched is a workflow fact, and failing to
 * measure drift must not stop it - an unmeasurable branch reports as current,
 * which is the generous reading and the one that cannot invent a blockage.
 */
export function measureBaseDrift(
  branch: string,
  base: string,
  repoRoot: string,
  deps: BaseDriftDeps,
  threshold: number = DISPATCH_STALE_THRESHOLD,
): BaseDrift {
  const at = (...args: string[]): string[] => ['-C', repoRoot, ...args];

  let behind = 0;
  try {
    // `base..branch` counts what BASE has and branch does not. The direction
    // is easy to reverse and the reversed number is meaningless but plausible,
    // which is the worst kind of wrong.
    const out = deps.run(at('rev-list', '--count', `${branch}..${base}`));
    behind = Number.parseInt(out.trim(), 10);
  } catch {
    return CURRENT(base);
  }
  if (!Number.isFinite(behind) || behind <= 0) return CURRENT(base);

  let landed: string[] = [];
  try {
    /*
     * The SUBJECTS, not the count alone. "20 commits behind" tells an agent
     * nothing it can act on; "the file you are about to edit was rewritten"
     * does, and it can only see that if it is told what landed.
     */
    const log = deps.run(at('log', '--format=%s', '--max-count=10', `${branch}..${base}`));
    landed = log.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    landed = [];
  }

  const shouldWait = behind > threshold;
  return {
    behind,
    base,
    landed,
    shouldWait,
    notice:
      `The base ${base} has moved: ${behind} commit${behind === 1 ? '' : 's'} you do not have.\n`
      + landed.map(s => `  - ${s}`).join('\n')
      + (shouldWait
        ? `\nThat is past the ${threshold}-commit threshold, so this dispatch waits for a rebase. `
          + 'The card stays ready and will be picked up again.'
        : '\nIf any of that touches what you are about to change, pull it in first.'),
  };
}

/**
 * Where the drift is measured FROM: `origin/HEAD`, then the local default.
 *
 * Mirrors Orca's `getBaseRefDefault`. An item has no recorded base of its own
 * yet, so this always answers the repository default; a `baseBranch` field on
 * the item would slot in ahead of it, the way `worktreeMeta.baseRef` does in
 * Orca.
 *
 * THE REMOTE SYMREF IS VERIFIED, not trusted. `symbolic-ref` reads the link
 * without dereferencing its target, so a dangling `origin/HEAD` left behind by
 * a renamed or pruned default branch reads back happily - and the `rev-list`
 * that follows would throw, reporting a stale branch as current and saying
 * nothing. Probing the target turns that into a fall-through.
 */
export function resolveBaseBranch(repoRoot: string, deps: BaseDriftDeps): string | null {
  const at = (...args: string[]): string[] => ['-C', repoRoot, ...args];
  try {
    const head = deps.run(at('symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).trim();
    if (head) {
      // Throws when the symref is dangling; then we try the local defaults.
      deps.run(at('rev-parse', '--verify', '--quiet', head));
      return head;
    }
  } catch { /* no usable origin/HEAD; fall through */ }
  for (const candidate of ['main', 'master']) {
    try {
      // `refs/heads/`, not the bare name: gitrevisions resolves `refs/tags/main`
      // before `refs/heads/main`, so a tag named main would win silently.
      deps.run(at('rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`));
      return candidate;
    } catch { /* try the next */ }
  }
  return null;
}

/**
 * The branch to measure and the tree to measure it from, or null when there is
 * no tree at all.
 *
 * A CHILD HAS NO BRANCH OF ITS OWN, and this is the correction that matters.
 * `agenfk branch create` refuses a child, `shouldAutoWorktree` refuses it a
 * tree, and several agents share the parent's - so a child's branch IS its
 * nearest ancestor's. Treating the parent's branch as the BASE (the first
 * version of this wire did) measured nothing and reported `<parent>..<parent>`
 * as zero.
 *
 * The walk goes ALL THE WAY UP, not one level. In the EPIC -> STORY -> TASK
 * shape this framework mandates, a STORY is itself a child and was therefore
 * refused a branch too, so a TASK two levels down found nothing and went
 * silent - the common case, not an edge one.
 *
 * WITH NO BRANCH ANYWHERE, THE BRANCH IS `HEAD`. The alternative is the notice
 * never firing for an EPIC-rooted tree that nobody manually branched, which is
 * most projects; `git rev-list HEAD..<base>` is a true answer in the tree the
 * agent is about to edit either way.
 */
export function driftTargets(
  task: DriftNode,
  items: readonly DriftNode[],
  projectRoot?: string,
): { branch: string; repoRoot: string } | null {
  const byId = new Map(items.map(i => [i.id, i]));
  let branch = task.branchName || undefined;
  // 686fdbf6: a card's (or an ancestor's) chosen tree settles it: 'root' is the project root.
  const ownTree = (n: DriftNode): { settled: boolean; tree?: string } =>
    n.worktreeChoice === 'root' ? { settled: true }
      : n.worktreeChoice ? { settled: true, tree: n.worktreeChoice }
        : n.worktreePath ? { settled: true, tree: n.worktreePath } : { settled: false };
  let { settled: treeSettled, tree } = ownTree(task);
  let cursor: DriftNode | undefined = task;
  const visited = new Set<string>();
  while (cursor?.parentId && !visited.has(cursor.parentId)) {
    if (branch && treeSettled) break;
    visited.add(cursor.parentId);
    const parent = byId.get(cursor.parentId);
    if (!parent) break;
    branch = branch || parent.branchName || undefined;
    if (!treeSettled) ({ settled: treeSettled, tree } = ownTree(parent));
    cursor = parent;
  }
  const repoRoot = tree || projectRoot;
  if (!repoRoot) return null;
  return { branch: branch || 'HEAD', repoRoot };
}

interface DriftNode {
  readonly id?: string;
  readonly branchName?: string;
  readonly worktreePath?: string;
  readonly worktreeChoice?: string;
  readonly parentId?: string | null;
}

/**
 * The notice for the gatekeeper, or '' when there is nothing to say.
 *
 * NEVER THROWS, and never blocks - the gatekeeper runs before every edit, so a
 * repository it cannot read must not become a reason the edit is refused. The
 * threshold lives in `shouldWait` and belongs to the dispatcher (the fan-out
 * sheet, CGLAB-206/207): this only tells the agent what moved, which is useful
 * on its own and arrives while acting on it is still cheap.
 */
export function dispatchDriftNotice(opts: {
  readonly branch?: string;
  readonly repoRoot?: string;
  readonly deps: BaseDriftDeps;
}): string {
  const { branch, repoRoot, deps } = opts;
  if (!branch || !repoRoot) return '';
  const base = resolveBaseBranch(repoRoot, deps);
  if (!base) return '';
  const drift = measureBaseDrift(branch, base, repoRoot, deps);
  return drift.notice ? `\n\n${drift.notice}` : '';
}
