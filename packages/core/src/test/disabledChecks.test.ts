/**
 * @file CGLAB-428 — a hub admin switches individual checks off on a step.
 *
 * `disabledChecks` names resolved check ids (a custom check as `<id>:<name>`).
 * A disabled check does not run: resolveStepChecks leaves it out, so every
 * caller - the gate, the capture decision, the approval lookups - agrees, and
 * a disabled producer produces no record. disabledStepChecks lists what was
 * left out, so it can be shown instead of silently vanishing.
 *
 * Only a flow the hub delivered may carry the field: normalizeFlowSteps drops
 * it unless the caller (the hub sync) opts in, so a local, registry-installed
 * or edited flow cannot use it to remove a safeguard.
 */
import { describe, it, expect } from 'vitest';
import { disabledStepChecks, flowChecksErrors, mergeStepContracts, resolveStepChecks } from '../flowChecks';
import { describeFlowContract } from '../flowContract';
import { normalizeFlowSteps } from '../utils';

const step = (name: string, order: number, extra: Record<string, unknown> = {}) =>
  ({ id: `id-${name}`, name, label: name, order, ...extra }) as any;

const tdd = (over: Record<string, Record<string, unknown>> = {}) => [
  step('START', 0, { isAnchor: true, ...over.START }),
  step('ASK', 1, { role: 'planning', ...over.ASK }),
  step('SPECS', 2, { role: 'test-authoring', ...over.SPECS }),
  step('BUILD', 3, { role: 'coding', ...over.BUILD }),
  step('LOOK', 4, { role: 'review', ...over.LOOK }),
  step('END', 5, { isAnchor: true, role: 'closing', ...over.END }),
];

const ids = (checks: Array<{ id: string }>) => checks.map(c => c.id);
let n = 0;
const newId = () => `new-${++n}`;

describe('resolveStepChecks leaves a disabled check out', () => {
  it('drops a role built-in the step disables, and keeps the rest', () => {
    const on = ids(resolveStepChecks(tdd(), 'SPECS'));
    expect(on).toContain('new-tests-born-green');
    const off = ids(resolveStepChecks(tdd({ SPECS: { disabledChecks: ['new-tests-born-green'] } }), 'SPECS'));
    expect(off).not.toContain('new-tests-born-green');
    expect(off).toEqual(on.filter(id => id !== 'new-tests-born-green'));
  });

  it('drops a universal check the step disables', () => {
    expect(ids(resolveStepChecks(tdd(), 'START'))).toEqual(expect.arrayContaining(['tree-clean', 'on-card-branch']));
    const off = ids(resolveStepChecks(tdd({ START: { disabledChecks: ['tree-clean'] } }), 'START'));
    expect(off).not.toContain('tree-clean');
    expect(off).toContain('on-card-branch');
  });

  it("drops a flow's own custom check by its resolved id, leaving a sibling of the same kind", () => {
    const checks = [
      { id: 'command-check', params: { name: 'lint', argv: ['npm', 'run', 'lint'] } },
      { id: 'command-check', params: { name: 'types', argv: ['npm', 'run', 'types'] } },
    ];
    const got = ids(resolveStepChecks(tdd({ BUILD: { checks, disabledChecks: ['command-check:lint'] } }), 'BUILD'));
    expect(got).not.toContain('command-check:lint');
    expect(got).toContain('command-check:types');
  });

  it("a disabled terminal-step check does not run on the move into it", () => {
    expect(ids(resolveStepChecks(tdd(), 'LOOK'))).toContain('server-owned-verify');
    const got = ids(resolveStepChecks(tdd({ END: { disabledChecks: ['server-owned-verify'] } }), 'LOOK'));
    expect(got).not.toContain('server-owned-verify');
    expect(got).toContain('review-record');
  });

  it("a disabled producer produces nothing, so the built-in that needs its record is not applicable", () => {
    const red = (steps: any[]) => resolveStepChecks(steps, 'BUILD').find(c => c.id === 'red-set-passes-by-name');
    expect(red(tdd())?.applicable).toBe(true);
    expect(red(tdd({ SPECS: { disabledChecks: ['some-new-test-red'] } }))?.applicable).toBe(false);
  });

  it('never drops human-approval, even from a flow that skipped validation', () => {
    const steps = tdd({ ASK: { checks: [{ id: 'human-approval' }], disabledChecks: ['human-approval'] } });
    expect(ids(resolveStepChecks(steps, 'ASK'))).toContain('human-approval');
    expect(disabledStepChecks(steps, 'ASK')).toEqual([]);
  });

  it('ignores a disabledChecks that is not a list', () => {
    expect(ids(resolveStepChecks(tdd({ SPECS: { disabledChecks: 'new-tests-born-green' } }), 'SPECS'))).toContain('new-tests-born-green');
  });
});

