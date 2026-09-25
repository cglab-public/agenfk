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
