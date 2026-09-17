/**
 * The split tree as data (7a717cb8).
 *
 * Modelled on Orca's `TabGroupLayoutNode`: a binary tree of horizontal /
 * vertical splits, `ratio` per node. The tests here are about SHAPE - a leaf
 * split twice, a one-armed node left by a removal, a fifth pane past the cap,
 * the tab strip mistaken for a drop edge - none of which needs a DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  splitLeaf, removeLeaf, moveLeaf, setRatioAtPath, dividerPathFor, pathToLeaf, replaceSession,
  leaves, paneCount, dropZone,
  MAX_PANES, NARROW_PANE_PX, TAB_STRIP_PX,
  type PaneTree,
} from '../splitTree';

const leaf = (id: string): PaneTree => ({ type: 'leaf', sessionId: id });

describe('splitting a pane', () => {
  it('puts the new pane on the side you asked for', () => {
    const t = splitLeaf(leaf('a'), 'a', 'horizontal', 'b', 'after')!;
    expect(t).toMatchObject({ type: 'split', direction: 'horizontal' });
    expect(leaves(t)).toEqual(['a', 'b']);
  });

  it('stacks them when the direction is vertical', () => {
    const t = splitLeaf(leaf('a'), 'a', 'vertical', 'b')!;
    expect((t as any).direction).toBe('vertical');
  });

  it('splits BEFORE when that is the edge', () => {
    const t = splitLeaf(leaf('a'), 'a', 'horizontal', 'b', 'before')!;
    expect(leaves(t)).toEqual(['b', 'a']);
  });

  it('nests: a split inside a split', () => {
    // The case the whole feature exists for - agent left, diff top-right,
    // something else bottom-right, all at once.
    const left = splitLeaf(leaf('a'), 'a', 'horizontal', 'b')!;
    const nested = splitLeaf(left, 'b', 'vertical', 'c')!;
    expect(leaves(nested)).toEqual(['a', 'b', 'c']);
  });

  it('refuses a FIFTH pane rather than silently dropping the gesture', () => {
    let t: PaneTree | null = leaf('a');
    for (const id of ['b', 'c', 'd']) t = splitLeaf(t!, t === null ? '' : leaves(t)[0], 'horizontal', id)!;
    expect(paneCount(t)).toBe(MAX_PANES);
    expect(splitLeaf(t!, 'a', 'horizontal', 'e'), 'a fifth pane was allowed').toBeNull();
  });

  it('will not split a pane with itself', () => {
    expect(splitLeaf(leaf('a'), 'a', 'horizontal', 'a')).toBeNull();
  });
});

describe('removing a pane', () => {
  it('collapses the parent into the survivor', () => {
    const t = splitLeaf(leaf('a'), 'a', 'horizontal', 'b')!;
    expect(removeLeaf(t, 'a')).toEqual(leaf('b'));
  });

  it('keeps the rest of the tree', () => {
    const t = splitLeaf(splitLeaf(leaf('a'), 'a', 'horizontal', 'b')!, 'b', 'vertical', 'c')!;
    expect(leaves(removeLeaf(t, 'b')!)).toEqual(['a', 'c']);
  });

  it('answers null for the last pane, leaving the meaning to the caller', () => {
    expect(removeLeaf(leaf('a'), 'a')).toBeNull();
  });
});

describe('moving a pane', () => {
  it('drops it beside another one', () => {
    const t = splitLeaf(splitLeaf(leaf('a'), 'a', 'horizontal', 'b')!, 'b', 'vertical', 'c')!;
    expect(leaves(moveLeaf(t, 'c', 'a', 'vertical', 'after')!)).toEqual(['a', 'c', 'b']);
  });
});

describe('choosing a different session in a pane', () => {
  it('keeps the SHAPE - the boundaries stay where they were', () => {
    // Picking another tab must not throw the arrangement away: the pane that
    // had the focus shows the new session and the splits are untouched.
    const t = splitLeaf(splitLeaf(leaf('a'), 'a', 'horizontal', 'b')!, 'b', 'vertical', 'c')!;
    const swapped = replaceSession(t, 'c', 'z') as any;
    expect(leaves(swapped)).toEqual(['a', 'b', 'z']);
    expect(swapped.first, 'the shape changed').toEqual((t as any).first);
    expect(swapped.second.direction).toBe('vertical');
  });
});

describe('the divider ratio, per node', () => {
  const nested = () => splitLeaf(splitLeaf(leaf('a'), 'a', 'horizontal', 'b')!, 'b', 'vertical', 'c')!;

  it('addresses the split ADJACENT to a pane, not the outermost one', () => {
    // THE BUG THIS REPLACES: setting the ratio "for b" wrote the ROOT split's
    // ratio, so dragging b's divider moved the a|(b,c) boundary instead. The
    // old test missed it because it only ever built one split deep.
    const t = nested() as any;
    expect(pathToLeaf(t, 'b')).toEqual([1, 0]);
    const path = dividerPathFor(t, 'b');
    expect(path, 'b hangs off the inner split').toEqual([1]);
    const moved = setRatioAtPath(t, path!, 0.7) as any;
    expect(moved.second.ratio).toBe(0.7);
    expect(moved.ratio, 'it moved a different boundary').toBe(0.5);
  });

  it('a lone pane has no divider', () => {
    expect(dividerPathFor(leaf('a'), 'a')).toBeNull();
  });

  it('clamps', () => {
    const t = splitLeaf(leaf('a'), 'a', 'horizontal', 'b')!;
    expect((setRatioAtPath(t, [], 2) as any).ratio).toBe(1);
  });
});

describe('where a drag is asking to split', () => {
  const W = 600, H = 400;

  it('right edge splits side by side, after', () => {
    expect(dropZone(W, H, W - 10, H / 2)).toEqual({ direction: 'horizontal', placement: 'after' });
  });
  it('left edge splits side by side, before', () => {
    expect(dropZone(W, H, 10, H / 2)).toEqual({ direction: 'horizontal', placement: 'before' });
  });
  it('bottom edge stacks, after', () => {
    expect(dropZone(W, H, W / 2, H - 10)).toEqual({ direction: 'vertical', placement: 'after' });
  });
  it('top of the BODY stacks before - but not the tab strip', () => {
    // The strip is where a tab is dragged to reorder; treating it as a split
    // edge is what made reordering impossible.
    expect(dropZone(W, H, W / 2, TAB_STRIP_PX + 5)).toEqual({ direction: 'vertical', placement: 'before' });
    expect(dropZone(W, H, W / 2, TAB_STRIP_PX - 5), 'the tab strip was read as a split edge').toBeNull();
  });
  it('the middle is not a split - it is a move', () => {
    expect(dropZone(W, H, W / 2, H / 2)).toBeNull();
  });
  it('a corner picks the CLOSER edge', () => {
    expect(dropZone(W, H, 5, H - 5)?.direction).toBe('horizontal');
  });
  it('says nothing about a degenerate pane', () => {
    expect(dropZone(0, 0, 0, 0)).toBeNull();
  });
});

describe('the floor advises, it does not refuse', () => {
  it('NARROW_PANE_PX is a warning threshold, not a gate', () => {
    // The number exists so the UI can say "this column got narrow"; nothing in
    // this module returns null because of it.
    expect(NARROW_PANE_PX).toBeGreaterThan(0);
    expect(splitLeaf(leaf('a'), 'a', 'horizontal', 'b')).not.toBeNull();
  });
});
