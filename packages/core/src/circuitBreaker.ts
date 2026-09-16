/**
 * When to stop retrying a card that keeps failing (CGLAB-202).
 *
 * A dispatch that fails for the same reason can repeat forever, and each
 * repeat costs an agent. The breaker exists to turn a repeated failure into A
 * PERSON LOOKING, which is the only thing that resolves a cause the machine
 * cannot see.
 *
 * THE CLAUSE THAT MAKES IT A BREAKER rather than a decoration: opening a fresh
 * path does not reset the count. The failures belong to the CARD, not to the
 * attempt that discovered them, so re-asking by another route answers the same.
 * Without that, three tries become three per route and the number stops meaning
 * anything - which is exactly how a limit gets walked around by an agent doing
 * its honest best.
 *
 * BELOW THE THRESHOLD IT GOES BACK TO READY, never to pending. Pending would
 * strand it: promotion out of pending happens when a dependency completes, and
 * a card that failed has no dependency left to complete. That is a one-word
 * difference between "try again" and "never runs again", and it is the kind
 * that hides for months.
 */

/** Three consecutive failures and the card stops being retried. */
export const CIRCUIT_BREAK_AFTER = 3;

export type BreakerVerdict = 'retry' | 'broken';

export interface BreakerState {
  /** Consecutive failures recorded against this card. */
  readonly failureCount: number;
}

export interface BreakerDecision {
  readonly verdict: BreakerVerdict;
  /** The count after recording this failure. */
  readonly failureCount: number;
  /**
   * Where the card should sit now.
   *
   * `ready` below the threshold, never `pending` - see the header. `failed`
   * when the breaker opens.
   */
  readonly status: 'ready' | 'failed';
  /** What to tell whoever is watching. Always present: a silent stop is worse. */
  readonly message: string;
}

/**
 * Record one failure and say what happens next.
 *
 * Takes the count rather than reading it, so the decision is testable without
 * a database and cannot disagree with itself across two callers.
 */
export function recordFailure(state: BreakerState): BreakerDecision {
  const failureCount = state.failureCount + 1;
  if (failureCount >= CIRCUIT_BREAK_AFTER) {
    return {
      verdict: 'broken',
      failureCount,
      status: 'failed',
      message:
        `This card has failed ${failureCount} times in a row, so it will not be retried automatically. `
        + 'Read what the last attempt reported before trying again. '
        + 'Do not route around this with a fresh dispatch: the count belongs to the card, '
        + 'not to the attempt, so starting again answers the same.',
    };
  }
  return {
    verdict: 'retry',
    failureCount,
    status: 'ready',
    message: `Attempt ${failureCount} of ${CIRCUIT_BREAK_AFTER} failed. The card is ready to be picked up again.`,
  };
}

/**
 * Whether a card may be dispatched at all right now.
 *
 * Asked before spending, so a broken card is refused before it costs an agent
 * rather than after.
 */
export function mayDispatch(state: BreakerState): { allowed: boolean; reason: string | null } {
  if (state.failureCount >= CIRCUIT_BREAK_AFTER) {
    return {
      allowed: false,
      reason: `Stopped after ${state.failureCount} consecutive failures. `
        + 'Somebody has to look at this one before it runs again.',
    };
  }
  return { allowed: true, reason: null };
}

/**
 * Clear the count, which only a SUCCESS may do.
 *
 * Exported as its own function rather than folded into a status change,
 * because "consecutive" is the whole meaning: a card that fails, succeeds and
 * fails again has failed twice, not two-in-a-row, and a reset that fired on
 * any state change would quietly make the breaker unreachable.
 */
export function clearFailures(): BreakerState {
  return { failureCount: 0 };
}
