/**
 * How many times a caller may hit an expensive route (CodeQL js/missing-rate-limiting).
 *
 * Five routes on this server do real work per request: `git status` and the PR
 * import spawn processes, the file listing walks a directory, worktree creation
 * checks out a repository. None had a ceiling, so a loop in a client - or a
 * retry storm, or an agent that misreads slowness as failure and re-asks - can
 * spend the machine.
 *
 * THE THREAT MODEL IS A RUNAWAY LOOP, NOT AN ATTACKER. The server binds to
 * loopback and refuses cross-origin browsers, so nothing here is reachable from
 * the network; what it is reachable from is every process on the machine,
 * including the agents this product exists to run. The limit is therefore set
 * to stop a loop, not to ration a person - which is the difference between a
 * number that protects and a number that gets in the way.
 *
 * THE FLOOR IS SET BY WHAT THE APP ITSELF DOES. The UI polls git-status every
 * four seconds (gitStatus.ts), so fifteen requests a minute is ORDINARY use.
 * Any ceiling near that breaks the product to satisfy a static-analysis alert,
 * which is the wrong trade and an easy one to make without checking. Sixty a
 * minute leaves the normal case four times under the line and still stops a
 * loop dead.
 *
 * A FIXED WINDOW, not a sliding one. A sliding window needs a timestamp per
 * request; this needs a counter and a moment. The imprecision at the boundary -
 * up to twice the limit across two adjacent windows - does not matter for a
 * number chosen to be four times the real load.
 */

/** Requests allowed per window, per caller, per route. */
export const EXPENSIVE_ROUTE_LIMIT = 60;

/** The window, in ms. */
export const EXPENSIVE_ROUTE_WINDOW_MS = 60_000;

export interface BudgetState {
  /** Requests counted so far in the current window. */
  readonly count: number;
  /** When the current window opened. */
  readonly windowStartedAt: number;
}

export interface BudgetDecision {
  readonly allowed: boolean;
  /** The state to store back. Always present, allowed or not. */
  readonly next: BudgetState;
  /** Seconds until the caller may retry. Zero when allowed. */
  readonly retryAfterSeconds: number;
}

/**
 * Count one request and say whether it may proceed.
 *
 * Takes and returns state rather than holding it, so the decision is testable
 * without a clock or a server, and so the caller owns eviction - an in-process
 * map that only ever grows is its own denial of service, which would be a
 * pleasing way to fail while fixing this.
 */
export function spendRequestBudget(
  state: BudgetState | undefined,
  now: number,
  limit: number = EXPENSIVE_ROUTE_LIMIT,
  windowMs: number = EXPENSIVE_ROUTE_WINDOW_MS,
): BudgetDecision {
  // A window that has run out starts again, rather than the caller being held
  // at the limit for ever. Never having asked and having asked long ago are
  // the same thing.
  if (!state || now - state.windowStartedAt >= windowMs) {
    return { allowed: true, next: { count: 1, windowStartedAt: now }, retryAfterSeconds: 0 };
  }

  if (state.count >= limit) {
    /*
     * REFUSED WITHOUT COUNTING. Incrementing here would let a client that keeps
     * hammering push its own window's counter up for ever, which changes
     * nothing about the verdict but makes the number in any log meaningless.
     */
    const remaining = windowMs - (now - state.windowStartedAt);
    return {
      allowed: false,
      next: state,
      // Rounded UP: telling somebody to retry in 0 seconds when the window has
      // 400ms left invites an immediate second refusal.
      retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)),
    };
  }

  return {
    allowed: true,
    next: { count: state.count + 1, windowStartedAt: state.windowStartedAt },
    retryAfterSeconds: 0,
  };
}

/**
 * Whether a stored window is old enough to forget.
 *
 * The counterpart to the map: entries are keyed by caller and route, and
 * without eviction the map grows for the life of the process. Exported so the
 * sweep is the same rule as the reset, not a second guess at it.
 */
export function budgetIsStale(
  state: BudgetState,
  now: number,
  windowMs: number = EXPENSIVE_ROUTE_WINDOW_MS,
): boolean {
  return now - state.windowStartedAt >= windowMs;
}
