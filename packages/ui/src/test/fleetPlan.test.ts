/**
 * What would actually run, before anything is spent (CGLAB-207).
 *
 * Choosing an epic and dispatching its children is what the claims mechanism
 * was built for, and it is where the mechanism gets paid for: a fan-out that
 * discovers a file collision AFTER launching three agents has spent real money
 * to learn what the gate already knew.
 *
 * THE FAILURE THAT MATTERS MOST IS THE COUNT. "Launch 4" that launches three
 * is the easiest mistake here and the most damaging, because the number is the
 * one part of this screen a person trusts without checking.
 *
 * THE SECOND IS MUTUAL HOLDING. Two siblings wanting one file cannot both
 * launch - that is the race - and cannot both be held, which is a deadlock
 * nobody asked for. Exactly one goes.
 */
import { describe, it, expect } from 'vitest';
import { planFleet, launchLabel, fanOutDepthLocal, mayFanOutLocal, dispatchAllowed, CIRCUIT_BREAK_AFTER_LOCAL, type FleetInputs } from '../fleetPlan';

const OK: FleetInputs['depth'] = { allowed: true, reason: null };

type Item = FleetInputs['all'][number];
const kid = (id: string, claims?: string[], status = 'TODO'): Item =>
  ({ id, title: `t-${id}`, status, parentId: 'epic', claims });

const epic: Item = { id: 'epic', title: 'The epic', status: 'IN_PROGRESS' };

const plan = (all: Item[], depth: FleetInputs['depth'] = OK) => planFleet({ parentId: 'epic', all, depth });

describe('the number on the button', () => {
  it('counts what will run, not how many children exist', () => {
    /*
     * THE test. Two children want packages/ui, so one is held - and the button
     * must say 3, not 4. A button that says four and launches three is a lie
     * told by the interface.
     */
    const p = plan([epic,
      kid('a', ['packages/ui/']),
      kid('b', ['packages/ui/src/App.tsx']),
      kid('c', ['packages/server/']),
      kid('d', ['packages/cli/']),
    ]);
    expect(p.children).toHaveLength(4);
    expect(p.launchCount, 'the button would have promised a launch it cannot make').toBe(3);
    expect(launchLabel(p)).toBe('Launch 3');
  });

  it('counts every child when nothing collides', () => {
    const p = plan([epic, kid('a', ['x/']), kid('b', ['y/']), kid('c', ['z/'])]);
    expect(launchLabel(p)).toBe('Launch 3');
    expect(p.heldCount).toBe(0);
  });

  it('says so plainly when nothing can start', () => {
    // "Launch 0" is a button somebody presses. This is not.
    const p = plan([epic, kid('a', ['packages/ui/'])], { allowed: false, reason: 'ceiling' });
    expect(launchLabel(p)).toBe('Nothing to launch');
  });

  it('counts children with no claims at all, which is most of them', () => {
    // Absence authorises, the same as everywhere else in this mechanism. A
    // fan-out of undeclared cards must not be silently held back.
    const p = plan([epic, kid('a'), kid('b'), kid('c')]);
    expect(p.launchCount).toBe(3);
  });
});

