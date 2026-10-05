/**
 * CGLAB-385 (S9-T1) — `agenfk flow install` keeps a registry flow's step
 * contract. It used to rebuild each step from name/label/order/exitCriteria
 * only, so installing from the CLI quietly dropped roles, checks and anchors.
 */
import { describe, it, expect } from 'vitest';
import { registryFlowToLocal } from '../registryFlowFile';

const parsed = {
  schemaVersion: '1', name: 'TDD', description: 'd',
  steps: [
    { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
    { name: 'SPECS', label: 'Specs', order: 1, role: 'test-authoring', checks: [{ id: 'jira-key-valid' }], color: '#498373', icon: 'flask' },
    { name: 'DONE', label: 'Done', order: 2, isAnchor: true },
  ],
};

describe('registryFlowToLocal', () => {
  it('keeps role, checks, anchors, color and icon', () => {
    let n = 0;
    const flow = registryFlowToLocal(parsed, () => `id-${++n}`);
    expect(flow.steps[1]).toMatchObject({ id: 'id-2', name: 'SPECS', role: 'test-authoring', checks: [{ id: 'jira-key-valid' }], color: '#498373', icon: 'flask' });
    expect(flow.steps[0].isAnchor).toBe(true);
    expect(flow).toMatchObject({ name: 'TDD', description: 'd' });
  });

  it('adds no contract fields to a step that has none', () => {
    const flow = registryFlowToLocal({ ...parsed, steps: [{ name: 'A', label: 'A', order: 1 }] }, () => 'x');
    expect(flow.steps[0]).not.toHaveProperty('role');
    expect(flow.steps[0]).not.toHaveProperty('checks');
  });
});
