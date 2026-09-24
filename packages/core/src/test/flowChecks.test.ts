/**
 * @file CGLAB-380 (S4-T1) — step roles, the check catalogue, check resolution
 * and flow save-time validation.
 *
 * Nothing here may reference a step by NAME: a role says what a step is, and
 * checks pass state to later steps through named records. The same catalogue
 * therefore has to give the TDD flow its red-set checks and give the default
 * flow none, purely because no step there produces a red set.
 */
import { describe, it, expect } from 'vitest';
import {
  CHECK_CATALOGUE,
  ROLE_BUILTINS,
  STEP_ROLES,
  flowChecksErrors,
  hasStepContracts,
  mergeStepContracts,
  resolveStepChecks,
} from '../flowChecks';
import { FLOW_STEP_FIELDS, normalizeFlowSteps } from '../utils';

const step = (name: string, order: number, extra: Record<string, unknown> = {}) =>
  ({ id: `id-${name}`, name, label: name, order, ...extra }) as any;

/** TDD-shaped: roles only, no extras. Names are deliberately not the shipped ones. */
const tdd = () => [
  step('START', 0, { isAnchor: true }),
  step('ASK', 1, { role: 'planning' }),
  step('WRITE_SPECS', 2, { role: 'test-authoring' }),
  step('BUILD', 3, { role: 'coding' }),
  step('TIDY', 4, { role: 'refactoring' }),
  step('LOOK', 5, { role: 'review' }),
  step('FINISHED', 6, { isAnchor: true, role: 'closing' }),
];

/** Default-shaped: no step writes tests first. */
const plain = () => [
  step('TODO', 0, { isAnchor: true }),
  step('IN_PROGRESS', 1, { role: 'coding' }),
  step('REVIEW', 2, { role: 'review' }),
  step('TEST', 3, { role: 'testing' }),
  step('DONE', 4, { isAnchor: true, role: 'closing' }),
];

const ids = (checks: Array<{ id: string }>) => checks.map(c => c.id);
const applicable = (checks: Array<{ id: string; applicable: boolean }>) => checks.filter(c => c.applicable).map(c => c.id);

describe('the catalogue', () => {
  it('describes every check it lists, in words a person can read', () => {
    for (const [id, def] of Object.entries(CHECK_CATALOGUE)) {
      expect(def.id).toBe(id);
      expect(def.description.length, id).toBeGreaterThan(10);
      expect(['block', 'warn']).toContain(def.defaultSeverity);
    }
  });

  it('holds the whole library the story names', () => {
    for (const id of [
      'tree-clean', 'on-card-branch', 'jira-key-valid', 'has-children', 'only-test-files-changed',
      'no-broken-test-files', 'new-tests-exist', 'some-new-test-red', 'new-tests-born-green',
      'red-is-assertion', 'existing-tests-still-green', 'suite-green', 'red-set-passes-by-name',
      'test-surface-frozen', 'test-count-not-lower', 'test-set-identical', 'review-record',
      'human-approval', 'server-owned-verify',
    ]) expect(CHECK_CATALOGUE[id], id).toBeDefined();
  });

  it('extends the gatekeeper role vocabulary rather than inventing a second one', () => {
    for (const r of ['planning', 'coding', 'review', 'testing', 'closing']) expect(STEP_ROLES).toContain(r);
  });

  it('has born-green and red-is-assertion warn by default: the simulation showed an honest stub can pass a new test', () => {
    expect(CHECK_CATALOGUE['new-tests-born-green'].defaultSeverity).toBe('warn');
    expect(CHECK_CATALOGUE['red-is-assertion'].defaultSeverity).toBe('warn');
    expect(CHECK_CATALOGUE['some-new-test-red'].defaultSeverity).toBe('block');
  });

  it('gives every role a built-in list, even an empty one', () => {
    for (const r of STEP_ROLES) expect(Array.isArray(ROLE_BUILTINS[r]), r).toBe(true);
  });
});

