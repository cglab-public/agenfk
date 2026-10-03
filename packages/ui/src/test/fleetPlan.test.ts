/**
 * What would actually run, before anything is spent (CGLAB-207).
 *
 * A fan-out that discovers a child cannot start AFTER launching three agents
 * has spent real money to learn what was already known.
 *
 * THE FAILURE THAT MATTERS MOST IS THE COUNT. "Launch 4" that launches three
 * is the easiest mistake here and the most damaging, because the number is the
 * one part of this screen a person trusts without checking.
 */
import { describe, it, expect } from 'vitest';
import { planFleet, launchLabel, fanOutDepthLocal, mayFanOutLocal, dispatchAllowed, CIRCUIT_BREAK_AFTER_LOCAL, type FleetInputs } from '../fleetPlan';

const OK: FleetInputs['depth'] = { allowed: true, reason: null };

type Item = FleetInputs['all'][number];
const kid = (id: string, status = 'TODO'): Item =>
  ({ id, title: `t-${id}`, status, parentId: 'epic' });

const epic: Item = { id: 'epic', title: 'The epic', status: 'IN_PROGRESS' };

const plan = (all: Item[], depth: FleetInputs['depth'] = OK) => planFleet({ parentId: 'epic', all, depth });

describe('the number on the button', () => {
  it('says so plainly when nothing can start', () => {
    // "Launch 0" is a button somebody presses. This is not.
    const p = plan([epic, kid('a')], { allowed: false, reason: 'ceiling' });
    expect(launchLabel(p)).toBe('Nothing to launch');
  });

  it('says why, when every child is running or stopped', () => {
    const p = planFleet({
      parentId: 'epic', all: [epic, kid('a'), kid('b')], depth: OK,
      running: new Set(['a']), failures: new Map([['b', 3]]),
    });
    expect(p.launchCount).toBe(0);
    expect(p.blocked).toMatch(/already running or stopped after repeated failures/i);
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
      kid('done', 'DONE'),
      kid('trashed', 'TRASHED'),
      kid('idea', 'IDEAS'),
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
    // somebody looking for a cause that does not exist.
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

  it('is held, and the reason points at a person', () => {
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

/**
 * A finished card on a flow whose exit is not called DONE (fae59deb).
 *
 * An item's status IS its flow step's name, and `agenfk flow create` produces
 * whatever name the author typed. The literal DONE/ARCHIVED list cannot see it,
 * so a done child stayed dispatchable and "Launch N" counted it - the one number
 * the sheet promises never to be generous about.
 */
describe('a card finished on a custom flow', () => {
  it('is left out of the plan when the flow named the terminal step', () => {
    const p = planFleet({
      parentId: 'epic', depth: OK,
      all: [epic, kid('a'), kid('b', 'SHIPPED')],
      terminalStatuses: new Set(['SHIPPED']),
    });
    expect(p.children.map(c => c.id), 'a finished card was counted as launchable').toEqual(['a']);
  });

  it('is still a child when the flow was NOT read', () => {
    // Absent keeps the old behaviour rather than guessing at a terminal name.
    const p = planFleet({ parentId: 'epic', depth: OK, all: [epic, kid('a'), kid('b', 'SHIPPED')] });
    expect(p.children.map(c => c.id)).toEqual(['a', 'b']);
  });
});
