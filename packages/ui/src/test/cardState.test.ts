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