describe('resolveStepChecks', () => {
  it('a test-authoring step brings the red-set checks, whatever it is called', () => {
    const got = resolveStepChecks(tdd(), 'WRITE_SPECS');
    expect(applicable(got)).toEqual(expect.arrayContaining([
      'only-test-files-changed', 'no-broken-test-files', 'new-tests-exist', 'some-new-test-red', 'existing-tests-still-green',
    ]));
    expect(got.find(c => c.id === 'new-tests-born-green')?.severity).toBe('warn');
    expect(got.find(c => c.id === 'some-new-test-red')?.source).toBe('role');
  });

  it('a coding step after test-authoring must turn the red set green, by name, with the surface frozen', () => {
    const got = resolveStepChecks(tdd(), 'BUILD');
    expect(applicable(got)).toEqual(expect.arrayContaining(['suite-green', 'red-set-passes-by-name', 'test-surface-frozen', 'test-count-not-lower']));
  });

  it('the SAME coding role on the default flow gets no red-set checks: nothing earlier produces a red set', () => {
    const got = resolveStepChecks(plain(), 'IN_PROGRESS');
    expect(applicable(got)).toContain('suite-green');
    expect(applicable(got)).not.toContain('red-set-passes-by-name');
    expect(applicable(got)).not.toContain('test-surface-frozen');
    const redSet = got.find(c => c.id === 'red-set-passes-by-name');
    expect(redSet?.applicable).toBe(false);
    expect(redSet?.missing).toEqual(['redSet']);
  });

  it('only the first step checks the tree is clean; every step checks the branch', () => {
    expect(ids(resolveStepChecks(tdd(), 'START'))).toEqual(expect.arrayContaining(['tree-clean', 'on-card-branch']));
    expect(ids(resolveStepChecks(tdd(), 'BUILD'))).toContain('on-card-branch');
    expect(ids(resolveStepChecks(tdd(), 'BUILD'))).not.toContain('tree-clean');
  });

  it('checks on the terminal step run on the move INTO it, with the step before it', () => {
    const got = resolveStepChecks(tdd(), 'LOOK');
    expect(ids(got)).toContain('server-owned-verify');
  });

  it('a flow ADDS checks to a step; it cannot take a role built-in away', () => {
    const steps = tdd();
    steps[3].checks = [{ id: 'jira-key-valid' }];
    const got = resolveStepChecks(steps, 'BUILD');
    expect(got.find(c => c.id === 'jira-key-valid')?.source).toBe('flow');
    expect(applicable(got)).toContain('red-set-passes-by-name');
  });

  it('a flow extra marked warn does not soften a built-in with the same id: both run', () => {
    const steps = tdd();
    steps[3].checks = [{ id: 'suite-green', severity: 'warn' }];
    const suite = resolveStepChecks(steps, 'BUILD').filter(c => c.id === 'suite-green');
    expect(suite.map(c => c.severity)).toContain('block');
  });

  it('role-less flows get the universal checks as warnings only, so an upgrade never starts blocking cards', () => {
    const old = [step('TODO', 0, { isAnchor: true }), step('IN_PROGRESS', 1), step('DONE', 2, { isAnchor: true })];
    const got = resolveStepChecks(old, 'TODO');
    expect(got.find(c => c.id === 'tree-clean')?.severity).toBe('warn');
    expect(got.find(c => c.id === 'on-card-branch')?.severity).toBe('warn');
  });

  it('once any step has a role, the universal checks block', () => {
    expect(resolveStepChecks(tdd(), 'START').find(c => c.id === 'tree-clean')?.severity).toBe('block');
  });

  it('a strict freeze measured from step entry needs no earlier producer', () => {
    const steps = plain();
    steps[1].checks = [{ id: 'test-surface-frozen', params: { mode: 'strict', since: 'step-entry' } }];
    const frozen = resolveStepChecks(steps, 'IN_PROGRESS').filter(c => c.id === 'test-surface-frozen' && c.source === 'flow');
    expect(frozen[0].applicable).toBe(true);
    expect(frozen[0].params).toEqual({ mode: 'strict', since: 'step-entry' });
  });

  it('fills a check\'s default params', () => {
    const frozen = resolveStepChecks(tdd(), 'BUILD').find(c => c.id === 'test-surface-frozen');
    expect(frozen?.params).toEqual({ mode: 'append', since: 'test-authoring' });
  });

  it('an unknown step resolves to nothing', () => {
    expect(resolveStepChecks(tdd(), 'NOPE')).toEqual([]);
  });
});

