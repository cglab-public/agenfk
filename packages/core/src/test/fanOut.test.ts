/**
 * A fan-out has to have a bottom (CGLAB-199).
 *
 * An agent that can dispatch agents does not stop on its own. The thing
 * between a reasonable decomposition and a tree that expands by itself,
 * spending real money, is a number somebody chose - there is nothing in the
 * model that supplies one.
 *
 * THE TEST THAT MATTERS IS NOT THE CEILING. It is the escape route: a limit
 * that resets when you ask a different way is not a limit, and "start a fresh
 * run" is the obvious way to ask differently. Depth is a property of where a
 * card SITS, so every route to the same card has to answer the same.
 */
import { describe, it, expect } from 'vitest';
import {
  fanOutDepth,
  mayFanOut,
  longestChain,
  DEFAULT_MAX_FAN_OUT_DEPTH,
  type FanOutItem,
} from '../fanOut';

/** epic -> story -> task -> deep, plus a top-level loner. */
const tree: FanOutItem[] = [
  { id: 'epic' },
  { id: 'story', parentId: 'epic' },
  { id: 'task', parentId: 'story' },
  { id: 'deep', parentId: 'task' },
  { id: 'loner' },
];

describe('how deep a card sits', () => {
  it('counts a top-level card as zero, not one', () => {
    // Off by one here moves the whole ceiling, silently.
    expect(fanOutDepth('epic', tree)).toBe(0);
    expect(fanOutDepth('loner', tree)).toBe(0);
  });

  it('counts each ancestor', () => {
    expect(fanOutDepth('story', tree)).toBe(1);
    expect(fanOutDepth('task', tree)).toBe(2);
    expect(fanOutDepth('deep', tree)).toBe(3);
  });

  it('treats an unknown card as top level rather than throwing', () => {
    // This is asked about data from storage, and a throw here would take down
    // a dispatch screen over one dangling reference.
    expect(fanOutDepth('ghost', tree)).toBe(0);
  });

  it('stops on a cycle instead of hanging', () => {
    /*
     * The re-parent route refuses to make an item its own descendant, so a
     * cycle should be impossible - but hanging is a worse answer than a wrong
     * number, and this function is asked questions about whatever storage
     * holds.
     */
    const cyclic: FanOutItem[] = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];
    expect(fanOutDepth('a', cyclic)).toBeLessThan(5);
  });
});

describe('whether the agent may fan out', () => {
  it('lets a top-level card dispatch its children', () => {
    const v = mayFanOut('epic', tree);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBeNull();
  });

  it('refuses once the children would sit past the ceiling', () => {
    // With the default of 1, a story's children would be depth 2.
    const v = mayFanOut('story', tree);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('ceiling');
  });

  it('asks about the CHILDREN, not the card', () => {
    /*
     * A card at the ceiling may still be WORKED - it just may not fan out
     * further. Refusing the card itself would strand work that is perfectly
     * fine to do by hand, which is a much bigger refusal than the one intended.
     */
    const v = mayFanOut('story', tree);
    expect(v.depth, 'the card itself was treated as over the limit').toBe(1);
  });

  it('honours a ceiling raised deliberately', () => {
    expect(mayFanOut('story', tree, 3).allowed).toBe(true);
    expect(mayFanOut('deep', tree, 3).allowed).toBe(false);
  });

  it('names the move, and says the escape route does not work', () => {
    // A refusal that only states the rule sends somebody looking for a way
    // around it. This one closes the door it would have tried.
    const reason = mayFanOut('story', tree).reason ?? '';
    expect(reason).toMatch(/work its children yourself|raise the ceiling/i);
    expect(reason, 'the reason did not close the obvious escape route')
      .toMatch(/does not reset/i);
  });

  it('always carries a reason when refusing, and never when allowing', () => {
    // A refusal with a null reason renders a blocked action that explains
    // nothing, which is the absent control this exists to replace.
    for (const id of ['epic', 'story', 'task', 'deep', 'loner', 'ghost']) {
      const v = mayFanOut(id, tree);
      expect(Boolean(v.reason), `${id} refused without a reason, or allowed with one`).toBe(!v.allowed);
    }
  });
});

