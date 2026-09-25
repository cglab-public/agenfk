/**
 * Which worktrees are safe to offer for removal.
 *
 * The card asked for a retention policy and I am deliberately not writing one.
 * Removing a worktree when its card reaches the final step is the obvious
 * choice and the wrong one: people go back to a directory after closing a
 * card, and an automatic rule that deletes a working tree out from under
 * someone is not recoverable by undo.
 *
 * So the decision stays with the person: a command that LISTS what it would
 * remove and removes only what they confirm. That still solves the real
 * complaint — `~/.agenfk-worktrees` growing without limit, one full checkout
 * per card — because the accumulated ones can finally be cleared.
 *
 * What this function does is the part with rules in it: deciding what may be
 * offered at all. A worktree with uncommitted work in it must never be
 * offered, however finished its card looks.
 */
import { describe, it, expect } from 'vitest';
import { prunableWorktrees } from '../worktreePrune';

const item = (over: Record<string, unknown> = {}) => ({
  id: 'i1', title: 'A card', status: 'DONE', worktreePath: '/wt/a', ...over,
});

describe('what may be offered', () => {
  it('offers a finished card whose tree is clean', () => {
    const out = prunableWorktrees([item()], { isDirty: () => false, finalSteps: ['DONE'] });
    expect(out.map(w => w.itemId)).toEqual(['i1']);
  });

  it('says why it is being offered, not just that it is', () => {
    // The user is about to delete a directory. "Because its card is DONE" is
    // the difference between confirming and guessing.
    const out = prunableWorktrees([item()], { isDirty: () => false, finalSteps: ['DONE'] });
    expect(out[0].reason).toMatch(/DONE/);
  });
});

describe('what must never be offered', () => {
  it('refuses a tree with uncommitted work, however finished the card looks', () => {
    // The one unrecoverable mistake here. A card can be marked DONE while the
    // tree still holds work nobody pushed.
    const out = prunableWorktrees([item()], { isDirty: () => true, finalSteps: ['DONE'] });
    expect(out).toEqual([]);
  });

  it('refuses a card that is still in a working step', () => {
    const out = prunableWorktrees([item({ status: 'IN_PROGRESS' })], { isDirty: () => false, finalSteps: ['DONE'] });
    expect(out).toEqual([]);
  });

  it('refuses an item with no worktree at all', () => {
    const out = prunableWorktrees([item({ worktreePath: undefined })], { isDirty: () => false, finalSteps: ['DONE'] });
    expect(out).toEqual([]);
  });

  it('refuses when it cannot tell whether the tree is dirty', () => {
    // A git call that throws means unknown, and unknown must read as "do not
    // touch". Treating a failed check as clean is how a tool deletes work.
    const out = prunableWorktrees([item()], {
      isDirty: () => { throw new Error('not a repository'); },
      finalSteps: ['DONE'],
    });
    expect(out).toEqual([]);
  });

  it('honours a project flow whose final step is not called DONE', () => {
    // Flows are configurable, so "finished" is whatever the project's flow
    // says it is. Hardcoding DONE would offer nothing on a custom flow, or
    // worse, offer the wrong step.
    const out = prunableWorktrees([item({ status: 'SHIPPED' })], { isDirty: () => false, finalSteps: ['SHIPPED'] });
    expect(out.map(w => w.itemId)).toEqual(['i1']);
  });

  // 686fdbf6: a checkout another card chose to run in is not this card's to prune.
  it('refuses a worktree another card chose to run in', () => {
    const done = item();
    const chooser = { id: 'i2', title: 'Runs there', status: 'IN_PROGRESS', worktreeChoice: done.worktreePath };
    expect(prunableWorktrees([done, chooser], { isDirty: () => false, finalSteps: ['DONE'] })).toEqual([]);
    expect(prunableWorktrees([done, { ...chooser, worktreeChoice: '/elsewhere' }], { isDirty: () => false, finalSteps: ['DONE'] }).map(w => w.itemId)).toEqual(['i1']);
  });
});
