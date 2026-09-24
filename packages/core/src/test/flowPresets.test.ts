/**
 * @file CGLAB-381 (S5-T4) — the shipped flows carry roles.
 *
 * DEFAULT_FLOW is enforced (user decision 2026-09-23): coding, review,
 * testing, closing. The TDD preset gives the TDD flow its roles. Both must
 * pass the same save-time validation a user's flow does, and the same check
 * library must give each only the checks its steps can support.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_FLOW } from '../defaultFlow';
import { TDD_FLOW_PRESET } from '../flowPresets';
import { flowChecksErrors, resolveStepChecks } from '../flowChecks';

const applicable = (steps: any[], name: string) => resolveStepChecks(steps, name).filter(c => c.applicable).map(c => c.id);
const roleOf = (steps: any[], name: string) => steps.find(s => s.name === name)?.role;

describe('DEFAULT_FLOW roles', () => {
  it('assigns coding, review, testing and closing', () => {
    expect(roleOf(DEFAULT_FLOW.steps, 'IN_PROGRESS')).toBe('coding');
    expect(roleOf(DEFAULT_FLOW.steps, 'REVIEW')).toBe('review');
    expect(roleOf(DEFAULT_FLOW.steps, 'TEST')).toBe('testing');
    expect(roleOf(DEFAULT_FLOW.steps, 'DONE')).toBe('closing');
  });

  it('passes save-time validation', () => {
    expect(flowChecksErrors(DEFAULT_FLOW.steps)).toEqual([]);
  });

  it('asks only for a green suite when implementing: no step writes tests first, so red-set checks do not apply', () => {
    const got = applicable(DEFAULT_FLOW.steps, 'IN_PROGRESS');
    expect(got).toContain('suite-green');
    expect(got).not.toContain('red-set-passes-by-name');
    expect(got).not.toContain('test-surface-frozen');
  });

  it('requires an independent review to leave REVIEW, and the verify command to finish', () => {
    expect(applicable(DEFAULT_FLOW.steps, 'REVIEW')).toContain('review-record');
    expect(applicable(DEFAULT_FLOW.steps, 'TEST')).toEqual(expect.arrayContaining(['suite-green', 'server-owned-verify']));
  });
});

describe('TDD_FLOW_PRESET', () => {
  it('passes save-time validation', () => {
    expect(flowChecksErrors(TDD_FLOW_PRESET.steps)).toEqual([]);
  });

  it('keeps the TDD flow\'s steps, in order', () => {
    expect(TDD_FLOW_PRESET.steps.map(s => s.name)).toEqual(['TODO', 'DISCOVERY', 'CREATE_UNIT_TESTS', 'IN_PROGRESS', 'REFACTOR', 'REVIEW', 'DONE']);
  });

  it('gives each step its role', () => {
    expect(TDD_FLOW_PRESET.steps.map(s => s.role ?? null)).toEqual([null, 'planning', 'test-authoring', 'coding', 'refactoring', 'review', 'closing']);
  });

  it('adds jira-key-valid and has-children to discovery', () => {
    expect(applicable(TDD_FLOW_PRESET.steps, 'DISCOVERY')).toEqual(expect.arrayContaining(['jira-key-valid', 'has-children']));
  });

  it('turns the red set green when implementing, and keeps the tests identical when refactoring', () => {
    expect(applicable(TDD_FLOW_PRESET.steps, 'IN_PROGRESS')).toEqual(expect.arrayContaining(['suite-green', 'red-set-passes-by-name', 'test-surface-frozen', 'test-count-not-lower']));
    expect(applicable(TDD_FLOW_PRESET.steps, 'REFACTOR')).toEqual(expect.arrayContaining(['suite-green', 'test-set-identical', 'test-surface-frozen']));
  });
});