describe('the escape route', () => {
  it('answers the same however the card is reached', () => {
    /*
     * THE test. "Start a fresh run and dispatch from there" is how anybody
     * walks around a depth limit, and it works whenever depth is a property of
     * the REQUEST. Here it is a property of the tree, so every route to the
     * same card answers the same.
     *
     * This assertion used to call the function three times with identical
     * arguments and check the answers agreed. That is referential transparency
     * - true of `() => 0` and of `() => depth * 10` alike - and no mutation of
     * fanOut.ts could redden it. It read as the file's headline test while
     * pinning nothing.
     *
     * What actually pins the claim: the ABSOLUTE number, and the same card
     * reached through a differently-ordered slice. Order is the only route
     * variation available, since the signature has no request parameter to
     * vary - which is itself the property, and worth stating rather than
     * assuming.
     */
    expect(mayFanOut('task', tree).depth, 'task sits under epic -> story').toBe(2);

    // Same tree, arrived at from the other end. A depth accumulated while
    // walking the list rather than read off the ancestry answers differently
    // here.
    expect(mayFanOut('task', [...tree].reverse()).depth).toBe(2);

    // And in a slice that names the card before its ancestors exist in the
    // array, which is the order a partial fetch tends to produce.
    const shuffled = [tree[2], tree[4], tree[0], tree[3], tree[1]];
    expect(mayFanOut('task', shuffled).depth).toBe(2);
  });

  it('gives a fresh dispatch no way to ask for a smaller depth', () => {
    /*
     * The escape route stated as an absence: there is no argument that makes
     * the answer smaller. A "fresh run" can only re-ask about the same card in
     * the same tree, and the ceiling is the only knob - which moves the limit
     * UP for everybody rather than exempting one dispatch.
     */
    expect(mayFanOut('deep', tree).depth).toBe(3);
    expect(mayFanOut('deep', tree, 99).depth, 'the ceiling changed the measured depth').toBe(3);
  });

  it('does not forget the ancestry when the parent is missing from the slice', () => {
    /*
     * A caller handing in only the children it cares about would otherwise get
     * depth 0 for all of them and a ceiling that never fires. This documents
     * the contract rather than hiding it: pass the whole set, or the answer is
     * about the set you passed.
     */
    const slice: FanOutItem[] = [{ id: 'task', parentId: 'story' }];
    expect(fanOutDepth('task', slice), 'a partial slice silently reported depth 0')
      .toBe(1);
  });
});

describe('the shape worth questioning', () => {
  it('measures a chain of single children as its length', () => {
    // A fan-out of one, repeated, is a queue wearing a tree's clothes - and it
    // costs the most while looking the most like decomposition.
    expect(longestChain('epic', tree)).toBe(3);
  });

  it('is zero for a card with no children', () => {
    expect(longestChain('deep', tree)).toBe(0);
    expect(longestChain('loner', tree)).toBe(0);
  });

  it('takes the longest branch, not the first', () => {
    const wide: FanOutItem[] = [
      { id: 'root' },
      { id: 'short', parentId: 'root' },
      { id: 'long', parentId: 'root' },
      { id: 'longer', parentId: 'long' },
      { id: 'longest', parentId: 'longer' },
    ];
    expect(longestChain('root', wide)).toBe(3);
  });

  it('survives a cycle', () => {
    const cyclic: FanOutItem[] = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];
    expect(longestChain('a', cyclic)).toBeLessThan(5);
  });
});

describe('the default', () => {
  it('is one level, so fan-out is opt-in past the first', () => {
    // Deliberately conservative: the cost of a ceiling that is too low is an
    // agent asking to raise it; the cost of one too high is a bill.
    expect(DEFAULT_MAX_FAN_OUT_DEPTH).toBe(1);
  });
});