describe('disabledStepChecks lists what was left out', () => {
  it('names each disabled check on leaving the step, with its source', () => {
    const steps = tdd({ SPECS: { disabledChecks: ['new-tests-born-green', 'on-card-branch'] } });
    const off = disabledStepChecks(steps, 'SPECS');
    expect(ids(off).sort()).toEqual(['new-tests-born-green', 'on-card-branch']);
    expect(off.find(c => c.id === 'new-tests-born-green')).toMatchObject({ source: 'role', step: 'SPECS' });
    expect(off.find(c => c.id === 'on-card-branch')).toMatchObject({ source: 'universal' });
  });

  it('includes the terminal step\'s disabled checks on the step before it', () => {
    expect(ids(disabledStepChecks(tdd({ END: { disabledChecks: ['server-owned-verify'] } }), 'LOOK'))).toEqual(['server-owned-verify']);
  });

  it('is empty when nothing is disabled, and for a step the flow does not have', () => {
    expect(disabledStepChecks(tdd(), 'SPECS')).toEqual([]);
    expect(disabledStepChecks(tdd({ SPECS: { disabledChecks: ['new-tests-born-green'] } }), 'NOPE')).toEqual([]);
  });

  it('together with resolveStepChecks accounts for every check the step would otherwise run', () => {
    const full = ids(resolveStepChecks(tdd(), 'BUILD')).sort();
    const steps = tdd({ BUILD: { disabledChecks: ['suite-green', 'on-card-branch'] } });
    expect([...ids(resolveStepChecks(steps, 'BUILD')), ...ids(disabledStepChecks(steps, 'BUILD'))].sort()).toEqual(full);
  });
});

describe('flowChecksErrors validates disabledChecks', () => {
  it('accepts a list of checks the step runs', () => {
    expect(flowChecksErrors(tdd({ SPECS: { disabledChecks: ['new-tests-born-green', 'on-card-branch'] } }))).toEqual([]);
  });

  it('refuses human-approval: that gate is switched by its own setting, never here', () => {
    const steps = tdd({ ASK: { checks: [{ id: 'human-approval' }], disabledChecks: ['human-approval'] } });
    const errors = flowChecksErrors(steps);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Step ASK/);
    expect(errors[0]).toMatch(/human-approval/);
  });

  it('refuses a check the step does not run, naming it', () => {
    const errors = flowChecksErrors(tdd({ ASK: { disabledChecks: ['suite-green'] } }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Step ASK/);
    expect(errors[0]).toMatch(/suite-green/);
  });

  it('refuses an unknown check id', () => {
    const errors = flowChecksErrors(tdd({ SPECS: { disabledChecks: ['no-such-check'] } }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/no-such-check/);
  });

  it('refuses tree-clean on a step other than the first, where it never runs', () => {
    expect(flowChecksErrors(tdd({ SPECS: { disabledChecks: ['tree-clean'] } }))).toHaveLength(1);
  });

  it('refuses a disabledChecks that is not a list of strings', () => {
    expect(flowChecksErrors(tdd({ SPECS: { disabledChecks: 'new-tests-born-green' } }))).toHaveLength(1);
    expect(flowChecksErrors(tdd({ SPECS: { disabledChecks: [42] } }))).toHaveLength(1);
  });

  it("refuses a flow extra that needs the record a disabled producer no longer makes", () => {
    const steps = tdd({
      SPECS: { disabledChecks: ['some-new-test-red'] },
      BUILD: { checks: [{ id: 'red-set-passes-by-name' }] },
    });
    expect(flowChecksErrors(steps).some(e => /BUILD/.test(e) && /redSet/.test(e))).toBe(true);
  });
});

describe('only the hub sync may store disabledChecks', () => {
  it('normalizeFlowSteps drops it by default', () => {
    const [s] = normalizeFlowSteps([step('SPECS', 1, { role: 'test-authoring', disabledChecks: ['new-tests-born-green'] })], newId);
    expect(s).not.toHaveProperty('disabledChecks');
    expect(s.role).toBe('test-authoring');
  });

  it('normalizeFlowSteps keeps it when the caller opts in', () => {
    const [s] = normalizeFlowSteps([step('SPECS', 1, { role: 'test-authoring', disabledChecks: ['new-tests-born-green'] })], newId, { allowDisabledChecks: true });
    expect(s.disabledChecks).toEqual(['new-tests-born-green']);
  });
});

describe('mergeStepContracts keeps disabledChecks the way it keeps checks', () => {
  const stored = [step('SPECS', 1, { role: 'test-authoring', disabledChecks: ['new-tests-born-green'] })];

  it('an update that omits it keeps the stored value', () => {
    const [s] = mergeStepContracts([step('SPECS', 1, { role: 'test-authoring' })], stored);
    expect(s.disabledChecks).toEqual(['new-tests-born-green']);
  });

  it('an empty list or null clears it', () => {
    expect(mergeStepContracts([step('SPECS', 1, { disabledChecks: [] })], stored)[0]).not.toHaveProperty('disabledChecks');
    expect(mergeStepContracts([step('SPECS', 1, { disabledChecks: null })], stored)[0]).not.toHaveProperty('disabledChecks');
  });

  it('a new list replaces the stored one', () => {
    expect(mergeStepContracts([step('SPECS', 1, { disabledChecks: ['red-is-assertion'] })], stored)[0].disabledChecks).toEqual(['red-is-assertion']);
  });
});

describe('describeFlowContract shows the disabled checks to the editor', () => {
  it("lists a step's disabled checks and leaves them out of its checks and onLeave", () => {
    const c = describeFlowContract(tdd({ SPECS: { disabledChecks: ['new-tests-born-green'] } }));
    const specs = c.steps.find(s => s.name === 'SPECS')!;
    expect(ids(specs.disabled)).toEqual(['new-tests-born-green']);
    expect(ids(specs.checks)).not.toContain('new-tests-born-green');
    expect(ids(specs.onLeave)).not.toContain('new-tests-born-green');
    expect(c.valid).toBe(true);
  });

  it('gives every step an empty list when nothing is disabled', () => {
    for (const s of describeFlowContract(tdd()).steps) expect(s.disabled).toEqual([]);
  });
});
