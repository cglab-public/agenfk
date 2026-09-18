/**
 * The tree as rectangles (7a717cb8).
 *
 * Everything the component needs to place panes and dividers, and nothing about
 * the DOM - so where a boundary lands, and which pane is narrow, is pinned by
 * arithmetic rather than by looking at a screenshot.
 */
import { describe, it, expect } from 'vitest';
import { layoutPanes } from '../splitGeometry';
import { splitLeaf, NARROW_PANE_PX, type PaneTree } from '../splitTree';

const leaf = (id: string): PaneTree => ({ type: 'leaf', sessionId: id });
const two = () => splitLeaf(leaf('a'), 'a', 'horizontal', 'b')!;

const rectOf = (panes: readonly { sessionId: string }[], id: string) =>
  panes.find(p => p.sessionId === id) as any;

describe('placing panes', () => {
  it('splits side by side at the ratio', () => {
    const { panes } = layoutPanes(two(), 1000, 400);
    expect(rectOf(panes, 'a')).toMatchObject({ x: 0, y: 0, width: 500, height: 400 });
    expect(rectOf(panes, 'b')).toMatchObject({ x: 500, y: 0, width: 500, height: 400 });
  });

  it('splits stacked when the direction is vertical', () => {
    const t = splitLeaf(leaf('a'), 'a', 'vertical', 'b')!;
    const { panes } = layoutPanes(t, 1000, 400);
    expect(rectOf(panes, 'a')).toMatchObject({ y: 0, height: 200 });
    expect(rectOf(panes, 'b')).toMatchObject({ y: 200, height: 200 });
  });

  it('puts the boundary where the sub-tree begins', () => {
    // a on the left; b over c on the right.
    const t = splitLeaf(two(), 'b', 'vertical', 'c')!;
    const { panes } = layoutPanes(t, 1000, 400);
    expect(rectOf(panes, 'a').width).toBe(500);
    expect(rectOf(panes, 'b')).toMatchObject({ x: 500, y: 0, width: 500, height: 200 });
    expect(rectOf(panes, 'c')).toMatchObject({ x: 500, y: 200, width: 500, height: 200 });
  });

  it('moves only the boundary whose ratio changed', () => {
    const t: any = splitLeaf(two(), 'b', 'vertical', 'c')!;
    const moved: any = { ...t, ratio: 0.7 };
    const { panes } = layoutPanes(moved, 1000, 400);
    expect(rectOf(panes, 'a').width, 'the outer boundary moved too').toBe(700);
    expect(rectOf(panes, 'b').height, 'the inner boundary moved').toBe(200);
  });

  it('never produces a zero-sized pane, whatever the ratio says', () => {
    const t: any = { ...two(), ratio: 0 };
    const { panes } = layoutPanes(t, 1000, 400);
    for (const p of panes) {
      expect(p.width).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
    }
  });

  it('says nothing about a pane it cannot measure', () => {
    expect(layoutPanes(two(), 0, 0).panes).toEqual([]);
    expect(layoutPanes(null, 1000, 400).panes).toEqual([]);
  });
});

describe('the dividers, addressed by the split they belong to', () => {
  it('one per split, carrying that split path', () => {
    // Root first, then the nested one - the tree's own order.
    const t = splitLeaf(two(), 'b', 'vertical', 'c')!;
    const { dividers } = layoutPanes(t, 1000, 400);
    expect(dividers.map(d => d.path)).toEqual([[], [1]]);
    expect(dividers.find(d => d.path.length === 0)).toMatchObject({ direction: 'horizontal', x: 500, length: 400 });
    expect(dividers.find(d => d.path.length === 1)).toMatchObject({ direction: 'vertical', x: 500, y: 200, length: 500 });
  });

  it('carries the rect of the split it lives in, so a drag can be measured there', () => {
    // A ratio is relative to ITS OWN node, not to the window. Without the
    // parent's extent a nested divider can only be dragged as if it were the
    // root - which moves the wrong boundary once the tree is more than one
    // split deep.
    const t = splitLeaf(two(), 'b', 'vertical', 'c')!;
    const { dividers } = layoutPanes(t, 1000, 400);
    expect(dividers.find(d => d.path.length === 0)).toMatchObject({
      parent: { x: 0, y: 0, width: 1000, height: 400 },
    });
    expect(dividers.find(d => d.path.length === 1)).toMatchObject({
      parent: { x: 500, y: 0, width: 500, height: 400 },
    });
  });
});

describe('narrow is advice, not a gate', () => {
  it('lays four out AND marks the tight ones, instead of refusing', () => {
    // The tree always NESTS, so four panes are not four equal widths - each
    // split halves what it divides. The point is that all four are placed, and
    // the ones under the advice line are named rather than dropped.
    let t: PaneTree = leaf('a');
    for (const id of ['b', 'c', 'd']) t = splitLeaf(t, 'a', 'horizontal', id)!;
    const { panes } = layoutPanes(t, 1000, 400);
    expect(panes, 'the cap refused a layout it could draw').toHaveLength(4);
    expect(panes.some(p => p.narrow), 'nothing was marked narrow').toBe(true);
    expect(panes.some(p => !p.narrow), 'everything was marked narrow').toBe(true);
  });

  it('leaves a comfortable pane unmarked', () => {
    const { panes } = layoutPanes(two(), 1600, 900);
    expect(panes.every(p => !p.narrow)).toBe(true);
  });
});

describe('no horizontal scroll, however many panes (user decision, 7a717cb8)', () => {
  it('fits four panes INSIDE the width: every rect starts at or after 0 and ends at or before it', () => {
    // Four panes are not four comfortable columns - the tree halves what it
    // divides - and that is accepted: the reader gets wrapped lines and the
    // `narrow` advice, NOT a scroller. A rect that spilled past the edge would
    // be the app deciding otherwise, so it is pinned here.
    let t: PaneTree = leaf('a');
    for (const id of ['b', 'c', 'd']) t = splitLeaf(t, 'a', 'horizontal', id)!;
    const width = 900;
    const { panes } = layoutPanes(t, width, 400);
    expect(panes).toHaveLength(4);
    for (const p of panes) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x + p.width).toBeLessThanOrEqual(width + 1e-9);
    }
  });
});
