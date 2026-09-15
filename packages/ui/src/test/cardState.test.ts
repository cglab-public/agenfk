/**
 * What the ONE dot on a projects-tree row is allowed to say (CGLAB-164).
 *
 * The app has two lists that could each carry a status — the Sessions rail and
 * the Projects tree — and the decision taken on the card is that they must not
 * repeat each other. The tree answers "is anything happening to this card",
 * per card; the rail answers "which agent, how long, stop it", per session.
 *
 * So this derivation is deliberately narrow: three states, none of them the
 * flow step. The flow step stays TEXT on the right of the row, where it cannot
 * be confused for a second copy of the rail's colour coding.
 */
import { describe, it, expect } from 'vitest';
import { cardState, itemsNeedingAPerson, CARD_STATE_LABEL } from '../cardState';
import type { SessionState } from '../components/SessionsRail';

describe('cardState', () => {
  const none: ReadonlySet<string> = new Set();

  it('is quiet when nothing is running on the card', () => {
    // A ring, not an absence: the row still has to line up with its
    // neighbours. But it claims nothing.
    expect(cardState('i1', none, none)).toBe('quiet');
  });

  it('is working while an agent is live on that card', () => {
    expect(cardState('i1', new Set(['i1']), none)).toBe('working');
  });

  it('stays quiet for a card the live set is not about', () => {
    // The whole point of the dot. Without this it is the old always-on dot in
    // a different colour.
    expect(cardState('i1', new Set(['somebody-else']), none)).toBe('quiet');
  });

  it('needs a person when a session on that card is blocked', () => {
    expect(cardState('i1', none, new Set(['i1']))).toBe('needs-person');
  });

  it('puts needs-a-person ahead of working, because that is the one you must act on', () => {
    /*
     * Not a tie-break for its own sake. Liveness is the RECENCY of terminal
     * output, and an agent that just printed a permission prompt has, by
     * definition, just produced output — so a blocked card is very nearly
     * always live as well. Resolve this the other way round and the amber
     * state is unreachable in practice: the one row that needs a human would
     * be drawn as the one row that needs nobody.
     */
    expect(cardState('i1', new Set(['i1']), new Set(['i1']))).toBe('needs-person');
  });
});

describe('itemsNeedingAPerson', () => {
  it('picks out the blocked sessions and nothing else', () => {
    const rows: Array<{ itemId: string; state: SessionState }> = [
      { itemId: 'i1', state: 'blocked' },
      { itemId: 'i2', state: 'running' },
      { itemId: 'i3', state: 'idle' },
    ];
    expect([...itemsNeedingAPerson(rows)]).toEqual(['i1']);
  });

  /*
   * A test used to sit here asserting the opposite - that a failed run was left
   * to the rail, because the tree had three states and 'failed' was a
   * per-session fact the rail already drew. It was right while the rail
   * existed. The rail is gone (1a1b8df6): processes are drawn beneath their
   * card, so that reasoning expired with the section it depended on.
   *
   * Recorded rather than quietly deleted, because "this assertion was
   * deliberately reversed" and "somebody dropped a test to make a change pass"
   * look identical in a diff a year from now. The replacement lives in the
   * block at the end of this file.
   */

  it('flags the card when any one of two agents sharing it is blocked', () => {
    // Sessions are keyed by card AND agent, so one card can appear twice. The
    // tree has a single row for it, and a blocked agent has to reach that row.
    const rows: Array<{ itemId: string; state: SessionState }> = [
      { itemId: 'i1', state: 'running' },
      { itemId: 'i1', state: 'blocked' },
    ];
    expect([...itemsNeedingAPerson(rows)]).toEqual(['i1']);
  });

  it('is empty when there are no sessions at all', () => {
    expect(itemsNeedingAPerson([]).size).toBe(0);
  });
});

describe('CARD_STATE_LABEL', () => {
  it('says the two states worth announcing in words, because a 7px dot is a mouse-only fact', () => {
    expect(CARD_STATE_LABEL.working).toMatch(/an agent is working/i);
    expect(CARD_STATE_LABEL['needs-person']).toMatch(/needs you|waiting for you/i);
  });

  it('has nothing to say about a quiet card', () => {
    /*
     * Not an oversight — the absence is the answer. A sidebar that announces
     * "nothing running" on every row of a thirty-card list is noise wearing an
     * accessibility badge, so `quiet` is excluded from the record's TYPE and
     * the component cannot render a label for it even by accident. Review
     * found the string sitting here unused and defended by a rule that
     * protected nothing.
     */
    expect(Object.keys(CARD_STATE_LABEL).sort()).toEqual(['needs-person', 'working']);
  });

  it('never lets a blocked row claim an agent is working', () => {
    // A row the shell asserts on directly: the sidebar test reads the row's
    // text and requires that phrase to be absent until an agent really is
    // there. Two labels sharing a substring would make that test pass on a
    // card that is merely blocked.
    expect(CARD_STATE_LABEL['needs-person']).not.toMatch(/an agent is working/i);
  });
});

