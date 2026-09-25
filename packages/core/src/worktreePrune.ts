/**
 * Which worktrees may be offered for removal.
 *
 * Deliberately not a retention policy. Removing a worktree when its card
 * reaches the final step is the obvious rule and the wrong one: people go back
 * to a directory after closing a card, and an automatic rule that deletes a
 * working tree is not recoverable by undo. The decision stays with the person;
 * this only decides what may be PUT IN FRONT of them.
 *
 * That still answers the real complaint — `~/.agenfk-worktrees` growing
 * without limit, one full checkout per card — because what has already piled
 * up can finally be cleared.
 */
export interface PrunableWorktree {
  readonly itemId: string;
  readonly title: string;
  readonly path: string;
  /** Why this one is being offered. Shown before anything is deleted. */
  readonly reason: string;
}

export interface PruneDeps {
  /**
   * Does this tree hold uncommitted work?
   *
   * May throw, and a throw means UNKNOWN — which is treated as dirty. A failed
   * check read as "clean" is how a tool deletes work nobody pushed.
   */
  readonly isDirty: (path: string) => boolean;
  /** The steps this project's flow treats as finished. Flows are configurable. */
  readonly finalSteps: readonly string[];
}

export function prunableWorktrees(
  items: ReadonlyArray<{ id: string; title: string; status: string; worktreePath?: string; worktreeChoice?: string }>,
  deps: PruneDeps,
): PrunableWorktree[] {
  const out: PrunableWorktree[] = [];
  for (const item of items) {
    if (!item.worktreePath) continue;
    // 686fdbf6: another card chose to run in this checkout; removing it would
    // take that card's work and leave its choice pointing at nothing.
    if (items.some(o => o.id !== item.id && o.worktreeChoice === item.worktreePath)) continue;
    // "Finished" is whatever the project's flow says, not the word DONE:
    // hardcoding it would offer nothing on a custom flow.
    if (!deps.finalSteps.includes(item.status)) continue;

    let dirty: boolean;
    try {
      dirty = deps.isDirty(item.worktreePath);
    } catch {
      // Unknown reads as "do not touch".
      continue;
    }
    if (dirty) continue;

    out.push({
      itemId: item.id,
      title: item.title,
      path: item.worktreePath,
      reason: `card is ${item.status} and its worktree has no uncommitted changes`,
    });
  }
  return out;
}
