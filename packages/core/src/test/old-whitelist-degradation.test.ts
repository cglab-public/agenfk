/**
 * @file CGLAB-385 (S9-T2) — graceful degradation: an OLDER server strips the
 * step fields it does not know (its whitelist is v1.1.20's, without role and
 * checks). A flow with a contract that passes through it must then run
 * exactly as flows did before contracts existed: no contract, no errors, and
 * only the universal checks, as warnings.
 */
import { describe, it, expect } from 'vitest';
import { TDD_FLOW_PRESET, flowChecksErrors, hasStepContracts, resolveStepChecks } from '../index';

/** v1.1.20's FLOW_STEP_FIELDS, read from the tag. */
const OLD_FLOW_STEP_FIELDS = ['id', 'name', 'label', 'order', 'exitCriteria', 'color', 'icon', 'isAnchor', 'isSpecial'] as const;
const throughOldServer = (steps: any[]) => steps.map(s => Object.fromEntries(OLD_FLOW_STEP_FIELDS.filter(k => s[k] !== undefined).map(k => [k, s[k]])));

describe('a contract flow through an older server', () => {
  const stripped = throughOldServer(TDD_FLOW_PRESET.steps as any[]);

  it('loses the contract fields and nothing else', () => {
    expect(stripped.some(s => 'role' in s || 'checks' in s)).toBe(false);
    expect(stripped.map(s => s.name)).toEqual(TDD_FLOW_PRESET.steps.map(s => s.name));
  });

  it('has no contract and no save-time errors', () => {
    expect(hasStepContracts(stripped)).toBe(false);
    expect(flowChecksErrors(stripped)).toEqual([]);
  });

  it('runs only the universal checks, as warnings, on every step', () => {
    for (const s of stripped) {
      const checks = resolveStepChecks(stripped, s.name);
      expect(checks.every(c => c.source === 'universal' && c.severity === 'warn'), s.name).toBe(true);
    }
  });
});
