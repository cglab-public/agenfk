/**
 * Stop retrying, and stay stopped (CGLAB-202).
 *
 * A dispatch that fails for the same reason repeats forever, and each repeat
 * costs an agent. The breaker turns a repeated failure into A PERSON LOOKING,
 * which is the only thing that resolves a cause the machine cannot see.
 *
 * THE TEST THAT MATTERS IS THE ESCAPE ROUTE. A limit that resets when you ask
 * a different way is not a limit, and "start a fresh dispatch" is how anybody
 * asks differently - usually while doing their honest best.
 *
 * THE SECOND IS A ONE-WORD TRAP: below the threshold the card goes back to
 * READY, never pending. Pending strands it, because promotion out of pending
 * happens when a dependency completes and a failed card has none left. That is
 * the difference between "try again" and "never runs again", and it hides for
 * months.
 */
import { describe, it, expect } from 'vitest';
import { recordFailure, mayDispatch, clearFailures, CIRCUIT_BREAK_AFTER } from '../circuitBreaker';

describe('counting up to the limit', () => {
  it('lets the first two failures retry', () => {
    expect(recordFailure({ failureCount: 0 }).verdict).toBe('retry');
    expect(recordFailure({ failureCount: 1 }).verdict).toBe('retry');
  });

  it('opens on the third', () => {
    const d = recordFailure({ failureCount: 2 });
    expect(d.verdict).toBe('broken');
    expect(d.failureCount).toBe(3);
  });

  it('stays open past the third, rather than wrapping around', () => {
    // A counter that only checks equality reopens the card on the fourth
    // failure, which is the worst possible moment to start retrying again.
    expect(recordFailure({ failureCount: 9 }).verdict).toBe('broken');
    expect(mayDispatch({ failureCount: 9 }).allowed).toBe(false);
  });
});

describe('where the card sits afterwards', () => {
  it('goes back to READY below the limit, never to pending', () => {
    /*
     * THE one-word trap. Pending strands it: promotion out of pending happens
     * when a dependency completes, and a card that failed has no dependency
     * left to complete. "try again" against "never runs again", in one word.
     */
    const d = recordFailure({ failureCount: 0 });
    expect(d.status, 'a retryable card was parked where nothing promotes it').toBe('ready');
  });

  it('is failed once the breaker opens', () => {
    expect(recordFailure({ failureCount: 2 }).status).toBe('failed');
  });

  it('always says something, because a silent stop is worse than none', () => {
    // A card that quietly stops being picked up looks like a scheduler bug.
    for (const n of [0, 1, 2, 5]) {
      expect(recordFailure({ failureCount: n }).message.length).toBeGreaterThan(0);
    }
  });
});

describe('the escape route', () => {
  it('refuses a dispatch on a broken card BEFORE it costs an agent', () => {
    const d = mayDispatch({ failureCount: CIRCUIT_BREAK_AFTER });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/somebody has to look/i);
  });

  it('closes the door it knows will be tried', () => {
    /*
     * THE test. "Open a fresh dispatch and it will work" is the thought
     * everybody has. The message says it will not, because the count belongs
     * to the card rather than the attempt - and a refusal that only states the
     * rule sends somebody looking for a way around it.
     */
    const message = recordFailure({ failureCount: 2 }).message;
    expect(message, 'the message left the obvious workaround open')
      .toMatch(/do not route around|belongs to the card/i);
  });

  it('gives the same answer however the card is reached', () => {
    // Depth of question, not route: asking three times returns one answer.
    const answers = [1, 1, 1].map(() => mayDispatch({ failureCount: 3 }).allowed);
    expect(new Set(answers).size).toBe(1);
  });
});

describe('what may reset it', () => {
  it('clears to zero, so the meaning stays CONSECUTIVE', () => {
    /*
     * A card that fails, succeeds and fails again has failed twice - not
     * twice in a row. A reset that fired on any state change would make the
     * breaker unreachable in practice, which is the quietest way to lose a
     * safeguard.
     */
    expect(clearFailures().failureCount).toBe(0);
    expect(mayDispatch(clearFailures()).allowed).toBe(true);
  });
});

describe('the threshold', () => {
  it('is three, and is one number rather than a literal in two places', () => {
    // Two copies of a threshold drift, and the drift shows up as a breaker
    // that opens at three and refuses at four.
    expect(CIRCUIT_BREAK_AFTER).toBe(3);
    expect(recordFailure({ failureCount: CIRCUIT_BREAK_AFTER - 1 }).verdict).toBe('broken');
    expect(mayDispatch({ failureCount: CIRCUIT_BREAK_AFTER - 1 }).allowed).toBe(true);
  });
});
