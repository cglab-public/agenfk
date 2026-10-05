/**
 * @file CGLAB-388 (S10) — a step can commit the card's work when it leaves.
 * The flags are step fields: stored through the whitelist, kept by an editor
 * that omits them, carried to the registry, and validated at save time.
 */
import { describe, it, expect } from 'vitest';
import { FLOW_STEP_FIELDS, normalizeFlowSteps } from '../utils';
import { flowChecksErrors, mergeStepContracts } from '../flowChecks';
import { stepContractFields } from '../registryFlow';
import { describeFlowContract } from '../flowContract';

const step = (extra: Record<string, unknown>) => ({ id: 'b', name: 'BUILD', label: 'Build', order: 1, ...extra });
const flow = (extra: Record<string, unknown>) => [
  { id: 'a', name: 'TODO', label: 'To Do', order: 0, isAnchor: true }, step(extra),
  { id: 't', name: 'TEST', label: 'Test', order: 2 }, { id: 'c', name: 'DONE', label: 'Done', order: 3, isAnchor: true },
];

describe('step auto commit fields', () => {
  it('are stored through the step whitelist', () => {
    expect(FLOW_STEP_FIELDS).toEqual(expect.arrayContaining(['autoCommit', 'requireCommit']));
    expect(normalizeFlowSteps([step({ autoCommit: true, requireCommit: true })], () => 'new-id')[0]).toMatchObject({ autoCommit: true, requireCommit: true });
  });

  it('are kept when an editor that omits them saves the step', () => {
    const [merged] = mergeStepContracts([step({})], [step({ autoCommit: true, requireCommit: true })]);
    expect(merged).toMatchObject({ autoCommit: true, requireCommit: true });
  });

  it('are cleared by an explicit null', () => {
    const [merged] = mergeStepContracts([step({ autoCommit: null, requireCommit: null })], [step({ autoCommit: true, requireCommit: true })]);
    expect(merged.autoCommit).toBeUndefined();
    expect(merged.requireCommit).toBeUndefined();
  });

  it('travel to the registry with the step', () => {
    expect(stepContractFields({ autoCommit: true, requireCommit: true })).toMatchObject({ autoCommit: true, requireCommit: true });
    expect(stepContractFields({})).toEqual({});
  });

  it('must be booleans, and requiring a commit needs auto commit on', () => {
    expect(flowChecksErrors(flow({ autoCommit: 'yes' })).join(' ')).toMatch(/autoCommit/);
    expect(flowChecksErrors(flow({ requireCommit: true })).join(' ')).toMatch(/requireCommit.*autoCommit|autoCommit.*requireCommit/);
    expect(flowChecksErrors(flow({ autoCommit: true, requireCommit: true }))).toEqual([]);
  });

  it('are refused on the step whose leaving ends the flow, where the close commit takes the work (S10 review)', () => {
    const last = [{ id: 'a', name: 'TODO', label: 'To Do', order: 0, isAnchor: true }, step({ autoCommit: true }), { id: 'c', name: 'DONE', label: 'Done', order: 2, isAnchor: true }];
    expect(flowChecksErrors(last).join(' ')).toMatch(/BUILD: auto commit has no effect here/);
    expect(flowChecksErrors(flow({ autoCommit: true }))).toEqual([]);
  });

  it('refuses them where the next step is DONE even with a special step after it (review)', () => {
    const f = [{ id: 'a', name: 'TODO', label: 'To Do', order: 0, isAnchor: true }, step({ autoCommit: true }),
      { id: 'c', name: 'DONE', label: 'Done', order: 2, isAnchor: true }, { id: 'x', name: 'ARCHIVED', label: 'Archived', order: 3, isSpecial: true }];
    expect(flowChecksErrors(f).join(' ')).toMatch(/BUILD: auto commit has no effect here/);
  });
  it('the flow contract says which steps commit on leave', () => {
    const c = describeFlowContract(flow({ autoCommit: true, requireCommit: true }));
    expect(c.steps.find(x => x.name === 'BUILD')!.commitsOnLeave).toBe('required');
    expect(c.steps.find(x => x.name === 'TEST')!.commitsOnLeave).toBeNull();
  });
});

