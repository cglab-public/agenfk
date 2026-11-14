/**
 * The shell's pane moves (7a717cb8, 3b).
 *
 * These used to be inline in AppShell, where a DOM test is the only way to
 * reach them and the pair-shaped bug (splitId/one direction) was invisible.
 * Pure here, so the third pane and the nested boundary can be pinned by shape
 * alone.
 */
import { describe, it, expect } from 'vitest';
import { treeForDrop, treeForToggle, pruneTree, treeForFocus } from '../paneLayout';
import { splitLeaf, leaves, type PaneTree } from '../splitTree';

const leaf = (id: string): PaneTree => ({ type: 'leaf', sessionId: id });
const pair = () => splitLeaf(leaf('a'), 'a', 'horizontal', 'b')!;
const nested = () => splitLeaf(pair(), 'b', 'vertical', 'c')!;

describe('dropping a tab on a pane edge', () => {
  it('splits the target with a session that is not on screen', () => {
    const t = treeForDrop(pair(), 'a', 'c', 'b', { direction: 'vertical', placement: 'after' })!;
    expect(leaves(t)).toEqual(['a', 'b', 'c']);
  });

  it('MOVES a pane that is already on screen instead of duplicating it', () => {
    // Dropping b on a's left edge rearranges the pair; it must not leave b in
    // two places, and splitLeaf would refuse the duplicate in silence.
    const t = treeForDrop(pair(), 'a', 'b', 'a', { direction: 'horizontal', placement: 'before' })!;
    expect(leaves(t)).toEqual(['b', 'a']);
  });

  it('starts from the focused session when there is no tree yet', () => {
    const t = treeForDrop(null, 'a', 'b', 'a', { direction: 'horizontal', placement: 'after' })!;
    expect(leaves(t)).toEqual(['a', 'b']);
  });

  it('does nothing when there is neither a tree nor a focused session', () => {
    expect(treeForDrop(null, null, 'b', 'a', { direction: 'horizontal', placement: 'after' })).toBeNull();
  });

  it('leaves the arrangement alone at the cap', () => {
    const full = nested(); // three panes; one more reaches MAX_PANES
    const four = treeForDrop(full, 'a', 'd', 'c', { direction: 'vertical', placement: 'after' })!;
    expect(leaves(four)).toHaveLength(4);
    const five = treeForDrop(four, 'a', 'e', 'c', { direction: 'vertical', placement: 'after' });
    expect(leaves(five!)).toHaveLength(4);
  });
});

describe('the tab strip Split control', () => {
  it('adds the session beside the focused pane', () => {
    const t = treeForToggle(null, 'a', 'b', 'horizontal')!;
    expect(leaves(t)).toEqual(['a', 'b']);
  });

  it('takes a pane out when it is already in the tree', () => {
    const t = treeForToggle(pair(), 'a', 'b', 'horizontal')!;
    expect(leaves(t)).toEqual(['a']);
  });

  it('does not split a pane with itself', () => {
    const t = treeForToggle(null, 'a', 'a', 'horizontal')!;
    expect(leaves(t)).toEqual(['a']);
  });
});

describe('keeping the tree in step with the open sessions', () => {
  it('collapses a closed pane into its sibling, keeping the rest', () => {
    const t = pruneTree(nested(), id => id !== 'b')!;
    expect(leaves(t)).toEqual(['a', 'c']);
  });

  it('returns nothing when the last pane closed', () => {
    expect(pruneTree(leaf('a'), () => false)).toBeNull();
  });

  it('shows a tab that is not on screen in the pane it replaced', () => {
    // The boundary you dragged is the person's; switching tab must not reset it.
    const t = treeForFocus(pair(), 'a', 'c')!;
    expect(leaves(t)).toEqual(['c', 'b']);
    expect(t.type === 'split' && t.ratio).toBe(0.5);
  });

  it('leaves a tree that already shows the tab alone', () => {
    const before = pair();
    expect(treeForFocus(before, 'a', 'b')).toBe(before);
  });

  it('does nothing without a tree to change', () => {
    expect(treeForFocus(null, 'a', 'b')).toBeNull();
  });
});
