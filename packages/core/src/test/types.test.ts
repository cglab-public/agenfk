import { describe, it, expect } from 'vitest';
import { Status, ItemType, FlowStep, Flow } from '../types';

describe('Core Types', () => {
  it('should have all expected Status values', () => {
    expect(Status.TODO).toBe('TODO');
    expect(Status.IN_PROGRESS).toBe('IN_PROGRESS');
    expect(Status.TEST).toBe('TEST');
    expect(Status.REVIEW).toBe('REVIEW');
    expect(Status.DONE).toBe('DONE');
    expect(Status.BLOCKED).toBe('BLOCKED');
    expect(Status.ARCHIVED).toBe('ARCHIVED');
  });

  it('should have all expected ItemType values', () => {
    expect(ItemType.EPIC).toBe('EPIC');
    expect(ItemType.STORY).toBe('STORY');
    expect(ItemType.TASK).toBe('TASK');
    expect(ItemType.BUG).toBe('BUG');
  });

  describe('FlowStep', () => {
    it('should construct a valid FlowStep with required fields', () => {
      const step: FlowStep = {
        id: 'step-1',
        name: 'in_progress',
        label: 'In Progress',
        order: 1,
      };
      expect(step.id).toBe('step-1');
      expect(step.name).toBe('in_progress');
      expect(step.label).toBe('In Progress');
      expect(step.order).toBe(1);
      expect(step.exitCriteria).toBeUndefined();
      expect(step.isSpecial).toBeUndefined();
    });

    it('should support optional exitCriteria and isSpecial', () => {
      const step: FlowStep = {
        id: 'step-done',
        name: 'done',
        label: 'Done',
        order: 99,
        exitCriteria: 'All tests passing',
        isSpecial: true,
      };
      expect(step.exitCriteria).toBe('All tests passing');
      expect(step.isSpecial).toBe(true);
    });
  });

  describe('Flow', () => {
    it('should construct a valid Flow', () => {
      const steps: FlowStep[] = [
        { id: 's1', name: 'todo', label: 'To Do', order: 0 },
        { id: 's2', name: 'done', label: 'Done', order: 1, isSpecial: true },
      ];
      const flow: Flow = {
        id: 'flow-1',
        name: 'Default Flow',
        description: 'Standard agile flow',
        steps,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
      };
      expect(flow.id).toBe('flow-1');
      expect(flow.name).toBe('Default Flow');
      expect(flow.steps).toHaveLength(2);
      expect(flow.steps[1].isSpecial).toBe(true);
      expect(flow.createdAt).toBeInstanceOf(Date);
    });

    it('should allow Flow without optional description', () => {
      const flow: Flow = {
        id: 'flow-2',
        name: 'Minimal Flow',
        steps: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(flow.description).toBeUndefined();
      expect(flow.steps).toHaveLength(0);
    });
  });
});
