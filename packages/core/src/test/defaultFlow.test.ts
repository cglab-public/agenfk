import { describe, it, expect } from 'vitest';
import { DEFAULT_FLOW, getActiveFlow } from '../defaultFlow';
import { Flow } from '../types';

describe('DEFAULT_FLOW', () => {
  it('should have the correct id and name', () => {
    expect(DEFAULT_FLOW.id).toBe('default');
    expect(DEFAULT_FLOW.name).toBe('Default Flow');
  });

  it('should have exactly 6 TDD steps (platform statuses are not flow steps)', () => {
    expect(DEFAULT_FLOW.steps).toHaveLength(6);
  });

  it('should have steps in correct order', () => {
    const orders = DEFAULT_FLOW.steps.map((s) => s.order);
    expect(orders).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('should have TDD-style step names in order', () => {
    const names = DEFAULT_FLOW.steps.map((s) => s.name);
    expect(names).toEqual([
      'TODO',
      'DISCOVERY',
      'CREATE_UNIT_TESTS',
      'IN_PROGRESS',
      'REVIEW',
      'DONE',
    ]);
  });

  it('should NOT include platform statuses as flow steps', () => {
    const platformStatuses = ['IDEAS', 'BLOCKED', 'PAUSED', 'ARCHIVED', 'TRASHED'];
    for (const name of platformStatuses) {
      const step = DEFAULT_FLOW.steps.find((s) => s.name === name);
      expect(step).toBeUndefined();
    }
  });

  it('should mark TODO as isAnchor with order 0', () => {
    const todo = DEFAULT_FLOW.steps.find((s) => s.name === 'TODO');
    expect(todo).toBeDefined();
    expect(todo?.isAnchor).toBe(true);
    expect(todo?.order).toBe(0);
  });

  it('should mark DONE as isAnchor with the highest order', () => {
    const done = DEFAULT_FLOW.steps.find((s) => s.name === 'DONE');
    expect(done).toBeDefined();
    expect(done?.isAnchor).toBe(true);
    expect(done?.order).toBe(5);
  });

  it('should NOT mark middle steps (DISCOVERY, CREATE_UNIT_TESTS, IN_PROGRESS, REVIEW) as isAnchor', () => {
    const middleSteps = ['DISCOVERY', 'CREATE_UNIT_TESTS', 'IN_PROGRESS', 'REVIEW'];
    for (const name of middleSteps) {
      const step = DEFAULT_FLOW.steps.find((s) => s.name === name);
      expect(step?.isAnchor).toBeFalsy();
    }
  });

  it('should define exitCriteria for CREATE_UNIT_TESTS and IN_PROGRESS (TDD contract)', () => {
    const createTests = DEFAULT_FLOW.steps.find((s) => s.name === 'CREATE_UNIT_TESTS');
    expect(createTests?.exitCriteria).toBeTruthy();
    const inProgress = DEFAULT_FLOW.steps.find((s) => s.name === 'IN_PROGRESS');
    expect(inProgress?.exitCriteria).toBeTruthy();
  });

  it('should NOT mark any step as isSpecial (deprecated field)', () => {
    for (const step of DEFAULT_FLOW.steps) {
      expect(step.isSpecial).toBeFalsy();
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
    steps: [
      { id: 's1', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
      { id: 's2', name: 'DONE', label: 'Done', order: 1, isAnchor: true },
    ],
    createdAt: new Date('2026-02-01'),
    updatedAt: new Date('2026-02-01'),
  };

  const anotherFlow: Flow = {
    id: 'custom-flow-2',
    name: 'Another Flow',
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
