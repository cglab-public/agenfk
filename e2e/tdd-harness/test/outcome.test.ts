/**
 * Reading one check's verdict off a card: verify writes the gate's results to
 * the card's lastChecks on a pass and on a refusal alike.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain ESM module, run by node inside the container
import { outcomeOf, verdictOf } from '../driver/cards.mjs';

const card = (results: unknown[], step = 'WORK') => ({ status: step, lastChecks: { step, results } });

describe('outcomeOf', () => {
  it("returns the named check's outcome and detail", () => {
    expect(outcomeOf(card([{ id: 'tree-clean', outcome: 'fail', detail: 'uncommitted changes: M a', blocking: true }]), 'tree-clean'))
      .toEqual({ outcome: 'fail', detail: 'uncommitted changes: M a', blocking: true });
  });
  it('says "absent" when the check did not run, rather than guessing pass', () => {
    expect(outcomeOf(card([{ id: 'suite-green', outcome: 'pass', detail: 'x', blocking: false }]), 'tree-clean').outcome).toBe('absent');
    expect(outcomeOf({ status: 'WORK' }, 'tree-clean').outcome).toBe('absent');
  });
  it('reports an overridden check as overridden, not as a pass', () => {
    const r = outcomeOf(card([{ id: 'jira-key-valid', outcome: 'fail', detail: 'no key', blocking: false, overridden: { reason: 'spike' } }]), 'jira-key-valid');
    expect(r.outcome).toBe('overridden');
  });
  it('reads only the checks of the step asked about, when given one', () => {
    const c = { status: 'NEXT', lastChecks: { step: 'WORK', results: [{ id: 'tree-clean', outcome: 'pass', detail: '', blocking: false }] } };
    expect(outcomeOf(c, 'tree-clean', 'NEXT').outcome).toBe('absent');
    expect(outcomeOf(c, 'tree-clean', 'WORK').outcome).toBe('pass');
  });
});

/**
 * What a scenario compares: the verdict AND what it did to the card. A warning
 * lets the card move; a blocking verdict holds it; a block that let the card
 * move anyway is its own outcome, never an expected one.
 */
describe('verdictOf', () => {
  it('passes a pass through', () => {
    expect(verdictOf({ outcome: 'pass', blocking: false }, true)).toBe('pass');
  });
  it('a blocking fail or unavailable that held the card is fail / unavailable', () => {
    const v = verdictOf;
    expect(v({ outcome: 'fail', blocking: true }, false)).toBe('fail');
    expect(v({ outcome: 'unavailable', blocking: true }, false)).toBe('unavailable');
  });
  it('a non-blocking fail is a warning, a non-blocking unavailable is soft', () => {
    const v = verdictOf;
    expect(v({ outcome: 'fail', blocking: false }, true)).toBe('warn');
    expect(v({ outcome: 'unavailable', blocking: false }, true)).toBe('unavailable-soft');
  });
  it('a blocking verdict whose card moved anyway is named as such', () => {
    const v = verdictOf;
    expect(v({ outcome: 'fail', blocking: true }, true)).toBe('fail-but-moved');
    expect(v({ outcome: 'unavailable', blocking: true }, true)).toBe('unavailable-but-moved');
  });
  it('keeps absent, n/a, deferred and overridden as they are', () => {
    const v = verdictOf;
    for (const o of ['absent', 'n/a', 'deferred', 'overridden']) expect(v({ outcome: o, blocking: false }, true)).toBe(o);
  });
});
