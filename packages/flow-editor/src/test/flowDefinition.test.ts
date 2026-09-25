/**
 * BUG 269eeec8 defect (c) — the Hub validates flow-definition shape
 * (packages/hub/src/routes/admin.ts validateDefinition) while the local agenfk
 * server validated nothing, so the same editor could author a flow the local
 * server persisted happily and the Hub rejected with a bare 400. This mirrors
 * the Hub's contract client-side so Save is blocked with a field-level reason
 * before any request goes out.
 *
 * These assertions ARE the contract: if the Hub's validator gains a rule, it
 * gains a case here too, or the editor silently drifts back out of sync.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { flowDefinitionIssues, withStepIds } from '../flowDefinition';
import type { FlowStep } from '../types';

const step = (over: Partial<FlowStep> = {}): FlowStep => ({
  id: 's1',
  name: 'work',
  label: 'Work',
  order: 1,
  exitCriteria: '',
  ...over,
});

const validSteps = (): FlowStep[] => [
  step({ id: 's0', name: 'TODO', label: 'To Do', order: 0, isAnchor: true }),
  step({ id: 's1', name: 'work', label: 'Work', order: 1 }),
  step({ id: 's2', name: 'DONE', label: 'Done', order: 2, isAnchor: true }),
];

describe('flowDefinitionIssues', () => {
  it('reports nothing for a well-formed definition', () => {
    expect(flowDefinitionIssues('My Flow', validSteps())).toEqual([]);
  });

  it('rejects a blank flow name', () => {
    const issues = flowDefinitionIssues('   ', validSteps());
    expect(issues).toHaveLength(1);
    expect(issues[0].stepIndex).toBeUndefined();
    expect(issues[0].message).toMatch(/name/i);
  });

  it('rejects an empty step list', () => {
    expect(flowDefinitionIssues('My Flow', [])).toHaveLength(1);
  });

  // The defect that actually fired: makeBlankStep() seeds `name: ''`, so adding
  // a step and saving before typing a name 400s the whole save at the Hub.
  it('pins the blank step name to the offending step index', () => {
    const steps = validSteps();
    steps.splice(2, 0, step({ id: 'new', name: '', label: '', order: 2 }));
    const issues = flowDefinitionIssues('My Flow', steps);
    expect(issues).toHaveLength(1);
    expect(issues[0].stepIndex).toBe(2);
    expect(issues[0].message).toMatch(/name/i);
  });

  it('treats a whitespace-only step name as blank', () => {
    const steps = validSteps();
    steps[1] = step({ id: 's1', name: '  ', label: 'Work', order: 1 });
    expect(flowDefinitionIssues('My Flow', steps)[0].stepIndex).toBe(1);
  });

  it('reports every blank step, not just the first', () => {
    const steps = validSteps();
    steps.splice(1, 0, step({ id: 'n1', name: '', order: 1 }));
    steps.splice(3, 0, step({ id: 'n2', name: '', order: 3 }));
    const issues = flowDefinitionIssues('My Flow', steps);
    expect(issues.map(i => i.stepIndex)).toEqual([1, 3]);
  });

  // Deliberately NOT gated: MCP create_flow never sent step ids (its schema
  // omitted the key), so flows already in users' databases have steps — anchors
  // included — without one. Blocking Save would strand the user in front of a
  // field the editor does not expose, with anchors offering no input at all.
  it('does NOT block on a missing step id — it is backfilled, not user-fixable', () => {
    const steps = validSteps();
    steps[1] = step({ id: '', name: 'work', order: 1 });
    expect(flowDefinitionIssues('My Flow', steps)).toEqual([]);
  });

  // Also not gated: the save payload rewrites order to the array index, so a
  // bad value in loaded data is repaired by the request itself.
  it('does NOT block on a non-numeric step order — the payload rewrites it', () => {
    const steps = validSteps();
    steps[1] = { ...step({ id: 's1', name: 'work' }), order: undefined as unknown as number };
    expect(flowDefinitionIssues('My Flow', steps)).toEqual([]);
  });

  it('accumulates a flow-level and a step-level issue together', () => {
    const steps = validSteps();
    steps[1] = step({ id: 's1', name: '', order: 1 });
    const issues = flowDefinitionIssues('', steps);
    expect(issues).toHaveLength(2);
    expect(issues.some(i => i.stepIndex === undefined)).toBe(true);
    expect(issues.some(i => i.stepIndex === 1)).toBe(true);
  });
});

describe('withStepIds', () => {
  let n = 0;
  const gen = () => `generated-${++n}`;
  beforeEach(() => { n = 0; });

  it('fills in ids for steps that lack them and leaves existing ids alone', () => {
    const steps = [step({ id: 'keep', name: 'a', order: 0 }), step({ id: '', name: 'b', order: 1 })];
    const out = withStepIds(steps, gen);
    expect(out[0].id).toBe('keep');
    expect(out[1].id).toBe('generated-1');
  });

  it('does not mutate the input array or its steps', () => {
    const steps = [step({ id: '', name: 'a', order: 0 })];
    const out = withStepIds(steps, gen);
    expect(steps[0].id).toBe('');
    expect(out[0]).not.toBe(steps[0]);
  });

  it('preserves every other field while filling the id', () => {
    const steps = [step({ id: '', name: 'a', label: 'A', order: 3, exitCriteria: 'done when X' })];
    const [out] = withStepIds(steps, gen);
    expect(out).toMatchObject({ name: 'a', label: 'A', order: 3, exitCriteria: 'done when X' });
  });
});
