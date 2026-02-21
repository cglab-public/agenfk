import { describe, it, expect } from 'vitest';
import { Status, ItemType } from '../types';

describe('Core Types', () => {
  it('should have all expected Status values', () => {
    expect(Status.TODO).toBe('TODO');
    expect(Status.IN_PROGRESS).toBe('IN_PROGRESS');
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
});
