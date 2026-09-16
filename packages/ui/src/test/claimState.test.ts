/**
 * The claim chip on a sidebar card (CGLAB-190).
 *
 * The claims mechanism shipped this week and is invisible in the product: a
 * card owns files, another card is refused because of it, and nothing on
 * screen says so. The interface this implements puts the word `held` on a
 * sidebar row and names the reason - *"the fourth card in the sidebar says
 * held — lead claims the same file"*.
 *
 * THE FAILURE THAT MATTERS HERE IS THE SAME ONE AS IN THE GATE: reporting a
 * held card as free. A chip that fails open is not cosmetic - it tells a
 * person their card is ready to work when the server will refuse it, and they
 * will go looking for the bug in the wrong place.
 *
 * The second failure is noise. Every card in the database declares nothing, so
 * a chip that renders on all of them is thirty rows announcing an absence.
 */
import { describe, it, expect } from 'vitest';
import { claimStateOf, claimChipLabel, claimChipTitle, type ClaimCard } from '../claimState';

const card = (id: string, status: string, claims?: string[]): ClaimCard => ({ id, status, claims });

describe('what a card owns', () => {
  it('says nothing at all when it declares nothing, which is every card today', () => {
    const state = claimStateOf('a', [card('a', 'IN_PROGRESS')]);
    expect(state).toEqual({ owns: [], heldBy: [] });
    expect(claimChipLabel(state), 'a chip rendered on a card with no claims').toBeNull();
    expect(claimChipTitle(state)).toBeNull();
  });

  it('counts what it owns, and counts in words a person reads', () => {
    const one = claimStateOf('a', [card('a', 'IN_PROGRESS', ['packages/ui/'])]);
    expect(claimChipLabel(one)).toBe('owns 1 path');
    const two = claimStateOf('a', [card('a', 'IN_PROGRESS', ['packages/ui/', 'src/x.ts'])]);
    expect(claimChipLabel(two)).toBe('owns 2 paths');
  });

  it('puts the actual paths in the title, because a count is not actionable', () => {
    const state = claimStateOf('a', [card('a', 'IN_PROGRESS', ['packages/ui/'])]);
    expect(claimChipTitle(state)).toContain('packages/ui/');
  });
});

describe('when somebody else owns it too', () => {
  it('says held, and names who', () => {
    const state = claimStateOf('mine', [
      card('mine', 'IN_PROGRESS', ['packages/ui/src/App.tsx']),
      card('theirs-1234', 'REVIEW', ['packages/ui/']),
    ]);
    expect(claimChipLabel(state)).toBe('held');
    expect(state.heldBy).toEqual(['theirs-1234']);
    // Truncated to eight characters, the way every id is shown in this UI.
    expect(claimChipTitle(state), 'held without naming the holder is a dead end').toContain('theirs-1');
  });

  it('counts a PAUSED holder, which the active list would have dropped', () => {
    /*
     * THE test. A paused card's files are half-edited in the shared tree, so
     * it still holds them - and the sidebar is drawn from the in-flight list,
     * which does not contain it. Computing holders from that list reports this
     * card as free while the server refuses it.
     */
    const state = claimStateOf('mine', [
      card('mine', 'IN_PROGRESS', ['packages/ui/src/App.tsx']),
      card('paused-1234', 'PAUSED', ['packages/ui/']),
    ]);
    expect(claimChipLabel(state), 'a paused holder was treated as released').toBe('held');
  });

  it('does not count a DONE holder, or the first fan-out owns those files forever', () => {
    const state = claimStateOf('mine', [
      card('mine', 'IN_PROGRESS', ['packages/ui/src/App.tsx']),
      card('done-1234', 'DONE', ['packages/ui/']),
    ]);
    expect(claimChipLabel(state)).toBe('owns 1 path');
  });

  it('does not report a card as held by itself', () => {
    // A card re-declaring or widening its own claim is not a collision, and a
    // row that said `held` here would be permanently, uselessly amber.
    const state = claimStateOf('mine', [card('mine', 'IN_PROGRESS', ['packages/ui/'])]);
    expect(state.heldBy).toEqual([]);
  });

  it('names a holder once, not once per colliding file', () => {
    // A directory claim collides with every file beneath it, and a row reading
    // "held by a, a, a" is noise where "held by a" is the fact.
    const state = claimStateOf('mine', [
      card('mine', 'IN_PROGRESS', ['packages/ui/a.ts', 'packages/ui/b.ts', 'packages/ui/c.ts']),
      card('theirs', 'REVIEW', ['packages/ui/']),
    ]);
    expect(state.heldBy).toEqual(['theirs']);
  });

  it('defers to the gate on spelling, rather than comparing strings itself', () => {
    // The server treats these as the same path. A sidebar that disagreed would
    // say free where the gate says refused, and the reader cannot tell which
    // of the two is lying.
    const state = claimStateOf('mine', [
      card('mine', 'IN_PROGRESS', ['packages/ui/src/App.tsx']),
      card('theirs', 'REVIEW', ['packages\\ui']),
    ]);
    expect(claimChipLabel(state)).toBe('held');
  });
});

describe('input the sidebar can actually hand it', () => {
  it('survives a card id that is not in the list', () => {
    expect(claimStateOf('ghost', [card('a', 'IN_PROGRESS', ['x/'])])).toEqual({ owns: [], heldBy: [] });
  });

  it('survives holders with no claims field, which is most of them', () => {
    const state = claimStateOf('mine', [
      card('mine', 'IN_PROGRESS', ['packages/ui/']),
      { id: 'theirs', status: 'IN_PROGRESS' } as ClaimCard,
    ]);
    expect(claimChipLabel(state)).toBe('owns 1 path');
  });
});
