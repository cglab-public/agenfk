/**
 * @file CGLAB-384 (S8-T1) — what the flow editor shows about a draft flow,
 * computed by the same functions that validate and run it: each step's
 * resolved checks (applicable or not, and which record is missing), the
 * records it produces, the roles with their built-ins, and the catalogue.
 * The browser cannot import core, so both servers serve this to the editor.
 */
import { describe, it, expect } from 'vitest';
import { describeFlowContract } from '../flowContract';
import { CHECK_CATALOGUE, STEP_ROLES } from '../flowChecks';

const step = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: name, name, label: name, order, ...extra });
const tdd = () => [
  step('START', 0, { isAnchor: true }),
  step('SPECS', 1, { role: 'test-authoring' }),
  step('BUILD', 2, { role: 'coding' }),
  step('END', 3, { isAnchor: true, role: 'closing' }),
];

describe('describeFlowContract', () => {
  it('is valid for a well-formed flow, with no errors', () => {
    const c = describeFlowContract(tdd());
    expect(c.valid).toBe(true);
    expect(c.errors).toEqual([]);
  });

  it("lists each step in order with its role, its checks and the records it produces", () => {
    const c = describeFlowContract([...tdd()].reverse());
    expect(c.steps.map(s => s.name)).toEqual(['START', 'SPECS', 'BUILD', 'END']);
    const specs = c.steps[1];
    expect(specs.role).toBe('test-authoring');
    expect(specs.checks.map(k => k.id)).toContain('some-new-test-red');
    expect(specs.produces).toEqual(expect.arrayContaining(['redSet', 'testSurface', 'authoredTests']));
    expect(c.steps[2].checks.find(k => k.id === 'red-set-passes-by-name')).toMatchObject({ applicable: true, source: 'role' });
    expect(c.steps[2].consumes).toEqual(expect.arrayContaining(['redSet', 'authoredTests']));
    expect(c.steps[1].consumes).toEqual([]);
  });

  it("lists entry-baseline on leaving the step before one that judges against its entry results (d26832d6 #10)", () => {
    // Leaving DISCOVERY on marketing-lab was held by entry-baseline, a check the
    // contract never showed: the next step's needs decide what leaving this one takes.
    const c = describeFlowContract(tdd());
    expect(c.steps[0].onLeave.map(k => k.id)).toContain('entry-baseline');
    // A step whose successor reads no entry results carries no such hold.
    expect(c.steps[2].onLeave.map(k => k.id)).not.toContain('entry-baseline');
  });

  it("shows a role built-in that has nothing to check as not applicable, naming the missing record", () => {
    const c = describeFlowContract([step('START', 0, { isAnchor: true }), step('BUILD', 1, { role: 'coding' }), step('END', 2, { isAnchor: true })]);
    expect(c.valid).toBe(true);
    expect(c.steps[1].checks.find(k => k.id === 'red-set-passes-by-name')).toMatchObject({ applicable: false, missing: ['redSet'] });
  });

  it('reports the same errors the server refuses a save with', () => {
    const c = describeFlowContract([step('START', 0, { isAnchor: true }), step('BUILD', 1, { checks: [{ id: 'red-set-passes-by-name' }] }), step('END', 2, { isAnchor: true })]);
    expect(c.valid).toBe(false);
    expect(c.errors.join(' ')).toMatch(/red-set-passes-by-name.*redSet/);
  });

  it('only lists the checks a step itself lists, not the terminal step\'s on the step before it', () => {
    const c = describeFlowContract(tdd());
    expect(c.steps[2].checks.some(k => k.id === 'server-owned-verify')).toBe(false);
    expect(c.steps[3].checks.some(k => k.id === 'server-owned-verify')).toBe(true);
  });

  it("lists, per step, exactly the checks verify runs to leave it (the terminal step's included on the step before)", () => {
    const c = describeFlowContract(tdd());
    const leave = (i: number) => c.steps[i].onLeave.map(k => k.id);
    expect(leave(2)).toEqual(expect.arrayContaining(['red-set-passes-by-name', 'server-owned-verify']));
    expect(c.steps[3].onLeave).toEqual([]);
  });

  it('carries every role with its built-ins, and every catalogue check with its params', () => {
    const c = describeFlowContract(tdd());
    expect(c.roles.map(r => r.id)).toEqual([...STEP_ROLES]);
    expect(c.roles.find(r => r.id === 'review')!.builtins.map(b => b.id)).toEqual(['review-record', 'tests-added-late']); // d26832d6 #21
    expect(c.catalogue.map(k => k.id).sort()).toEqual(Object.keys(CHECK_CATALOGUE).sort());
    const ha = c.catalogue.find(k => k.id === 'human-approval')!;
    expect(ha.params.signature).toMatchObject({ values: ['none', 'passkey'], default: 'none' });
    expect(ha.group).toBe('approvals');
  });

  it('survives garbage without throwing', () => {
    expect(describeFlowContract(undefined as never)).toMatchObject({ valid: true, steps: [] });
    expect(() => describeFlowContract([null, 7, 'x'] as never)).not.toThrow();
  });
});
