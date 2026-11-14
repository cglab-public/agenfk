/**
 * Say it, never act on it (CGLAB-201).
 *
 * THE TEST THAT MATTERS IS THE ONE ABOUT NOT KILLING. This module exists to
 * observe, and the next person to read it will be tempted by exactly the thing
 * it forbids - the shape of the data invites a `kill()` right here. A false
 * positive is a slow but correct agent, and killing good work is irreversible;
 * a false negative is an occupied slot, which is visible and reversible. That
 * asymmetry is the whole design.
 *
 * The second failure is warning too easily. A warning that fires on ordinary
 * silence is one people learn to skip, and a warning nobody reads is worse
 * than none, because it looks like coverage.
 */
import { describe, it, expect } from 'vitest';
import { stallWarning, STALL_WARN_AFTER_MS } from '../stallWarning';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('when it says something', () => {
  it('warns once the silence is longer than the window', () => {
    const w = stallWarning({ state: 'running', lastSeenAt: ago(STALL_WARN_AFTER_MS + 60_000) }, NOW);
    expect(w.warn).toBe(true);
    expect(w.quietMinutes).toBe(11);
  });

  it('says how long, because "stalled" without a number is unfalsifiable', () => {
    const w = stallWarning({ state: 'running', lastSeenAt: ago(25 * 60_000) }, NOW);
    expect(w.text).toContain('25 min');
  });

  it('allows that it might be working, rather than asserting a fault', () => {
    /*
     * The sentence is an OBSERVATION. Nothing on this machine can tell a
     * stuck agent from one forty minutes into a hard problem, and phrasing
     * that says otherwise invites somebody to act on a guess.
     */
    const w = stallWarning({ state: 'running', lastSeenAt: ago(40 * 60_000) }, NOW);
    expect(w.text).toMatch(/may be working/i);
  });
});

describe('what it must never say', () => {
  it('never tells anybody to kill, retry or abandon', () => {
    /*
     * THE test. If this module grows a path that ends, abandons or relaunches
     * anything, it has become a different feature - and the sentence is where
     * that change would show first, because instruction precedes action.
     */
    const w = stallWarning({ state: 'running', lastSeenAt: ago(60 * 60_000) }, NOW);
    expect(w.text ?? '').not.toMatch(/kill|terminate|abandon|retry|restart|relaunch/i);
  });

  it('returns no verdict field at all, only an observation', () => {
    // There is deliberately nothing here to branch on except "worth saying".
    const w = stallWarning({ state: 'running', lastSeenAt: ago(60 * 60_000) }, NOW);
    expect(Object.keys(w).sort()).toEqual(['quietMinutes', 'text', 'warn']);
  });
});

describe('when it stays quiet', () => {
  it('says nothing inside the window, because ordinary silence is ordinary', () => {
    // A warning that fires on normal pauses is one people learn to skip.
    expect(stallWarning({ state: 'running', lastSeenAt: ago(60_000) }, NOW).warn).toBe(false);
  });

  it('says nothing exactly at the boundary', () => {
    // Strictly longer than the window, so the edge is not a coin flip.
    expect(stallWarning({ state: 'running', lastSeenAt: ago(STALL_WARN_AFTER_MS) }, NOW).warn).toBe(false);
  });

  it('does not invent silence from a missing timestamp', () => {
    // Warning here fires on every agent whose bookkeeping is merely
    // incomplete, which is most of them on a fresh install.
    expect(stallWarning({ state: 'running' }, NOW).warn).toBe(false);
    expect(stallWarning({ state: 'running', lastSeenAt: 'not a date' }, NOW).warn).toBe(false);
  });

  it('leaves the other states to their own sentences', () => {
    /*
     * A failed agent has already said what happened, a blocked one is waiting
     * on a person by definition, and an unreachable one has its own state and
     * its own words. Warning here too would be the same fact twice in two
     * voices, which teaches a reader to trust neither.
     */
    for (const state of ['failed', 'blocked', 'unverifiable', 'idle'] as const) {
      expect(stallWarning({ state, lastSeenAt: ago(60 * 60_000) }, NOW).warn, `${state} was warned about twice`)
        .toBe(false);
    }
  });
});

describe('the window', () => {
  it('is derived from the heartbeat rather than picked', () => {
    // Five minutes doubled: one missed heartbeat is the earliest a run can
    // honestly look stalled. A number chosen by taste does not survive its
    // first argument.
    expect(STALL_WARN_AFTER_MS).toBe(10 * 60 * 1000);
  });
});
