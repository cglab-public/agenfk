import { describe, it, expect } from 'vitest';
import { DEFAULT_FLOW, getActiveFlow } from '../defaultFlow';
import { Flow } from '../types';

describe('DEFAULT_FLOW', () => {
  it('should have the correct id and name', () => {
    expect(DEFAULT_FLOW.id).toBe('default');
    expect(DEFAULT_FLOW.name).toBe('Default Flow');
    expect(DEFAULT_FLOW.projectId).toBe('__builtin__');
  });

  it('should have exactly 10 steps', () => {
    expect(DEFAULT_FLOW.steps).toHaveLength(10);
  });

  it('should have steps in correct order', () => {
    const orders = DEFAULT_FLOW.steps.map((s) => s.order);
    expect(orders).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('should have steps with correct names in order', () => {
    const names = DEFAULT_FLOW.steps.map((s) => s.name);
    expect(names).toEqual([
      'IDEAS',
      'TODO',
      'IN_PROGRESS',
      'REVIEW',
      'TEST',
      'DONE',
      'BLOCKED',
      'PAUSED',
      'ARCHIVED',
      'TRASHED',
    ]);
  });

  it('should mark IDEAS as isSpecial', () => {
    const ideas = DEFAULT_FLOW.steps.find((s) => s.name === 'IDEAS');
    expect(ideas?.isSpecial).toBe(true);
  });

  it('should NOT mark TODO, IN_PROGRESS, REVIEW, TEST, DONE as isSpecial', () => {
    const regularSteps = ['TODO', 'IN_PROGRESS', 'REVIEW', 'TEST', 'DONE'];
    for (const name of regularSteps) {
      const step = DEFAULT_FLOW.steps.find((s) => s.name === name);
      expect(step?.isSpecial).toBeFalsy();
    }
  });

  it('should mark BLOCKED, PAUSED, ARCHIVED, TRASHED as isSpecial', () => {
    const specialSteps = ['BLOCKED', 'PAUSED', 'ARCHIVED', 'TRASHED'];
    for (const name of specialSteps) {
      const step = DEFAULT_FLOW.steps.find((s) => s.name === name);
      expect(step?.isSpecial).toBe(true);
    }
  });

  it('should have valid Date fields', () => {
    expect(DEFAULT_FLOW.createdAt).toBeInstanceOf(Date);
    expect(DEFAULT_FLOW.updatedAt).toBeInstanceOf(Date);
  });
});

describe('getActiveFlow', () => {
  const customFlow: Flow = {
    id: 'custom-flow-1',
    name: 'Custom Flow',
    projectId: 'proj-abc',
    steps: [
      { id: 's1', name: 'TODO', label: 'To Do', order: 0 },
      { id: 's2', name: 'DONE', label: 'Done', order: 1, isSpecial: true },
    ],
    createdAt: new Date('2026-02-01'),
    updatedAt: new Date('2026-02-01'),
  };

  const anotherFlow: Flow = {
    id: 'custom-flow-2',
    name: 'Another Flow',
    projectId: 'proj-xyz',
    steps: [],
    createdAt: new Date('2026-02-15'),
    updatedAt: new Date('2026-02-15'),
  };

  const flows: Flow[] = [customFlow, anotherFlow];

  it('should return DEFAULT_FLOW when flowId is undefined', () => {
    const result = getActiveFlow(undefined, flows);
    expect(result).toBe(DEFAULT_FLOW);
  });

  it('should return DEFAULT_FLOW when flowId is undefined and flows is empty', () => {
    const result = getActiveFlow(undefined, []);
    expect(result).toBe(DEFAULT_FLOW);
  });

  it('should return the matching flow when flowId matches', () => {
    const result = getActiveFlow('custom-flow-1', flows);
    expect(result).toBe(customFlow);
  });

  it('should return the correct flow when multiple flows exist', () => {
    const result = getActiveFlow('custom-flow-2', flows);
    expect(result).toBe(anotherFlow);
  });

  it('should return DEFAULT_FLOW when flowId does not match any flow', () => {
    const result = getActiveFlow('nonexistent-flow', flows);
    expect(result).toBe(DEFAULT_FLOW);
  });

  it('should return DEFAULT_FLOW when flowId does not match and flows is empty', () => {
    const result = getActiveFlow('some-id', []);
    expect(result).toBe(DEFAULT_FLOW);
  });
});
