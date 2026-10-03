/**
 * The harness report: what the run says, and the exit code a caller trusts.
 * A mismatch, a scenario that threw, or a run where nothing ran all fail.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain ESM module, run by node inside the container
import { evaluate } from '../driver/report.mjs';

const ok = { scenario: 'tree-clean passes on a clean tree', check: 'tree-clean', expected: 'pass', actual: 'pass', detail: 'clean' };

describe('harness report', () => {
  it('exits 0 when every scenario got the outcome it expected', () => {
    const r = evaluate([ok, { ...ok, scenario: 'tree-clean blocks a dirty tree', expected: 'fail', actual: 'fail' }]);
    expect(r.exitCode).toBe(0);
    expect(r.summary).toMatch(/2 of 2 scenarios as expected/);
  });

  it('exits 1 on a mismatch, naming the scenario, both outcomes and what the check said', () => {
    const r = evaluate([ok, { ...ok, scenario: 'tree-clean blocks a dirty tree', expected: 'fail', actual: 'pass', detail: 'clean' }]);
    expect(r.exitCode).toBe(1);
    const line = r.lines.find((l: string) => l.includes('tree-clean blocks a dirty tree'));
    expect(line).toMatch(/expected fail, got pass/);
    expect(line).toMatch(/clean/);
  });

  it('exits 1 when a scenario threw, with the error', () => {
    const r = evaluate([{ ...ok, actual: 'error', detail: 'ECONNREFUSED' }]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join('\n')).toMatch(/ECONNREFUSED/);
  });

  it('exits 1 when nothing ran: an empty run is a broken harness, not a green one', () => {
    const r = evaluate([]);
    expect(r.exitCode).toBe(1);
    expect(r.summary).toMatch(/no scenarios ran/i);
  });
});

/**
 * T6: the coverage table. For every check in the catalogue, what the run saw
 * it do - counting only scenarios that got what they expected. A check never
 * seen passing, or never seen refusing (fail, warn, unavailable), is a hole
 * in the harness, and the run says so and fails.
 */
describe('coverage', () => {
  const r = (check: string, outcome: string, actual = outcome) => ({ scenario: `${check} ${outcome}`, check, expected: outcome, actual, detail: '' });

  it('lists, per catalogue check, the outcomes seen as expected', () => {
    const out = evaluate([r('tree-clean', 'pass'), r('tree-clean', 'fail'), r('tree-clean', 'unavailable')], { catalogue: ['tree-clean'] });
    expect(out.coverage).toEqual([{ check: 'tree-clean', outcomes: ['fail', 'pass', 'unavailable'] }]);
    expect(out.exitCode).toBe(0);
  });

  it('fails the run for a check never seen passing, or never seen refusing', () => {
    const out = evaluate([r('a', 'pass'), r('b', 'fail'), r('c', 'warn'), r('c', 'pass')], { catalogue: ['a', 'b', 'c', 'd'] });
    expect(out.gaps).toEqual(['a: never seen refusing', 'b: never seen passing', 'd: never exercised']);
    expect(out.exitCode).toBe(1);
    expect(out.lines.join('\n')).toMatch(/d: never exercised/);
  });

  it('does not count a scenario that got the wrong outcome', () => {
    const out = evaluate([r('a', 'pass'), r('a', 'fail', 'pass')], { catalogue: ['a'] });
    expect(out.coverage).toEqual([{ check: 'a', outcomes: ['pass'] }]);
  });

  it('counts overridden and refused as refusing, and ignores rows for things that are not checks', () => {
    const out = evaluate([r('a', 'pass'), r('a', 'refused'), r('override', 'overridden')], { catalogue: ['a'] });
    expect(out.gaps).toEqual([]);
    expect(out.coverage.map((c: any) => c.check)).toEqual(['a']);
  });
});
