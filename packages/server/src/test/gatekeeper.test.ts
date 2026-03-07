/**
 * Unit tests for the simplified workflow_gatekeeper utilities.
 * The gatekeeper no longer enforces role/step coupling — it verifies any active
 * task exists in any non-anchor, non-terminal step and returns context.
 */
import { describe, it, expect } from 'vitest';
import { getActiveStepItems, GatekeeperFlow, GatekeeperItem } from '../gatekeeper-utils';

const DEFAULT_FLOW: GatekeeperFlow = {
  steps: [
    { name: 'TODO', order: 0, isAnchor: true },
    { name: 'IN_PROGRESS', order: 1 },
    { name: 'REVIEW', order: 2 },
    { name: 'DONE', order: 3, isAnchor: true },
  ],
};

const TDD_FLOW: GatekeeperFlow = {
  steps: [
    { name: 'TODO', order: 0, isAnchor: true },
    { name: 'create_unit_tests', order: 1 },
    { name: 'IN_PROGRESS', order: 2 },
    { name: 'REVIEW', order: 3 },
    { name: 'DONE', order: 4, isAnchor: true },
  ],
};

// ── getActiveStepItems ────────────────────────────────────────────────────────

describe('getActiveStepItems', () => {
  const items: GatekeeperItem[] = [
    { id: '1', status: 'TODO', type: 'TASK' },
    { id: '2', status: 'IN_PROGRESS', type: 'TASK' },
    { id: '3', status: 'create_unit_tests', type: 'TASK' },
    { id: '4', status: 'REVIEW', type: 'TASK' },
    { id: '5', status: 'DONE', type: 'TASK' },
    { id: '6', status: 'BLOCKED', type: 'TASK' },
    { id: '7', status: 'PAUSED', type: 'TASK' },
  ];

  it('returns items in any non-anchor working step (default flow)', () => {
    const result = getActiveStepItems(items, DEFAULT_FLOW);
    const ids = result.map((i: GatekeeperItem) => i.id);
    expect(ids).toContain('2'); // IN_PROGRESS
    expect(ids).toContain('4'); // REVIEW
    expect(ids).not.toContain('1'); // TODO is anchor
    expect(ids).not.toContain('5'); // DONE is anchor
  });

  it('returns items in ALL working steps for TDD flow — both create_unit_tests and IN_PROGRESS', () => {
    const result = getActiveStepItems(items, TDD_FLOW);
    const ids = result.map((i: GatekeeperItem) => i.id);
    expect(ids).toContain('2'); // IN_PROGRESS
    expect(ids).toContain('3'); // create_unit_tests
    expect(ids).toContain('4'); // REVIEW
    expect(ids).not.toContain('1'); // TODO
    expect(ids).not.toContain('5'); // DONE
  });

  it('excludes BLOCKED and PAUSED items', () => {
    const result = getActiveStepItems(items, DEFAULT_FLOW);
    const ids = result.map((i: GatekeeperItem) => i.id);
    expect(ids).not.toContain('6'); // BLOCKED
    expect(ids).not.toContain('7'); // PAUSED
  });

  it('returns all non-anchor working step items when flow is null (fallback)', () => {
    const result = getActiveStepItems(items, null);
    const ids = result.map((i: GatekeeperItem) => i.id);
    expect(ids).toContain('2'); // IN_PROGRESS
    expect(ids).toContain('4'); // REVIEW
    expect(ids).not.toContain('1'); // TODO
    expect(ids).not.toContain('5'); // DONE
  });

  it('returns empty array when no items are in active steps', () => {
    const onlyTodo: GatekeeperItem[] = [
      { id: 'a', status: 'TODO', type: 'TASK' },
      { id: 'b', status: 'DONE', type: 'TASK' },
    ];
    expect(getActiveStepItems(onlyTodo, DEFAULT_FLOW)).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    const mixed: GatekeeperItem[] = [
      { id: 'x', status: 'in_progress', type: 'TASK' },
    ];
    const result = getActiveStepItems(mixed, DEFAULT_FLOW);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('x');
  });
});
