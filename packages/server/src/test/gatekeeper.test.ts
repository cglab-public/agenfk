/**
 * Unit tests for workflow_gatekeeper coding-role logic with custom flows.
 * Covers the bug where getCodingStepName / getCodingStepItems used the literal
 * string 'IN_PROGRESS' instead of the active flow's first non-anchor step.
 */
import { describe, it, expect } from 'vitest';
import { getCodingStepName, getCodingStepItems, GatekeeperFlow, GatekeeperItem } from '../gatekeeper-utils';

// ── getCodingStepName ─────────────────────────────────────────────────────────

describe('getCodingStepName', () => {
  it('returns IN_PROGRESS when activeFlow is null (default flow)', () => {
    expect(getCodingStepName(null)).toBe('IN_PROGRESS');
  });

  it('returns IN_PROGRESS when flow has no non-anchor steps', () => {
    const flow: GatekeeperFlow = {
      steps: [
        { name: 'TODO', order: 0, isAnchor: true },
        { name: 'DONE', order: 99, isAnchor: true },
      ],
    };
    expect(getCodingStepName(flow)).toBe('IN_PROGRESS');
  });

  it('returns the first non-anchor step name from a default-style flow', () => {
    const flow: GatekeeperFlow = {
      steps: [
        { name: 'TODO', order: 0, isAnchor: true },
        { name: 'IN_PROGRESS', order: 1 },
        { name: 'REVIEW', order: 2 },
        { name: 'DONE', order: 3, isAnchor: true },
      ],
    };
    expect(getCodingStepName(flow)).toBe('IN_PROGRESS');
  });

  it('returns custom coding step name from TDD flow (create_unit_tests)', () => {
    const flow: GatekeeperFlow = {
      steps: [
        { name: 'TODO', order: 0, isAnchor: true },
        { name: 'create_unit_tests', order: 1 },
        { name: 'IN_PROGRESS', order: 2 },
        { name: 'REVIEW', order: 3 },
        { name: 'DONE', order: 4, isAnchor: true },
      ],
    };
    expect(getCodingStepName(flow)).toBe('create_unit_tests');
  });

  it('handles unsorted steps — picks the lowest order non-anchor', () => {
    const flow: GatekeeperFlow = {
      steps: [
        { name: 'REVIEW', order: 3 },
        { name: 'TODO', order: 0, isAnchor: true },
        { name: 'coding', order: 1 },
        { name: 'DONE', order: 99, isAnchor: true },
      ],
    };
    expect(getCodingStepName(flow)).toBe('coding');
  });
});

// ── getCodingStepItems ────────────────────────────────────────────────────────

describe('getCodingStepItems', () => {
  const items: GatekeeperItem[] = [
    { id: '1', status: 'TODO', type: 'TASK' },
    { id: '2', status: 'IN_PROGRESS', type: 'TASK' },
    { id: '3', status: 'create_unit_tests', type: 'TASK' },
    { id: '4', status: 'REVIEW', type: 'TASK' },
    { id: '5', status: 'DONE', type: 'TASK' },
  ];

  it('returns items in IN_PROGRESS for default flow', () => {
    const result = getCodingStepItems(items, 'IN_PROGRESS');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('2');
  });

  it('returns items in create_unit_tests for TDD flow — NOT IN_PROGRESS', () => {
    const result = getCodingStepItems(items, 'create_unit_tests');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('3');
  });

  it('does NOT include literal IN_PROGRESS items when coding step is create_unit_tests', () => {
    const result = getCodingStepItems(items, 'create_unit_tests');
    const ids = result.map(i => i.id);
    expect(ids).not.toContain('2'); // IN_PROGRESS should not match
  });

  it('is case-insensitive', () => {
    const mixedItems: GatekeeperItem[] = [
      { id: 'a', status: 'In_Progress', type: 'TASK' },
    ];
    const result = getCodingStepItems(mixedItems, 'IN_PROGRESS');
    expect(result).toHaveLength(1);
  });

  it('returns empty array when no items match the coding step', () => {
    const result = getCodingStepItems(items, 'some_other_step');
    expect(result).toHaveLength(0);
  });
});
