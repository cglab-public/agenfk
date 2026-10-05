/**
 * @file CGLAB-457 (T3) — a flow whose words ask for more than its checks enforce.
 *
 * A step's exit criteria are prose the agent honours; its role and checks are
 * what the server enforces. A flow can ask for an independent review, or a
 * person's go-ahead, in prose alone - the hub-delivered TDD Flow 1.0.0 did
 * both, with no role on any step but DONE - and nothing said so: every card
 * passed REVIEW and DISCOVERY on the agent's word. These warnings say so. They
 * never refuse a flow and never switch anything on: the fix is the flow
 * owner's (give the step its role), and a check the org's hub switched off is
 * the org's decision, not a gap.
 */
import { describe, it, expect } from 'vitest';
import { flowContractWarnings } from '../flowChecks';
import { describeFlowContract } from '../flowContract';
import { TDD_FLOW_PRESET } from '../flowPresets';
import { DEFAULT_FLOW } from '../defaultFlow';

const step = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: name, name, label: name, order, ...extra });

/** The TDD preset as the hub delivered it: the same words, no roles or checks but the closing anchor's. */
const rolelessTdd = () => TDD_FLOW_PRESET.steps.map((s: any) => {
  const { role, checks, ...rest } = s;
  return s.name === 'DONE' ? { ...rest, role } : rest;
});

