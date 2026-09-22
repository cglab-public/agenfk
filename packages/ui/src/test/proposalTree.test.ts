/**
 * The two decisions behind the approval gate.
 *
 * Neither is visible in a screenshot, and both produce a board that is wrong
 * in a way nobody traces back to this screen: an orphan card pointing at a
 * parent that was never created, or a child POSTed before its parent exists.
 */
import { describe, it, expect } from 'vitest';
import { keptItems, creationOrder, issuesFor, treeIssues, type ReviewedItem } from '../proposalTree';

const row = (ref: string, parentRef: string | null = null): ReviewedItem =>
  ({ ref, type: 'TASK', title: ref, parentRef, depth: 0 });

describe('dropping a row', () => {
  const tree = [row('e1'), row('s1', 'e1'), row('t1', 's1'), row('s2', 'e1')];

  it('keeps everything when nothing is dropped', () => {
    expect(keptItems(tree, new Set()).map(i => i.ref)).toEqual(['e1', 's1', 't1', 's2']);
  });

  it('takes the subtree with it', () => {
    // Creating t1 without s1 would put a card on the board pointing at a
    // parent id that never existed — worse than either outcome the person
    // chose.
    expect(keptItems(tree, new Set(['s1'])).map(i => i.ref)).toEqual(['e1', 's2']);
  });

  it('reaches grandchildren, not just children', () => {
    expect(keptItems(tree, new Set(['e1']))).toEqual([]);
  });
});

describe('the order cards are created in', () => {
  it('puts a parent before its child even when the answer lists it after', () => {
    // parentRef may point FORWARDS: the agent's array order is not a promise,
    // and a child needs its parent's real id.
    const out = creationOrder([row('t1', 's1'), row('s1', 'e1'), row('e1')]);
    expect(out.map(i => i.ref)).toEqual(['e1', 's1', 't1']);
  });

  it('keeps every row exactly once', () => {
    const tree = [row('e1'), row('s1', 'e1'), row('s2', 'e1')];
    expect(creationOrder(tree).map(i => i.ref).sort()).toEqual(['e1', 's1', 's2']);
  });

  it('treats an item whose parent is not here as a root', () => {
    // keptItems has already removed anything orphaned by a DROP, so what is
    // left is an item whose parent was never proposed.
    expect(creationOrder([row('t1', 'ghost')]).map(i => i.ref)).toEqual(['t1']);
  });

  it('does not hang on a cycle the server already flagged', () => {
    // The route reports cycles; the screen still has to render without
    // recursing forever while the person reads the issue.
    const out = creationOrder([row('a', 'b'), row('b', 'a')]);
    expect(out.map(i => i.ref).sort()).toEqual(['a', 'b']);
  });
});

describe('where an issue is shown', () => {
  const issues = [
    { ref: 'a', message: 'about a' },
    { message: 'about the whole tree' },
    { ref: 'b', message: 'about b' },
  ];

  it('hangs a row issue on its row, by ref not index', () => {
    // Index would be wrong the moment a row is dropped from the list.
    expect(issuesFor(issues, 'a').map(i => i.message)).toEqual(['about a']);
  });

  it('keeps the tree-level ones where no row can carry them', () => {
    expect(treeIssues(issues).map(i => i.message)).toEqual(['about the whole tree']);
  });
});
