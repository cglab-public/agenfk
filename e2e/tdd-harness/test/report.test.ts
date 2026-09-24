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