describe('two siblings, one file', () => {
  it('launches exactly one of them - not both, not neither', () => {
    const p = plan([epic, kid('a', ['shared/file.ts']), kid('b', ['shared/file.ts'])]);
    const launched = p.children.filter(c => c.launch);
    expect(launched, 'both launched into the same file, or both were stranded').toHaveLength(1);
  });

  it('tells the held one to wait, because a sibling will release', () => {
    // The move differs by WHO holds it: a sibling in this fan-out finishes and
    // releases; a card outside may sit for days and somebody has to go ask.
    const p = plan([epic, kid('a', ['shared/']), kid('b', ['shared/file.ts'])]);
    const held = p.children.find(c => !c.launch)!;
    expect(held.hold).toBe('claimed-by-sibling');
    expect(held.holdText).toMatch(/waits for that one/i);
  });

  it('names the outside holder instead, when it is not a sibling', () => {
    const outsider: Item = { id: 'outsider-1234', title: 'Elsewhere', status: 'IN_PROGRESS', claims: ['shared/'] };
    const p = plan([epic, outsider, kid('b', ['shared/file.ts'])]);
    const held = p.children.find(c => !c.launch)!;
    expect(held.hold).toBe('claimed-elsewhere');
    expect(held.holdText).toContain('outsider');
  });

  it('does not let a HELD child hold a path for anybody else', () => {
    /*
     * THE cascade test, and the first version of it could not fail: it chose
     * a shape where the answer is the same whether a held child holds or not.
     *
     * Here it differs. An outsider owns `x/deep.ts`. Child `b` claims `x/`,
     * which contains it, so `b` is held. Child `c` claims `x/other.ts`, which
     * the outsider does NOT own - so `c` is free, unless `b` is allowed to
     * hold `x/` while held itself. A held child holds nothing.
     */
    const outsider: Item = { id: 'outsider', title: 'Elsewhere', status: 'IN_PROGRESS', claims: ['x/deep.ts'] };
    const p = plan([epic, outsider, kid('b', ['x/']), kid('c', ['x/other.ts'])]);

    expect(p.children.find(c => c.id === 'b')!.launch, 'b should be held by the outsider').toBe(false);
    expect(p.children.find(c => c.id === 'c')!.launch, 'a held sibling held a path for somebody else').toBe(true);
    expect(p.launchCount).toBe(1);
  });

  it('does not cascade one collision into a stalled fan-out', () => {
    /*
     * A HELD child holds nothing. If a held one's claims counted, the second
     * collision would hold a third child that has no real conflict, and one
     * overlap would stall the whole wave.
     */
    const p = plan([epic,
      kid('a', ['shared/']),
      kid('b', ['shared/x.ts']),
      kid('c', ['shared/x.ts']),
    ]);
    expect(p.launchCount, 'a held sibling was allowed to hold paths').toBe(1);
    expect(p.children.filter(c => c.hold === 'claimed-by-sibling')).toHaveLength(2);
  });
});

describe('claims it cannot read', () => {
  it('holds the child rather than launching it into nothing', () => {
    // The card believes it owns a subtree and owns none of it: the gate will
    // refuse it. Launching would spend an agent to hit that refusal.
    const p = plan([epic, kid('a', ['packages/**']), kid('b', ['x/'])]);
    const bad = p.children.find(c => c.id === 'a')!;
    expect(bad.launch).toBe(false);
    expect(bad.hold).toBe('unreadable-claim');
    expect(bad.holdText).toContain('packages/**');
    expect(p.launchCount).toBe(1);
  });
});

describe('the ceiling', () => {
  it('refuses the whole fan-out once, not each child four times', () => {
    // The reason is about the PARENT. Repeated per row it reads as four
    // problems where there is one.
    const p = plan([epic, kid('a'), kid('b')], { allowed: false, reason: 'This card is 2 levels deep' });
    expect(p.blocked).toContain('2 levels deep');
    expect(p.launchCount).toBe(0);
    expect(p.children.every(c => c.hold === 'too-deep')).toBe(true);
  });
});

describe('what is not work to dispatch', () => {
  it('leaves finished and discarded children out of the plan entirely', () => {
    // Not held - ABSENT. A done card in a launch list is noise that makes the
    // count look wrong.
    const p = plan([epic,
      kid('a'),
      kid('done', undefined, 'DONE'),
      kid('trashed', undefined, 'TRASHED'),
      kid('idea', undefined, 'IDEAS'),
    ]);
    expect(p.children.map(c => c.id)).toEqual(['a']);
    expect(launchLabel(p)).toBe('Launch 1');
  });

  it('ignores cards that are not children of this parent', () => {
    const other: Item = { id: 'other', title: 'Other', status: 'TODO', parentId: 'somewhere-else' };
    const p = plan([epic, kid('a'), other]);
    expect(p.children.map(c => c.id)).toEqual(['a']);
  });
});

describe('an epic with nothing under it', () => {
  it('plans nothing and blames nobody', () => {
    // No children is not a blockage: a blocked message here would send
    // somebody looking for a collision that does not exist.
    const p = plan([epic]);
    expect(p.children).toEqual([]);
    expect(p.launchCount).toBe(0);
    expect(p.blocked).toBeNull();
  });
});

/**
 * The local copy of the depth rule agrees with core (CGLAB-199).
 *
 * `mayFanOutLocal` duplicates `mayFanOut` because core compiles to CommonJS
 * and importing it into the browser bundle shipped a black window earlier
 * today, with every test and the build reporting success. A copy that drifts
 * would let the sheet offer a fan-out the server refuses - so the agreement is
 * pinned rather than trusted. This test can import core; the bundle cannot.
 */
