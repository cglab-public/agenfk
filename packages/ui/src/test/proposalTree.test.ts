/**
 * The two decisions behind the approval gate.
 *
 * Neither is visible in a screenshot, and both produce a board that is wrong
 * in a way nobody traces back to this screen: an orphan card pointing at a
 * parent that was never created, or a child POSTed before its parent exists.
 */
import { describe, it, expect } from 'vitest';
import { creatableItems, keptItems, creationOrder, issuesFor, treeIssues, type ReviewedItem } from '../proposalTree';

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


/*
 * Found by adversarial review of 85b807dd.
 *
 * A row can fail to exist for TWO reasons — dropped by the person, or blocked
 * by an issue — and only the first took its children with it. The second
 * skipped the parent and created its children anyway, with no parentId, which
 * is a top-level card: a story with a missing title turned three tasks into
 * three loose cards on the board.
 */
describe('creatableItems', () => {
  const tree = [
    { ref: 'e1', type: 'EPIC', title: 'Port the admin API', parentRef: null, depth: 0 },
    { ref: 's1', type: 'STORY', title: '', parentRef: 'e1', depth: 1 },
    { ref: 't1', type: 'TASK', title: 'terraform', parentRef: 's1', depth: 2 },
    { ref: 't2', type: 'TASK', title: 'dashboards', parentRef: 's1', depth: 2 },
  ] as never as ReviewedItem[];

  it('takes the subtree of a BLOCKED row, not just of a dropped one', () => {
    const out = creatableItems(tree, new Set(), ref => ref === 's1');
    expect(out.map(i => i.ref)).toEqual(['e1']);
  });

  it('still takes the subtree of a dropped row', () => {
    expect(creatableItems(tree, new Set(['e1']), () => false)).toEqual([]);
  });

  it('keeps everything when nothing is dropped or blocked', () => {
    expect(creatableItems(tree, new Set(), () => false).map(i => i.ref))
      .toEqual(['e1', 's1', 't1', 't2']);
  });

  it('treats a row with no ref as impossible to create', () => {
    // creationOrder dedupes by ref, so several ref-less rows collapse into
    // one — the button promised more cards than could ever be written.
    const anonymous = [
      { ref: '', type: 'TASK', title: 'one', parentRef: null, depth: 0 },
      { ref: '', type: 'TASK', title: 'two', parentRef: null, depth: 0 },
    ] as never as ReviewedItem[];
    expect(creatableItems(anonymous, new Set(), ref => !ref)).toEqual([]);
  });
});