describe('flowChecksErrors (save-time validation)', () => {
  it('accepts the TDD-shaped and default-shaped flows, and a flow with no roles at all', () => {
    expect(flowChecksErrors(tdd())).toEqual([]);
    expect(flowChecksErrors(plain())).toEqual([]);
    expect(flowChecksErrors([step('TODO', 0, { isAnchor: true }), step('DONE', 1, { isAnchor: true })])).toEqual([]);
  });

  it('refuses an unknown check id, naming it and the step', () => {
    const steps = tdd();
    steps[3].checks = [{ id: 'tests-look-fine' }];
    const errs = flowChecksErrors(steps);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/tests-look-fine/);
    expect(errs[0]).toMatch(/BUILD/);
  });

  it('refuses an unknown role', () => {
    const steps = tdd();
    steps[2].role = 'vibes';
    expect(flowChecksErrors(steps).join('\n')).toMatch(/vibes/);
  });

  it('refuses a check whose record no EARLIER step produces, naming the check, the record and who produces it', () => {
    const steps = plain();
    steps[1].checks = [{ id: 'red-set-passes-by-name' }];
    const errs = flowChecksErrors(steps);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/red-set-passes-by-name/);
    expect(errs[0]).toMatch(/redSet/);
    expect(errs[0]).toMatch(/some-new-test-red/);
  });

  it('a producer on the SAME step or a later one does not count', () => {
    const steps = tdd();
    // Swap: coding before test-authoring.
    steps[2].role = 'coding';
    steps[3].role = 'test-authoring';
    steps[2].checks = [{ id: 'red-set-passes-by-name' }];
    expect(flowChecksErrors(steps).join('\n')).toMatch(/redSet/);
  });

  it('refuses bad params and bad severities', () => {
    const steps = tdd();
    steps[3].checks = [{ id: 'test-surface-frozen', params: { mode: 'loose' } }];
    expect(flowChecksErrors(steps).join('\n')).toMatch(/mode/);
    steps[3].checks = [{ id: 'test-surface-frozen', params: { colour: 'red' } }];
    expect(flowChecksErrors(steps).join('\n')).toMatch(/colour/);
    steps[3].checks = [{ id: 'suite-green', severity: 'maybe' }];
    expect(flowChecksErrors(steps).join('\n')).toMatch(/severity/);
  });

  it('refuses checks that are not available on this server yet, saying why, so they can never pass by accident', () => {
    for (const id of ['human-approval']) { // review-record became available with CGLAB-381
      const steps = tdd();
      steps[5].checks = [{ id }];
      const errs = flowChecksErrors(steps);
      expect(errs.join('\n'), id).toMatch(new RegExp(id));
      expect(errs.join('\n'), id).toMatch(/not available/);
    }
  });

  it('refuses checks that are not an array of objects', () => {
    const steps = tdd();
    steps[3].checks = 'suite-green';
    expect(flowChecksErrors(steps).length).toBeGreaterThan(0);
    steps[3].checks = ['suite-green'];
    expect(flowChecksErrors(steps).length).toBeGreaterThan(0);
  });

  it('refuses server-owned-verify or the closing role on a step whose exit does not end the flow: nothing would run it', () => {
    const steps = tdd();
    steps[5].checks = [{ id: 'server-owned-verify' }];
    expect(flowChecksErrors(steps)).toEqual([]); // LOOK -> FINISHED ends the flow
    const mid = tdd();
    mid[4].checks = [{ id: 'server-owned-verify' }];
    expect(flowChecksErrors(mid).join('\n')).toMatch(/TIDY.*server-owned-verify/);
    const role = tdd();
    role[3].role = 'closing';
    expect(flowChecksErrors(role).join('\n')).toMatch(/BUILD.*closing/);
  });

  it('treats null role and null checks as "none"', () => {
    const steps = plain();
    steps[1].role = null;
    steps[1].checks = null;
    expect(flowChecksErrors(steps)).toEqual([]);
  });
});

describe('persistence helpers', () => {
  it('the step whitelist now carries role and checks', () => {
    expect(FLOW_STEP_FIELDS).toContain('role');
    expect(FLOW_STEP_FIELDS).toContain('checks');
    const [out] = normalizeFlowSteps([{ id: 'a', name: 'X', label: 'X', order: 1, role: 'coding', checks: [{ id: 'suite-green' }] }], () => 'n');
    expect(out.role).toBe('coding');
    expect(out.checks).toEqual([{ id: 'suite-green' }]);
  });

  it('hasStepContracts is true once any step has a role or a check', () => {
    expect(hasStepContracts(tdd())).toBe(true);
    expect(hasStepContracts([step('A', 0), step('B', 1)])).toBe(false);
    expect(hasStepContracts([step('A', 0, { checks: [{ id: 'suite-green' }] })])).toBe(true);
  });

  describe('mergeStepContracts: absent is not clear', () => {
    const stored = () => [
      step('A', 0, { role: 'coding', checks: [{ id: 'jira-key-valid' }] }),
      step('B', 1, { role: 'review' }),
    ];

    it('a step that omits role/checks keeps the stored values (an older editor never wipes them)', () => {
      const incoming = [{ id: 'id-A', name: 'A', label: 'A2', order: 0 }, { id: 'id-B', name: 'B', label: 'B', order: 1 }];
      const merged = mergeStepContracts(incoming, stored());
      expect(merged[0].label).toBe('A2');
      expect(merged[0].role).toBe('coding');
      expect(merged[0].checks).toEqual([{ id: 'jira-key-valid' }]);
      expect(merged[1].role).toBe('review');
    });

    it('an explicit null or [] clears', () => {
      const incoming = [{ id: 'id-A', name: 'A', label: 'A', order: 0, role: null, checks: [] }];
      const merged = mergeStepContracts(incoming, stored());
      expect(merged[0].role).toBeUndefined();
      expect(merged[0].checks ?? []).toEqual([]);
    });

    it('a step with a new id starts empty', () => {
      const incoming = [{ id: 'fresh', name: 'A', label: 'A', order: 0 }];
      const merged = mergeStepContracts(incoming, stored());
      expect(merged[0].role).toBeUndefined();
      expect(merged[0].checks).toBeUndefined();
    });

    it('an explicit value replaces', () => {
      const incoming = [{ id: 'id-A', name: 'A', label: 'A', order: 0, role: 'testing' }];
      expect(mergeStepContracts(incoming, stored())[0].role).toBe('testing');
    });
  });
});
