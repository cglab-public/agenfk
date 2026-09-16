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
import { PRODUCIBLE_STATES, runState, CONTACT_GRACE_MS, type SessionState } from '../sessionRow';
import { itemsNeedingAPerson } from '../cardState';
import { DOT, STATE_LABEL, ORDER } from '../components/sessionPresentation';

describe('every state the UI can draw is one the app can produce', () => {
  it('has no state the app cannot build', () => {
    expect([...PRODUCIBLE_STATES].sort())
      .toEqual(['blocked', 'failed', 'idle', 'running', 'unverifiable']);
  });

  it('keeps blocked, which earned its place by gaining a producer', () => {
    expect(PRODUCIBLE_STATES.has('blocked')).toBe(true);
  });

  it('keeps unverifiable, which earned its place the same way', () => {
    /*
     * Added with a producer, not before one: AppShell reads it off a run the
     * SERVER still records as running while we see no recent output. Without
     * that, it would be exactly the decorative state this file exists to keep
     * out - and the first attempt at this card did add it bare, and this test
     * is what caught it.
     */
    expect(PRODUCIBLE_STATES.has('unverifiable')).toBe(true);
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

/**
 * Loss of contact is not evidence of exit (CGLAB-195).
 *
 * An agent we cannot REACH used to fall into `idle`, which asserts that it
 * ended - and that is the reading that gets somebody to relaunch work still
 * running. The three words are fixed and the rule is not negotiable: report
 * `unverifiable`, never `idle` and never `failed`, and never collapse it into
 * either neighbour.
 *
 * THE STATE IS EARNED, NOT GRANTED. The first version of this returned it on
 * the first quiet second, which made a run that had simply just started read
 * as lost - a permanent alarm, and an alarm that is always on is one people
 * learn to ignore. It costs less to have no state at all than to have that.
 */
describe('what we can honestly say about a run', () => {
  const NOW = Date.parse('2026-09-16T12:00:00Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it('says running while we can see it', () => {
    expect(runState({ status: 'running', startedAt: ago(0) }, true, NOW)).toBe('running');
  });

  it('keeps a failure failed however old it is', () => {
    // A failure that ages into idle is a failure nobody sees.
    expect(runState({ status: 'failed', startedAt: ago(CONTACT_GRACE_MS * 10) }, false, NOW)).toBe('failed');
  });

  it('stays idle inside the grace window, because silence is ordinary there', () => {
    /*
     * A run that has just started has produced nothing yet. Calling it
     * unreachable there is the alarm-always-on failure; calling it running
     * would be the same presumption in the other direction.
     */
    expect(runState({ status: 'running', startedAt: ago(60_000) }, false, NOW)).toBe('idle');
  });

  it('becomes unverifiable once the silence lasts', () => {
    // THE test. The record says running, we see nothing, and enough time has
    // passed that the silence is itself information.
    expect(runState({ status: 'running', startedAt: ago(CONTACT_GRACE_MS + 1) }, false, NOW))
      .toBe('unverifiable');
  });

  it('never reports a finished run as unverifiable', () => {
    // We know how this one ended. Saying we cannot tell would be a worse
    // answer than the one we have.
    expect(runState({ status: 'done', startedAt: ago(CONTACT_GRACE_MS * 5) }, false, NOW)).toBe('idle');
  });

  it('does not invent loss of contact from a missing timestamp', () => {
    // Without a time we cannot say the silence is long, and the whole point of
    // this state is that it is claimed only on evidence.
    expect(runState({ status: 'running' }, false, NOW)).toBe('idle');
    expect(runState({ status: 'running', startedAt: 'not a date' }, false, NOW)).toBe('idle');
  });

  it('derives its window from the heartbeat rather than picking a number', () => {
    // Five minutes doubled: one missed heartbeat is the earliest a run can
    // honestly look unreachable.
    expect(CONTACT_GRACE_MS).toBe(10 * 60 * 1000);
  });
});

describe('what the three states do downstream', () => {
  it('sends unverifiable to the people who need a person', () => {
    /*
     * We do not know it is stuck - we know we cannot tell, and that is exactly
     * a thing somebody has to look at. Folding it into quiet would say the
     * opposite of what we know.
     */
    const needs = itemsNeedingAPerson([{ itemId: 'i1', state: 'unverifiable' }]);
    expect(needs.has('i1')).toBe(true);
  });

  it('gives it a label that neither guesses nor shrugs', () => {
    // "Unknown" tells the reader nothing to do; "Maybe running" asserts the
    // thing this state exists to deny.
    expect(STATE_LABEL.unverifiable).toBe('Cannot reach it');
  });

  it('draws it apart from blocked, without relying on hue', () => {
    // Both wait, so both are amber - but one waits on a person and the other
    // on knowledge, and at 6px the shape is the channel that survives.
    expect(DOT.unverifiable).not.toBe(DOT.blocked);
    expect(DOT.unverifiable).toContain('dashed');
  });
});
