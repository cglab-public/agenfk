/**
 * Nested splits as DATA, before any of it is drawn (7a717cb8).
 *
 * THE SHAPE IS THE ORCA ONE, because it is the smallest shape that does the
 * job and it was measured against a shipping product rather than guessed:
 *
 *   type Node = { leaf; sessionId }
 *             | { split; direction; first; second; ratio }
 *
 * A binary tree. There is no grid and no "2x2" decision: `horizontal` puts the
 * two children side by side, `vertical` stacks them, and splits NEST, so the
 * layout is built by the person dragging rather than chosen from a menu of
 * pre-baked arrangements. `ratio` is the flex of `first`, which is the same
 * number the draggable divider writes - it is per NODE now instead of per
 * window, so moving one boundary does not move the others.
 *
 * WHY PURE. The tree is where a drag GRAPH can go wrong - a leaf split twice, a
 * leaf removed leaving a one-armed node, a fifth pane past the cap - and none
 * of that needs a DOM to reproduce. The component owns pixels; this owns shape.
 *
 * THE FLOOR DOES NOT REFUSE, IT ADVISES. The previous rule disabled the split
 * button below 1184 px, which meant the product decided an arrangement was not
 * allowed. The decision here is the opposite: the app FITS what you asked for
 * and SAYS when a pane got narrow (`NARROW_PANE_PX`), because the person is
 * looking at the terminal and can judge what a wrapped line costs them. A
 * control that refuses a gesture it could have performed is the defect.
 */

export type SplitDirection = 'horizontal' | 'vertical';

export type PaneTree =
  | { readonly type: 'leaf'; readonly sessionId: string }
  | {
      readonly type: 'split';
      readonly direction: SplitDirection;
      readonly first: PaneTree;
      readonly second: PaneTree;
      /** Flex of `first`, 0..1. Persisted; a window resize never rewrites it. */
      readonly ratio: number;
    };

/** Four terminals on a laptop is already ~40 columns each. */
export const MAX_PANES = 4;

export const DEFAULT_RATIO = 0.5;

/**
 * A pane narrower than this is ADVISED about, never refused.
 *
 * 40 columns: below the 80 an agent TUI wants, so the line wraps and the reader
 * should know why. It is a warning threshold, not a gate.
 */
export const NARROW_PANE_PX = 360;

/**
 * How much of a pane's edge counts as its drop zone, and the tab strip that
 * does NOT (dragging a tab across the top is a reorder, not a split).
 *
 * Both numbers are Orca's (`resolvePaneColumnEdgeZone`): 20% of the body on
 * each edge, and 32 px of strip excluded.
 */
export const EDGE_FRACTION = 0.2;
export const TAB_STRIP_PX = 32;

/** Every pane in reading order. */
export function leaves(tree: PaneTree | null | undefined): string[] {
  if (!tree) return [];
  if (tree.type === 'leaf') return [tree.sessionId];
  return [...leaves(tree.first), ...leaves(tree.second)];
}

export function paneCount(tree: PaneTree | null | undefined): number {
  return leaves(tree).length;
}

/**
 * Split `targetSessionId` into two, putting `newSessionId` on `placement`'s side.
 *
 * Returns null when the cap is reached, so the CALLER can say "at most four"
 * rather than silently dropping the gesture - a control that does nothing is
 * worse than one that explains.
 */
export function splitLeaf(
  tree: PaneTree,
  targetSessionId: string,
  direction: SplitDirection,
  newSessionId: string,
  placement: 'before' | 'after' = 'after',
): PaneTree | null {
  if (paneCount(tree) >= MAX_PANES) return null;
  if (targetSessionId === newSessionId) return null;
  return replaceLeaf(tree, targetSessionId, leaf => {
    const added: PaneTree = { type: 'leaf', sessionId: newSessionId };
    return {
      type: 'split',
      direction,
      first: placement === 'before' ? added : leaf,
      second: placement === 'before' ? leaf : added,
      ratio: DEFAULT_RATIO,
    };
  });
}

/**
 * Remove a pane; its parent collapses into the sibling.
 *
 * Returns null when that was the last pane - the caller decides what an empty
 * layout means (close the view), rather than this inventing one.
 */
export function removeLeaf(tree: PaneTree, sessionId: string): PaneTree | null {
  if (tree.type === 'leaf') return tree.sessionId === sessionId ? null : tree;
  const first = removeLeaf(tree.first, sessionId);
  const second = removeLeaf(tree.second, sessionId);
  if (first && second) return { ...tree, first, second };
  // One side went: the survivor takes the parent's place.
  return first ?? second;
}

/** The tree with `sessionId` dropped back in beside `targetSessionId`. */
export function moveLeaf(
  tree: PaneTree,
  sessionId: string,
  targetSessionId: string,
  direction: SplitDirection,
  placement: 'before' | 'after' = 'after',
): PaneTree | null {
  if (sessionId === targetSessionId) return tree;
  const without = removeLeaf(tree, sessionId);
  if (!without) return null;
  return splitLeaf(without, targetSessionId, direction, sessionId, placement);
}

/** Set the ratio of the split that owns `sessionId` as one of its leaves. */
export function setRatio(tree: PaneTree, sessionId: string, ratio: number): PaneTree {
  const clamped = Math.min(1, Math.max(0, ratio));
  if (tree.type === 'leaf') return tree;
  if (leaves(tree.first).includes(sessionId)) return { ...tree, ratio: clamped };
  if (leaves(tree.second).includes(sessionId)) return { ...tree, ratio: clamped };
  return tree;
}

export interface DropZone {
  readonly direction: SplitDirection;
  readonly placement: 'before' | 'after';
}

/**
 * Which edge of a pane a pointer at (x, y) is asking to split at, or null.
 *
 * Relative to the pane, not the window. The TOP zone starts below the tab strip
 * because the strip is where a tab is dragged to REORDER - treating it as a
 * split edge made reordering impossible.
 *
 * When two edges qualify (a corner), the CLOSER one wins; a corner is not
 * ambiguous to the person, it is the edge they were heading for.
 */
export function dropZone(
  width: number,
  height: number,
  x: number,
  y: number,
  tabStripPx: number = TAB_STRIP_PX,
): DropZone | null {
  if (!(width > 0) || !(height > 0)) return null;
  const bodyTop = Math.min(tabStripPx, height);
  const bodyHeight = Math.max(0, height - bodyTop);
  if (bodyHeight <= 0) return null;

  const hThreshold = width * EDGE_FRACTION;
  const vThreshold = bodyHeight * EDGE_FRACTION;

  const candidates: { zone: DropZone; distance: number }[] = [];
  if (x < hThreshold) candidates.push({ zone: { direction: 'horizontal', placement: 'before' }, distance: x });
  if (x > width - hThreshold) candidates.push({ zone: { direction: 'horizontal', placement: 'after' }, distance: width - x });
  if (y > bodyTop && y < bodyTop + vThreshold) {
    candidates.push({ zone: { direction: 'vertical', placement: 'before' }, distance: y - bodyTop });
  }
  if (y > height - vThreshold) candidates.push({ zone: { direction: 'vertical', placement: 'after' }, distance: height - y });

  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (c.distance < best.distance ? c : best)).zone;
}

/** Walk the tree and rebuild it with one leaf replaced. */
function replaceLeaf(tree: PaneTree, sessionId: string, make: (leaf: PaneTree) => PaneTree): PaneTree {
  if (tree.type === 'leaf') return tree.sessionId === sessionId ? make(tree) : tree;
  const first = replaceLeaf(tree.first, sessionId, make);
  const second = replaceLeaf(tree.second, sessionId, make);
  return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
}