describe('the duplicated depth rule agrees with core', () => {
  const tree = [
    { id: 'epic' },
    { id: 'story', parentId: 'epic' },
    { id: 'task', parentId: 'story' },
    { id: 'deep', parentId: 'task' },
  ];

  it('gives the same depth for every node', async () => {
    const { fanOutDepth } = await import('@agenfk/core');
    for (const node of tree) {
      expect(fanOutDepthLocal(node.id, tree), `depth disagrees for ${node.id}`)
        .toBe(fanOutDepth(node.id, tree));
    }
  });

  it('gives the same verdict at every ceiling', async () => {
    const { mayFanOut } = await import('@agenfk/core');
    for (const node of tree) {
      for (const max of [0, 1, 2, 3]) {
        expect(mayFanOutLocal(node.id, tree, max).allowed, `verdict disagrees for ${node.id} at ${max}`)
          .toBe(mayFanOut(node.id, tree, max).allowed);
      }
    }
  });

  it('shares the DEFAULT ceiling, not just the explicit ones', async () => {
    /*
     * The parity tests above all pass a ceiling, so a drift in the DEFAULT
     * slipped past every one of them - caught by mutation rather than by
     * design. The default is the value almost every caller actually uses.
     */
    const { mayFanOut, DEFAULT_MAX_FAN_OUT_DEPTH } = await import('@agenfk/core');
    for (const node of tree) {
      expect(mayFanOutLocal(node.id, tree).allowed, `default verdict disagrees for ${node.id}`)
        .toBe(mayFanOut(node.id, tree, DEFAULT_MAX_FAN_OUT_DEPTH).allowed);
    }
  });

  it('closes the escape route in its own words too', () => {
    // The reason is what an agent reads. A copy that kept the verdict and lost
    // the sentence would let somebody go looking for the way around.
    expect(mayFanOutLocal('story', tree).reason).toMatch(/does not reset/i);
  });
});

/**
 * A card that keeps failing is refused before it costs another agent
 * (CGLAB-202).
 *
 * The sheet is the moment where the breaker is worth the most: refusing after
 * the launch costs an agent to learn what the count already knew.
 */
describe('a card the breaker has stopped', () => {
  const broken = new Map([['b', 3]]);

  it('is held, and the reason points at a person rather than a path', () => {
    /*
     * Reported BEFORE the claim check, deliberately. A stopped card is not
     * waiting on a file, and calling it a claim conflict would send somebody
     * to renegotiate paths when the problem is somewhere else entirely.
     */
    const p = planFleet({ parentId: 'epic', all: [epic, kid('a'), kid('b')], depth: OK, failures: broken });
    const held = p.children.find(c => c.id === 'b')!;
    expect(held.launch).toBe(false);
    expect(held.hold).toBe('circuit-broken');
    expect(held.holdText).toMatch(/somebody has to look/i);
  });

  it('does not stop the rest of the fleet', () => {
    // One card stopped is one card stopped. The others have nothing to do
    // with its failures.
    const p = planFleet({ parentId: 'epic', all: [epic, kid('a'), kid('b')], depth: OK, failures: broken });
    expect(p.launchCount).toBe(1);
    expect(launchLabel(p)).toBe('Launch 1');
  });

  it('launches normally below the threshold', () => {
    const p = planFleet({
      parentId: 'epic', all: [epic, kid('a'), kid('b')], depth: OK,
      failures: new Map([['b', 2]]),
    });
    expect(p.launchCount).toBe(2);
  });

  it('launches everything when no count is supplied at all', () => {
    // Most callers have no failure history, and a missing map must not read as
    // "everything has failed" - absence authorises, as everywhere else here.
    const p = planFleet({ parentId: 'epic', all: [epic, kid('a'), kid('b')], depth: OK });
    expect(p.launchCount).toBe(2);
  });

  it('agrees with core about when to stop', async () => {
    // The copy exists because core is CommonJS and the bundle cannot have it.
    // A copy that drifts would offer a launch the server refuses.
    const { mayDispatch, CIRCUIT_BREAK_AFTER } = await import('@agenfk/core');
    for (const n of [0, 1, 2, 3, 4, 10]) {
      expect(dispatchAllowed(n).allowed, `disagrees at ${n}`).toBe(mayDispatch({ failureCount: n }).allowed);
    }
    expect(CIRCUIT_BREAK_AFTER_LOCAL).toBe(CIRCUIT_BREAK_AFTER);
  });
});