describe('flowContractWarnings', () => {
  it('has nothing to say about the shipped flows', () => {
    expect(flowContractWarnings(TDD_FLOW_PRESET.steps as any)).toEqual([]);
    expect(flowContractWarnings(DEFAULT_FLOW.steps as any)).toEqual([]);
  });

  it('names the review and the approval the roleless TDD flow asks for and does not check', () => {
    const ws = flowContractWarnings(rolelessTdd());
    expect(ws.map(w => [w.step, w.kind])).toEqual([['DISCOVERY', 'approval'], ['REVIEW', 'review']]);
    const review = ws.find(w => w.kind === 'review')!;
    expect(review.message).toMatch(/REVIEW/);
    expect(review.message).toMatch(/role 'review'/);
    const approval = ws.find(w => w.kind === 'approval')!;
    expect(approval.message).toMatch(/DISCOVERY/);
    expect(approval.message).toMatch(/human-approval/);
  });

  it('reads a step named for review as one, whatever its criteria say', () => {
    const ws = flowContractWarnings([step('START', 0, { isAnchor: true }), step('CODE_REVIEW', 1), step('END', 2, { isAnchor: true, role: 'closing' })]);
    expect(ws).toEqual([expect.objectContaining({ step: 'CODE_REVIEW', kind: 'review' })]);
  });

  it('takes a review-record check the flow lists as enforcement, without the role', () => {
    const ws = flowContractWarnings([step('START', 0, { isAnchor: true }), step('REVIEW', 1, { checks: [{ id: 'review-record' }] }), step('END', 2, { isAnchor: true, role: 'closing' })]);
    expect(ws).toEqual([]);
  });

  it("is quiet about a check the org's hub switched off: that is the org's decision", () => {
    const ws = flowContractWarnings([
      step('START', 0, { isAnchor: true }),
      step('REVIEW', 1, { role: 'review', disabledChecks: ['review-record'] }),
      step('APPROVE', 2, { exitCriteria: 'The user must give you the go-ahead.', checks: [{ id: 'human-approval' }] }),
      step('END', 3, { isAnchor: true, role: 'closing' }),
    ]);
    expect(ws).toEqual([]);
  });

  it('does not read a self-review in a coding step as a request for an independent one', () => {
    const ws = flowContractWarnings([
      step('START', 0, { isAnchor: true }),
      step('BUILD', 1, { role: 'coding', exitCriteria: 'Implement it, then review your own diff before advancing.' }),
      step('END', 2, { isAnchor: true, role: 'closing' }),
    ]);
    expect(ws).toEqual([]);
  });

  it('does not read other uses of "agent", "separate" or "peer" as a request for a review (review finding)', () => {
    const crit = (exitCriteria: string) => flowContractWarnings([step('START', 0, { isAnchor: true }), step('BUILD', 1, { role: 'coding', exitCriteria }), step('END', 2, { isAnchor: true, role: 'closing' })]);
    expect(crit('Do not touch files outside your scope, or another agent loses its edit.')).toEqual([]);
    expect(crit('Spawn a separate agent per task to implement in parallel.')).toEqual([]);
    expect(crit('Install peer dependencies so the agent can build.')).toEqual([]);
    expect(crit('Have the change reviewed by an independent reviewer.')).toEqual([expect.objectContaining({ kind: 'review' })]);
  });

  it('tells a step that has another role to add the check, not to swap its role', () => {
    const ws = flowContractWarnings([step('START', 0, { isAnchor: true }), step('BUILD', 1, { role: 'coding', exitCriteria: 'Get an independent review of the diff.' }), step('END', 2, { isAnchor: true, role: 'closing' })]);
    expect(ws[0].message).toMatch(/add the review-record check/);
    expect(ws[0].message).not.toMatch(/Give the step role 'review'/);
  });

  it('does not read PREVIEW as a review step, nor a negated or hyphenated approval as asking for one', () => {
    const ws = flowContractWarnings([
      step('START', 0, { isAnchor: true }),
      step('PREVIEW', 1, { role: 'coding', exitCriteria: 'No human approval is needed for this step. The developer-approved style guide applies.' }),
      step('END', 2, { isAnchor: true, role: 'closing' }),
    ]);
    expect(ws).toEqual([]);
  });

  it('reads a demand for a go-ahead as one, negated wording included (second review)', () => {
    const crit = (exitCriteria: string) => flowContractWarnings([step('START', 0, { isAnchor: true }), step('SHIP', 1, { role: 'coding', exitCriteria }), step('END', 2, { isAnchor: true, role: 'closing' })]);
    for (const asks of ['Ask a human to sign off before merging.', 'Do not move forward until the user gives the go-ahead.', 'Never start coding before the user approves the plan.',
      "Do not merge without the user's approval.", 'Never proceed without a human sign-off.', 'The user must approve; no further approval is needed after that.']) {
      expect(crit(asks), asks).toEqual([expect.objectContaining({ step: 'SHIP', kind: 'approval' })]);
    }
    for (const denies of ['Approval is not required here.', 'Merge without waiting for approval.', 'Ask the user to confirm the JIRA key.']) {
      expect(crit(denies), denies).toEqual([]);
    }
  });

  it("reads 'review ... in a separate agent' as an independent review, and 'a separate test step' as none (second review)", () => {
    const crit = (exitCriteria: string) => flowContractWarnings([step('START', 0, { isAnchor: true }), step('CHECK', 1, { role: 'coding', exitCriteria }), step('END', 2, { isAnchor: true, role: 'closing' })]);
    expect(crit('Review the code in a separate adversarial general purpose agent.')).toEqual([expect.objectContaining({ kind: 'review' })]);
    expect(crit('Review your own diff before handing off to a separate test step.')).toEqual([]);
  });

  it('says when no step carries a role or a check at all', () => {
    const ws = flowContractWarnings([step('START', 0, { isAnchor: true }), step('WORK', 1), step('END', 2, { isAnchor: true })]);
    expect(ws).toEqual([expect.objectContaining({ step: null, kind: 'no-contracts' })]);
  });

  it('survives garbage without throwing', () => {
    expect(flowContractWarnings(undefined as never)).toEqual([]);
    expect(() => flowContractWarnings([null, 7, 'x'] as never)).not.toThrow();
  });
});

describe('describeFlowContract carries the warnings', () => {
  it('as the same list flowContractWarnings gives', () => {
    const steps = rolelessTdd();
    expect(describeFlowContract(steps).warnings).toEqual(flowContractWarnings(steps));
    expect(describeFlowContract(TDD_FLOW_PRESET.steps).warnings).toEqual([]);
  });
});
