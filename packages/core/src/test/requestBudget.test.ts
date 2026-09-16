/**
 * A ceiling on the expensive routes (CodeQL js/missing-rate-limiting).
 *
 * THE TEST THAT MATTERS IS THAT ORDINARY USE STAYS UNDER IT. A limit chosen to
 * satisfy a static-analysis alert, without checking what the product itself
 * does, breaks the product - and the UI polls git-status every four seconds, so
 * fifteen requests a minute is NORMAL. That number, not the alert, is what sets
 * the floor.
 */
import { describe, it, expect } from 'vitest';
import {
  spendRequestBudget,
  budgetIsStale,
  EXPENSIVE_ROUTE_LIMIT,
  EXPENSIVE_ROUTE_WINDOW_MS,
  type BudgetState,
} from '../requestBudget';

const T0 = 1_000_000_000_000;

/** Spend n requests in a row from a fresh state, returning the last decision. */
const spendTimes = (n: number, now = T0) => {
  let state: BudgetState | undefined;
  let last = spendRequestBudget(state, now);
  state = last.next;
  for (let i = 1; i < n; i++) {
    last = spendRequestBudget(state, now);
    state = last.next;
  }
  return { last, state: state! };
};

describe('what ordinary use looks like', () => {
  it('lets the app poll git-status every four seconds without ever being refused', () => {
    /*
     * THE test. The UI's own refetchInterval is 4000ms, so a minute of sitting
     * on the board is fifteen requests. A ceiling anywhere near that would turn
     * a security alert into a broken product - and nothing in the alert tells
     * you the number, so it has to come from here.
     */
    let state: BudgetState | undefined;
    for (let i = 0; i < 15; i++) {
      const d = spendRequestBudget(state, T0 + i * 4000);
      expect(d.allowed, `ordinary polling was refused at request ${i + 1}`).toBe(true);
      state = d.next;
    }
  });

  it('leaves the normal load a long way under the ceiling', () => {
    // Stated as a relationship, not a number, so retuning the interval or the
    // limit cannot quietly close the gap.
    const perMinuteWhenPolling = EXPENSIVE_ROUTE_WINDOW_MS / 4000;
    expect(EXPENSIVE_ROUTE_LIMIT).toBeGreaterThanOrEqual(perMinuteWhenPolling * 3);
  });
});

describe('what it refuses', () => {
  it('stops a loop once it passes the limit', () => {
    const { state } = spendTimes(EXPENSIVE_ROUTE_LIMIT);
    const next = spendRequestBudget(state, T0);
    expect(next.allowed, 'the loop was allowed past the ceiling').toBe(false);
  });

  it('allows exactly the limit, not one fewer', () => {
    // Off by one here is invisible in use and wrong in every log.
    const { last } = spendTimes(EXPENSIVE_ROUTE_LIMIT);
    expect(last.allowed).toBe(true);
  });

  it('does not count a refused request, so the stored number stays meaningful', () => {
    /*
     * A client that keeps hammering would otherwise drive its own counter to
     * thousands. It changes no verdict and makes the number in any log a
     * measure of the client's stubbornness rather than of its load.
     */
    const { state } = spendTimes(EXPENSIVE_ROUTE_LIMIT);
    const a = spendRequestBudget(state, T0);
    const b = spendRequestBudget(a.next, T0);
    expect(a.next.count).toBe(EXPENSIVE_ROUTE_LIMIT);
    expect(b.next.count).toBe(EXPENSIVE_ROUTE_LIMIT);
  });

  it('says when to come back, and never says zero', () => {
    // "Retry after 0 seconds" invites an immediate second refusal, which is a
    // loop of its own making.
    const { state } = spendTimes(EXPENSIVE_ROUTE_LIMIT);
    const refused = spendRequestBudget(state, T0 + EXPENSIVE_ROUTE_WINDOW_MS - 400);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe('when the window turns over', () => {
  it('lets a caller through again once the window has passed', () => {
    /*
     * Held at the limit for ever would make one bad minute permanent. Never
     * having asked and having asked long ago are the same thing.
     */
    const { state } = spendTimes(EXPENSIVE_ROUTE_LIMIT);
    const after = spendRequestBudget(state, T0 + EXPENSIVE_ROUTE_WINDOW_MS);
    expect(after.allowed).toBe(true);
    expect(after.next.count, 'the new window did not start from one').toBe(1);
  });

  it('treats a caller it has never seen as fresh, not as at the limit', () => {
    // Absence is not evidence of load. Defaulting the other way would refuse
    // the first request every process ever makes.
    expect(spendRequestBudget(undefined, T0).allowed).toBe(true);
  });
});

describe('forgetting old callers', () => {
  it('calls a window stale on exactly the rule the reset uses', () => {
    /*
     * The map is keyed by caller and route, so without eviction it grows for
     * the life of the process - a denial of service inside the fix for one,
     * which would be a pleasing way to fail. Same rule as the reset, so the
     * sweep cannot disagree with the counter.
     */
    const state: BudgetState = { count: 5, windowStartedAt: T0 };
    expect(budgetIsStale(state, T0 + EXPENSIVE_ROUTE_WINDOW_MS)).toBe(true);
    expect(budgetIsStale(state, T0 + EXPENSIVE_ROUTE_WINDOW_MS - 1)).toBe(false);

    // And it agrees with spendRequestBudget at the same moment.
    expect(spendRequestBudget(state, T0 + EXPENSIVE_ROUTE_WINDOW_MS).next.count).toBe(1);
  });
});
