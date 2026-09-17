/**
 * A restored terminal must not forget the card's branch (BUG: it did).
 */
import { describe, it, expect } from 'vitest';
import { withItemBranches } from '../sessionBranch';

const item = (id: string, branchName: string | null = null) => ({ id, branchName });

describe('keeping a session branch in step with its card', () => {
  it('fills in the branch a RESTORED session never had', () => {
    // The bug: branchName was set only when the tab was opened, so the restored
    // one had none and the header said "no branch yet" for a card that had one.
    const restored = [{ itemId: 'i1' }, { itemId: 'i2' }];
    const next = withItemBranches(restored, [item('i1', 'feat/x'), item('i2', 'fix/y')]);
    expect(next.map(s => s.branchName)).toEqual(['feat/x', 'fix/y']);
  });

  it('follows a branch that appears or changes later', () => {
    const sessions = [{ itemId: 'i1', branchName: null }];
    expect(withItemBranches(sessions, [item('i1', 'feat/new')])[0].branchName).toBe('feat/new');
    expect(
      withItemBranches([{ itemId: 'i1', branchName: 'old' }], [item('i1', 'new')])[0].branchName,
    ).toBe('new');
  });

  it('says NOTHING when the items have not loaded', () => {
    // Absence is not "no branch": blanking here would flash "no branch yet"
    // over a branch that is about to arrive.
    const sessions = [{ itemId: 'i1', branchName: 'feat/x' }];
    expect(withItemBranches(sessions, [])).toBe(sessions);
  });

  it('leaves a session whose card is not in the list alone', () => {
    const sessions = [{ itemId: 'i9', branchName: 'feat/keep' }];
    expect(withItemBranches(sessions, [item('i1', 'feat/x')])).toBe(sessions);
  });

  it('returns the SAME array when nothing changed', () => {
    // Identity matters: the caller uses this in an effect on the items, and a
    // fresh array every poll would re-render the shell forever.
    const sessions = [{ itemId: 'i1', branchName: 'feat/x' }];
    expect(withItemBranches(sessions, [item('i1', 'feat/x')])).toBe(sessions);
  });
});
