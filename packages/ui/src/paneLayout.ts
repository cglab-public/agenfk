/**
 * The pane tree as the SHELL mutates it (7a717cb8, 3b).
 *
 * TerminalTab draws a tree; something has to own the moves that produce one.
 * That was `splitId`/`splitDirection` inline in AppShell - one id, one
 * direction, one toggle - which is exactly the shape that cannot express a
 * third pane or a nested boundary. Extracted here so the moves are pure,
 * testable without a DOM, and the same functions the drop zones and the tab
 * strip both feed.
 *
 * Every function takes the tree (possibly null) and returns a tree, or the
 * INPUT unchanged when the move is not allowed. Null only ever means "no
 * explicit arrangement"; a move never returns null to mean "refused".
 */

import {
  splitLeaf, removeLeaf, moveLeaf, leaves, replaceSession,
  type PaneTree, type DropZone, type SplitDirection,
} from './splitTree';

/** The tree, or the single leaf the focused session makes. */
function orFocused(tree: PaneTree | null, activeId: string | null): PaneTree | null {
  if (tree) return tree;
  return activeId ? { type: 'leaf', sessionId: activeId } : null;
}

/**
 * A tab dropped on a pane edge.
 *
 * A session that is already a pane is MOVED, not split in again: dropping it on
 * an edge is how a nested arrangement is rearranged, and re-adding it would
 * duplicate a pane that already exists (splitLeaf refuses that, but the refusal
 * would silently do nothing).
 */
export function treeForDrop(
  tree: PaneTree | null,
  activeId: string | null,
  draggedId: string,
  targetId: string,
  zone: DropZone,
): PaneTree | null {
  const base = orFocused(tree, activeId);
  if (!base) return tree;
  if (leaves(base).includes(draggedId)) {
    return moveLeaf(base, draggedId, targetId, zone.direction, zone.placement) ?? base;
  }
  return splitLeaf(base, targetId, zone.direction, draggedId, zone.placement) ?? base;
}

/**
 * The tab strip's Split control: put the session beside the focused pane, or
 * take it out when it is already a pane.
 */
export function treeForToggle(
  tree: PaneTree | null,
  activeId: string | null,
  sessionId: string,
  direction: SplitDirection,
): PaneTree | null {
  const base = orFocused(tree, activeId);
  if (!base) return tree;
  // Unsplitting the LAST pane would leave nothing to show; it is already
  // unsplit. (The strip hides the control on the focused tab, so this is the
  // defensive half.)
  if (leaves(base).includes(sessionId)) {
    return leaves(base).length > 1 ? removeLeaf(base, sessionId) : base;
  }
  const anchor = activeId && leaves(base).includes(activeId) ? activeId : leaves(base)[0];
  if (!anchor || anchor === sessionId) return base;
  return splitLeaf(base, anchor, direction, sessionId) ?? base;
}

/** Drop the leaves whose session is gone; the survivor of each split takes its place. */
export function pruneTree(tree: PaneTree | null, isLive: (sessionId: string) => boolean): PaneTree | null {
  if (!tree) return tree;
  let next: PaneTree | null = tree;
  for (const id of leaves(tree)) {
    if (!next) break;
    if (!isLive(id)) next = removeLeaf(next, id);
  }
  return next;
}

/**
 * Show the focused tab in a pane.
 *
 * `replaceSession` keeps the shape: the boundary you dragged stays where you
 * put it and only that pane's content changes. Switching tab is not a reason to
 * lose the arrangement. `prevActive` is the pane being replaced; without it the
 * first leaf takes the new session.
 */
export function treeForFocus(
  tree: PaneTree | null,
  prevActive: string | null,
  activeId: string | null,
): PaneTree | null {
  if (!tree || !activeId) return tree;
  if (leaves(tree).includes(activeId)) return tree;
  const from = prevActive && leaves(tree).includes(prevActive) ? prevActive : leaves(tree)[0];
  return from ? replaceSession(tree, from, activeId) : tree;
}