/**
 * The tree and the rail must not contradict each other (review follow-up).
 *
 * `working` was resolved from the liveness set, which is the recency of
 * terminal OUTPUT. The rail resolves the same card through a four-source
 * precedence whose FIRST rule is that a dead process is a fact — a rule added
 * because "the row stayed green for the full TTL after the session died,
 * which is what was reported".
 *
 * The tree had no such override, so for the same card, at the same moment:
 *
 *   agent crashes  → rail: failed (sorted first)  · tree: WORKING for 90s
 *   turn finishes  → rail: idle                   · tree: WORKING for 90s
 *   agent wedges   → rail: running                · tree: quiet
 *
 * The first is the one that made the previous commit message wrong in the
 * worse direction: it said a crashed agent "reads as nothing running". It read
 * as actively working, and told a screen reader so out loud.
 *
 * The fix is not another special case. Both lists now derive from the same
 * rows, so they agree by construction, and liveness is used only for cards
 * that have no session here at all.
 */
describe('agreeing with the rail', () => {
  const live = (...ids: string[]) => new Set(ids);
  const none = new Set<string>();

  it('does not call a crashed agent working', () => {
    // The reported bug, in the tree this time.
    const rows = [{ itemId: 'i1', state: 'failed' as const }];
    expect(cardState('i1', live('i1'), none, rows)).not.toBe('working');
  });

  it('does not call a finished turn working', () => {
    // The commonest path of all: every completed turn leaves output behind,
    // so liveness alone said "working" until the window expired.
    const rows = [{ itemId: 'i1', state: 'idle' as const }];
    expect(cardState('i1', live('i1'), none, rows)).toBe('quiet');
  });

  it('calls a wedged agent working when the rail does', () => {
    /*
     * The contradiction in the other direction. An agent that stopped
     * emitting but still publishes a working title is `running` to the rail,
     * and the tree used to draw it quiet because nothing had arrived lately.
     */
    const rows = [{ itemId: 'i1', state: 'running' as const }];
    expect(cardState('i1', none, none, rows)).toBe('working');
  });

  it('still answers for a card with no session here at all', () => {
    // A run recorded by the hook has a transcript and no terminal of ours, so
    // there is no row to agree with and recency is all there is.
    expect(cardState('i1', live('i1'), none, [])).toBe('working');
  });

  it('keeps needs-person ahead of everything', () => {
    // Unchanged and still load-bearing: a blocked agent has just produced
    // output, so it is live too, and the other order makes amber unreachable.
    const rows = [{ itemId: 'i1', state: 'blocked' as const }];
    expect(cardState('i1', live('i1'), new Set(['i1']), rows)).toBe('needs-person');
  });

  it('takes one running agent as enough when a card has two', () => {
    // Rows are keyed by card AND agent, so a card can appear twice. One
    // working agent means something is happening to that card.
    const rows = [
      { itemId: 'i1', state: 'idle' as const },
      { itemId: 'i1', state: 'running' as const },
    ];
    expect(cardState('i1', none, none, rows)).toBe('working');
  });
});

/**
 * A crashed agent needs a person (1a1b8df6).
 *
 * `failed` was deliberately excluded, and the reasoning was sound at the time:
 * a failure is a per-session fact, the sessions rail is where it was drawn, and
 * folding it in would have put a fourth state on a three-state mark. The cost
 * was written down rather than hidden - "a card whose agent has just crashed
 * draws the quiet ring until someone looks at the rail".
 *
 * That cost was payable because the rail existed. The rail is being removed:
 * processes move under the card they belong to, so the crashed agent's row and
 * the card's own mark now sit one line apart. A grey ring directly above a rose
 * "Failed" row is not a considered trade-off any more, it is a contradiction
 * the user can see in a single glance.
 *
 * So the premise expired with the section, and this is the assertion that says
 * so. It is NOT a fourth state: `failed` maps onto the same needs-person the
 * blocked rows already use, because what a person does about a crashed agent
 * and about a blocked one is the same thing - look at it.
 */
describe('a crashed agent is a card that needs a person', () => {
  it('flags a card whose agent failed', () => {
    expect(itemsNeedingAPerson([{ itemId: 'i1', state: 'failed' }]).has('i1')).toBe(true);
  });

  it('still flags a blocked one, which was never in question', () => {
    expect(itemsNeedingAPerson([{ itemId: 'i1', state: 'blocked' }]).has('i1')).toBe(true);
  });

  it('leaves a card alone when nothing on it wants attention', () => {
    // The guard against the lazy fix of returning every card that has any row.
    expect(itemsNeedingAPerson([
      { itemId: 'i1', state: 'running' },
      { itemId: 'i2', state: 'idle' },
    ]).size).toBe(0);
  });

  it('flags the card with the failure and not its neighbour', () => {
    const flagged = itemsNeedingAPerson([
      { itemId: 'i1', state: 'failed' },
      { itemId: 'i2', state: 'running' },
    ]);
    expect([...flagged]).toEqual(['i1']);
  });

  it('wins over a sibling that is merely running', () => {
    /*
     * The roll-up rule the design rests on: the card shows the most demanding
     * state beneath it. A card with one crashed agent and one healthy one is
     * amber, because the healthy agent is not the one you need to know about.
     */
    const rows = [
      { itemId: 'i1', state: 'running' as const },
      { itemId: 'i1', state: 'failed' as const },
    ];
    expect(itemsNeedingAPerson(rows).has('i1')).toBe(true);
  });
});
