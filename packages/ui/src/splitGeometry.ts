/**
 * The tree, as rectangles (7a717cb8).
 *
 * The component draws what this returns; nothing here touches the DOM, so the
 * arithmetic - where the boundary lands, which pane is narrow, which split a
 * divider belongs to - is testable on its own.
 *
 * THE RATIO CLAMP IS NOT A REFUSAL. A ratio of 0 or 1 is a zero-width pane,
 * which is not a layout, it is a disappearance; the clamp keeps a pane
 * reachable. Once the pane is real but narrow, this only MARKS it (`narrow`):
 * the app fits what was asked for and says when a column got tight, rather than
 * refusing the gesture the way the old 1184px gate did.
 */

import { NARROW_PANE_PX, type PaneTree, type SplitDirection } from './splitTree';

export interface PaneRect {
  readonly sessionId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Narrower or shorter than a terminal wants. Advisory, never hidden. */
  readonly narrow: boolean;
}

export interface DividerInfo {
  /** The split's path from the root; the same key `setRatioAtPath` takes. */
  readonly path: readonly number[];
  readonly direction: SplitDirection;
  /** Start of the divider line, in the same coordinates as the pane rects. */
  readonly x: number;
  readonly y: number;
  /** Its length: the pane extent it separates. */
  readonly length: number;
  /**
   * The rect of the split this divider belongs to.
   *
   * A ratio is relative to ITS OWN node, not to the window. Without this a
   * nested divider can only be dragged as if it were the root, which moves the
   * wrong boundary as soon as the tree is more than one split deep.
   */
  readonly parent: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface SplitLayout {
  readonly panes: readonly PaneRect[];
  readonly dividers: readonly DividerInfo[];
}

/** Keeps a pane reachable; the real minimum is the divider's job, and it advises. */
const MIN_RATIO = 0.02;
const MAX_RATIO = 0.98;

export function layoutPanes(
  tree: PaneTree | null | undefined,
  width: number,
  height: number,
  narrowPx: number = NARROW_PANE_PX,
): SplitLayout {
  const panes: PaneRect[] = [];
  const dividers: DividerInfo[] = [];
  if (!tree || !(width > 0) || !(height > 0)) return { panes, dividers };

  const walk = (
    node: PaneTree,
    x: number,
    y: number,
    w: number,
    h: number,
    path: readonly number[],
  ): void => {
    if (!(w > 0) || !(h > 0)) return;
    if (node.type === 'leaf') {
      panes.push({
        sessionId: node.sessionId, x, y, width: w, height: h,
        narrow: w < narrowPx || h < narrowPx,
      });
      return;
    }
    const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, node.ratio));
    const parent = { x, y, width: w, height: h };
    if (node.direction === 'horizontal') {
      const firstW = w * ratio;
      walk(node.first, x, y, firstW, h, [...path, 0]);
      dividers.push({ path, direction: 'horizontal', x: x + firstW, y, length: h, parent });
      walk(node.second, x + firstW, y, w - firstW, h, [...path, 1]);
    } else {
      const firstH = h * ratio;
      walk(node.first, x, y, w, firstH, [...path, 0]);
      dividers.push({ path, direction: 'vertical', x, y: y + firstH, length: w, parent });
      walk(node.second, x, y + firstH, w, h - firstH, [...path, 1]);
    }
  };

  walk(tree, 0, 0, width, height, []);
  return { panes, dividers };
}
