/**
 * Keep each terminal session's branch in step with its CARD (BUG: lost on reopen).
 *
 * A session's `branchName` used to be set only on the path that OPENS it, so a
 * restored session had none - and the terminal header fell back to "no branch
 * yet" on a card whose branch the sidebar, reading the same item, showed
 * correctly. Two answers about one fact, which is the defect this epic keeps
 * finding.
 *
 * Deriving it from the item fixes both halves: the restore fills it in as soon
 * as the items load, and a branch created or renamed later stays accurate
 * instead of freezing whatever the tab happened to open with.
 *
 * Returns the SAME array when nothing changed, so an effect that depends on the
 * items does not re-render the shell on every poll.
 */

export interface BranchCarrier {
  readonly itemId: string;
  readonly branchName?: string | null;
}

export function withItemBranches<T extends BranchCarrier>(
  sessions: T[],
  items: readonly { readonly id: string; readonly branchName?: string | null }[],
): T[] {
  // No items yet (the query has not resolved) is "nothing to say", not "no
  // branch" - writing null here would blank a branch that is about to load.
  if (items.length === 0) return sessions;

  const byId = new Map(items.map(i => [i.id, i.branchName ?? null]));
  let changed = false;
  const next = sessions.map(s => {
    if (!byId.has(s.itemId)) return s;
    const branch = byId.get(s.itemId) ?? null;
    if ((s.branchName ?? null) === branch) return s;
    changed = true;
    return { ...s, branchName: branch };
  });
  return changed ? next : sessions;
}
