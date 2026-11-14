/**
 * Where a flow runs the project's suite (281adef0).
 *
 *  - 'leaf' (the default, and the behaviour before this setting existed):
 *    every card runs the project's verifyCommand on its final step.
 *  - 'parent': a card whose parent is still open closes without running it;
 *    the top-level card runs it once, over everything its children did.
 *
 * Why it exists: sibling propagation only skips a run when the tree is clean
 * at the very commit a sibling's green was recorded at, and every close commit
 * moves HEAD, so each child of a story paid a full run and the parent paid
 * another. It is a flow setting, chosen per flow, because the trade is real:
 * with 'parent' a red at the top cannot be pinned on one child.
 */

export type VerifyAt = 'leaf' | 'parent';

/** Why `value` is not a verifyAt, or null when it is (absence included). */
export function verifyAtError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return value === 'leaf' || value === 'parent'
    ? null
    : `verifyAt must be 'leaf' or 'parent', not ${JSON.stringify(value)}.`;
}

/** The flow's setting, with anything unknown read as the default. */
export function flowVerifyAt(flow: { verifyAt?: unknown } | null | undefined): VerifyAt {
  return flow?.verifyAt === 'parent' ? 'parent' : 'leaf';
}

/**
 * How far 'parent' reaches (7ddeaf7c).
 *
 *  - 'worktree' (the default, and the behaviour before this setting existed):
 *    a card defers only to a parent whose work lives in the SAME tree, because
 *    the parent's verify tests the parent's tree.
 *  - 'project': a card in another worktree defers too. Its work is then not in
 *    the tree the parent's verify runs on until it is merged there, so that
 *    verify is refused until every such child's close commit is reachable from
 *    the parent's HEAD.
 *
 * Why it exists: a project that cuts a worktree per card got nothing from
 * 'parent' - every child ran the full suite, and suites sharing one database
 * broke each other. The flow says it; a project may override it, because how a
 * repository lays out its worktrees is the repository's business, not the
 * flow's (one hub flow serves projects of both kinds).
 */
export type VerifyAtScope = 'worktree' | 'project';

const isScope = (value: unknown): value is VerifyAtScope => value === 'worktree' || value === 'project';

/** Why `value` is not a verifyAtScope, or null when it is (absence included). */
export function verifyAtScopeError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return isScope(value) ? null : `verifyAtScope must be 'worktree' or 'project', not ${JSON.stringify(value)}.`;
}

/** The scope in force: the project's own value, else the flow's, else 'worktree'. Anything unknown is skipped. */
export function effectiveVerifyAtScope(
  flow: { verifyAtScope?: unknown } | null | undefined,
  project: { verifyAtScope?: unknown } | null | undefined,
): VerifyAtScope {
  if (isScope(project?.verifyAtScope)) return project.verifyAtScope;
  if (isScope(flow?.verifyAtScope)) return flow.verifyAtScope;
  return 'worktree';
}
