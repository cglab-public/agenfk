/**
 * Turning a reviewed proposal into the rows a person ticks through, and the
 * kept rows into cards.
 *
 * Kept out of the component because two things here are easy to get wrong in a
 * way no screenshot shows: what "kept" means for a row whose parent was
 * dropped, and the ORDER cards must be created in. Both are decisions, so they
 * are named functions with tests rather than inline logic in a handler.
 */
import type { ItemType } from './types';

export interface ReviewedItem {
  ref: string;
  type: ItemType | string;
  title: string;
  description?: string;
  parentRef?: string | null;
  depth: number;
}

export interface ProposalIssue {
  index?: number;
  ref?: string;
  message: string;
}

export interface ReviewedProposal {
  objective: string;
  items: ReviewedItem[];
  issues: ProposalIssue[];
  contractVersion?: number | null;
}

/**
 * A row disappears when it is dropped — AND when anything it hangs off is
 * dropped.
 *
 * Creating a child whose parent was refused would put an orphan on the board
 * with a parent id that never existed, which is worse than either outcome the
 * person chose. So dropping a parent drops its subtree, and the screen says so
 * rather than silently keeping rows that can no longer be created.
 */
export function keptItems(items: readonly ReviewedItem[], dropped: ReadonlySet<string>): ReviewedItem[] {
  const gone = new Set(dropped);
  let changed = true;
  // Repeat until stable: a grandchild only becomes unreachable once its
  // parent has been removed by its own parent going.
  while (changed) {
    changed = false;
    for (const item of items) {
      if (gone.has(item.ref)) continue;
      if (item.parentRef && gone.has(item.parentRef)) {
        gone.add(item.ref);
        changed = true;
      }
    }
  }
  return items.filter(i => !gone.has(i.ref));
}

/**
 * Parents before children, always.
 *
 * Creation is one POST per item and a child needs its parent's real id, which
 * only exists once the parent is created. The agent's array order is not a
 * guarantee — `parentRef` may point forwards — so the order is derived here
 * rather than trusted.
 *
 * A ref whose parent is not in the kept set is treated as a root: `keptItems`
 * has already removed anything orphaned by a drop, so what remains is an item
 * whose parent was never proposed, and a root is the honest reading of that.
 */
export function creationOrder(items: readonly ReviewedItem[]): ReviewedItem[] {
  const byRef = new Map(items.map(i => [i.ref, i]));
  const ordered: ReviewedItem[] = [];
  const placed = new Set<string>();
  const place = (item: ReviewedItem, seen: Set<string>): void => {
    if (placed.has(item.ref) || seen.has(item.ref)) return;
    seen.add(item.ref);
    const parent = item.parentRef ? byRef.get(item.parentRef) : undefined;
    if (parent) place(parent, seen);
    if (!placed.has(item.ref)) {
      placed.add(item.ref);
      ordered.push(item);
    }
  };
  for (const item of items) place(item, new Set());
  return ordered;
}

/** The issues that belong to one row, matched on ref rather than index. */
export function issuesFor(issues: readonly ProposalIssue[], ref: string): ProposalIssue[] {
  return issues.filter(i => i.ref === ref);
}

/** Issues about the proposal itself, which no row can carry. */
export function treeIssues(issues: readonly ProposalIssue[]): ProposalIssue[] {
  return issues.filter(i => !i.ref);
}
