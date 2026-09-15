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

  it('leaves a failed run to the rail, which is where the legend puts it', () => {
    /*
     * The tree has three states and 'failed' is not one of them — it is a
     * per-SESSION fact, and the rail draws it. Folding it in here would put a
     * second vocabulary on the tree and re-create exactly the duplication this
     * design exists to avoid.
     */
    expect([...itemsNeedingAPerson([{ itemId: 'i1', state: 'failed' }])]).toEqual([]);
  });

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
