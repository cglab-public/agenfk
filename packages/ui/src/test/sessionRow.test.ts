/**
 * The state vocabulary, and the rule that keeps it honest (63bd3b13).
 *
 * These guards lived in SessionsRail.test.tsx. The rail is deleted - nothing
 * rendered it once processes moved under their cards - but this half of its
 * test file was never about the rail: it is about whether a state the UI can
 * DRAW is one something upstream can actually EMIT.
 *
 * That rule has already caught a real lie once. A 'waiting' state sat in this
 * set, sorted to the top, with a docblock calling it load-bearing - and nothing
 * could build one. The shell emitted only running or idle, and the rail's tests
 * handed the state straight to the component, so they passed while the app
 * could not reach it. A docblock describing behaviour nobody can trigger reads
 * like documentation and is not.
 *
 * `blocked` is the same state readmitted on different terms: it came back when
 * the screen-text reader gave it a producer, not when somebody wanted it.
 */
import { describe, it, expect } from 'vitest';
import { PRODUCIBLE_STATES, type SessionState } from '../sessionRow';
import { DOT, STATE_LABEL, ORDER } from '../components/sessionPresentation';

describe('every state the UI can draw is one the app can produce', () => {
  it('has no state the app cannot build', () => {
    expect([...PRODUCIBLE_STATES].sort()).toEqual(['blocked', 'failed', 'idle', 'running']);
  });

  it('keeps blocked, which earned its place by gaining a producer', () => {
    expect(PRODUCIBLE_STATES.has('blocked')).toBe(true);
  });

  /*
   * The half that did NOT exist before, and the reason this file is worth
   * having rather than being deleted with the rail.
   *
   * The drawing vocabulary moved to sessionPresentation and is now shared by
   * the process row and whatever draws next. Nothing tied it to the set of
   * states that can be produced - so a state could be added to one and not the
   * other, which is exactly the drift the original guard was written against,
   * one indirection further out.
   */
  it('can draw every state it admits to, and no more', () => {
    const producible = [...PRODUCIBLE_STATES].sort();
    for (const table of [DOT, STATE_LABEL, ORDER] as Record<SessionState, unknown>[]) {
      expect(Object.keys(table).sort(), 'a drawing table disagrees with PRODUCIBLE_STATES')
        .toEqual(producible);
    }
  });
});
