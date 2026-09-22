/**
 * The ceiling on the expensive routes (CodeQL js/missing-rate-limiting).
 *
 * THE TEST THAT MATTERS IS THAT ORDINARY USE STAYS UNDER IT. A limit chosen to
 * satisfy a static-analysis alert, without checking what the product itself
 * does, breaks the product - and the UI polls git-status every four seconds, so
 * fifteen requests a minute is NORMAL. That number, not the alert, is what sets
 * the floor.
 *
 * The counting moved to express-rate-limit, so what is left to test is the
 * choice of number - which is the half a library cannot make. The behaviour of
 * the limiter itself is covered end to end in the server's
 * security-hardening suite, against the real route.
 */
import { describe, it, expect } from 'vitest';
import { EXPENSIVE_ROUTE_LIMIT, EXPENSIVE_ROUTE_WINDOW_MS } from '../requestBudget';

/** What the UI's own refetchInterval costs, in requests per window. */
const POLLING_LOAD = EXPENSIVE_ROUTE_WINDOW_MS / 4000;

describe('the ceiling', () => {
  it('leaves ordinary polling a long way underneath', () => {
    /*
     * THE test, stated as a RELATIONSHIP rather than as two numbers, so that
     * retuning either the poll interval or the limit cannot quietly close the
     * gap and throttle the app against itself.
     */
    expect(EXPENSIVE_ROUTE_LIMIT).toBeGreaterThanOrEqual(POLLING_LOAD * 3);
  });

  it('is a per-minute window, which is what the message promises', () => {
    // The 429 body says "a minute". A window in other units would make the
    // sentence a lie without changing any behaviour, which is the kind of
    // wrong nobody notices.
    expect(EXPENSIVE_ROUTE_WINDOW_MS).toBe(60_000);
  });

  it('is high enough to be invisible and low enough to stop a loop', () => {
    // A loop makes hundreds of requests a second. Anything in this range stops
    // it inside a second; the lower bound is what keeps a person from meeting
    // it by working normally.
    expect(EXPENSIVE_ROUTE_LIMIT).toBeGreaterThan(POLLING_LOAD);
    expect(EXPENSIVE_ROUTE_LIMIT).toBeLessThan(600);
  });
});
