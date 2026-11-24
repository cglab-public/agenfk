/**
 * @file GH-392 — the no-nonfunctional-comments check in the catalogue: a
 * blocking check a flow adds to a step, never switched on by a role or the
 * shipped flows.
 */
import { describe, it, expect } from 'vitest';
import { CHECK_CATALOGUE, ROLE_BUILTINS, STEP_ROLES, flowChecksErrors, resolveStepChecks, disabledStepChecks } from '../flowChecks';
import { DEFAULT_FLOW, TDD_FLOW_PRESET } from '../index';

const ID = 'no-nonfunctional-comments';
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: name, name, order, ...extra });
const steps = (check: Record<string, unknown>, extra: Record<string, unknown> = {}) => [
  s('START', 0, { isAnchor: true }),
  s('WORK', 1, { role: 'coding', checks: [check], ...extra }),
  s('END', 2, { isAnchor: true }),
];

describe('no-nonfunctional-comments in the catalogue', () => {
  it('is a blocking code check that needs no test run', () => {
    const d = CHECK_CATALOGUE[ID];
    expect(d).toBeDefined();
    expect(d.defaultSeverity).toBe('block');
    expect(d.group).toBe('code');
    expect(d.needsCapture).toBe(false);
    expect(d.description).toMatch(/comment/i);
  });

  it('is no role built-in and is not on in the shipped flows', () => {
    for (const r of STEP_ROLES) expect(ROLE_BUILTINS[r].map(c => c.id), r).not.toContain(ID);
    for (const f of [DEFAULT_FLOW, TDD_FLOW_PRESET]) {
      for (const st of f.steps as any[]) expect((st.checks ?? []).map((c: any) => c.id), st.name).not.toContain(ID);
    }
  });

  it('is accepted on a step, blocking by default and warning when the flow says so', () => {
    expect(flowChecksErrors(steps({ id: ID }))).toEqual([]);
    expect(flowChecksErrors(steps({ id: ID, severity: 'warn' }))).toEqual([]);
    expect(resolveStepChecks(steps({ id: ID }), 'WORK').find(c => c.id === ID)).toMatchObject({ severity: 'block', source: 'flow', applicable: true });
    expect(resolveStepChecks(steps({ id: ID, severity: 'warn' }), 'WORK').find(c => c.id === ID)).toMatchObject({ severity: 'warn' });
  });

  it('can be switched off by the hub on a step that runs it, and only there', () => {
    expect(flowChecksErrors(steps({ id: ID }, { disabledChecks: [ID] }))).toEqual([]);
    expect(disabledStepChecks(steps({ id: ID }, { disabledChecks: [ID] }), 'WORK').map(c => c.id)).toContain(ID);
    const errs = flowChecksErrors([s('START', 0, { isAnchor: true }), s('WORK', 1, { role: 'coding', disabledChecks: [ID] }), s('END', 2, { isAnchor: true })]);
    expect(errs.join('\n')).toMatch(/does not run/);
  });

  it('takes no params', () => {
    expect(flowChecksErrors(steps({ id: ID, params: { mode: 'x' } })).join('\n')).toMatch(/has no param 'mode'/);
  });
});
