import { describe, it, expect } from 'vitest';
import {
  getActiveStepItems,
  getCodingStepName,
  getCodingStepItems,
  type GatekeeperFlow,
  type GatekeeperItem,
} from '../gatekeeper-utils';

const item = (id: string, status: string, type = 'TASK'): GatekeeperItem => ({
  id, status, type, title: `t-${id}`,
});

const defaultFlow: GatekeeperFlow = {
  steps: [
    { name: 'TODO', order: 0, isAnchor: true },
    { name: 'IN_PROGRESS', order: 1 },
    { name: 'REVIEW', order: 2 },
    { name: 'DONE', order: 3, isAnchor: true },
  ],
};

const tddFlow: GatekeeperFlow = {
  steps: [
    { name: 'TODO', order: 0, isAnchor: true },
    { name: 'DISCOVERY', order: 1 },
    { name: 'CREATE_UNIT_TESTS', order: 2 },
    { name: 'IN_PROGRESS', order: 3 },
    { name: 'REVIEW', order: 4 },
    { name: 'DONE', order: 5, isAnchor: true },
  ],
};

describe('getActiveStepItems', () => {
  it('keeps items in any non-anchor working step (default flow)', () => {
    const items = [
      item('1', 'TODO'),
      item('2', 'IN_PROGRESS'),
      item('3', 'REVIEW'),
      item('4', 'DONE'),
    ];
    expect(getActiveStepItems(items, defaultFlow).map(i => i.id)).toEqual(['2', '3']);
  });

  it('filters out INACTIVE_STATUSES even when not anchors', () => {
    const items = [
      item('1', 'IN_PROGRESS'),
      item('2', 'BLOCKED'),
      item('3', 'PAUSED'),
      item('4', 'TRASHED'),
      item('5', 'ARCHIVED'),
      item('6', 'IDEAS'),
      item('7', 'REVIEW'),
    ];
    expect(getActiveStepItems(items, defaultFlow).map(i => i.id)).toEqual(['1', '7']);
  });

  it('treats status comparison case-insensitively', () => {
    const items = [
      item('1', 'todo'),
      item('2', 'in_progress'),
      item('3', 'blocked'),
    ];
    expect(getActiveStepItems(items, defaultFlow).map(i => i.id)).toEqual(['2']);
  });

  it('keeps multi-step working items in TDD-style flows (the bug-fix scenario)', () => {
    const items = [
      item('a', 'DISCOVERY'),
      item('b', 'CREATE_UNIT_TESTS'),
      item('c', 'IN_PROGRESS'),
      item('d', 'REVIEW'),
      item('e', 'TODO'),
      item('f', 'DONE'),
    ];
    expect(getActiveStepItems(items, tddFlow).map(i => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('honors a custom flow with non-default anchor names', () => {
    const flow: GatekeeperFlow = {
      steps: [
        { name: 'BACKLOG', order: 0, isAnchor: true },
        { name: 'BUILD', order: 1 },
        { name: 'SHIPPED', order: 2, isAnchor: true },
      ],
    };
    const items = [
      item('1', 'BACKLOG'),
      item('2', 'BUILD'),
      item('3', 'SHIPPED'),
    ];
    expect(getActiveStepItems(items, flow).map(i => i.id)).toEqual(['2']);
  });

  it('falls back to TODO/DONE anchors when flow is null', () => {
    const items = [
      item('1', 'TODO'),
      item('2', 'IN_PROGRESS'),
      item('3', 'DONE'),
    ];
    expect(getActiveStepItems(items, null).map(i => i.id)).toEqual(['2']);
  });

  it('returns an empty array when no items qualify', () => {
    const items = [item('1', 'TODO'), item('2', 'DONE'), item('3', 'BLOCKED')];
    expect(getActiveStepItems(items, defaultFlow)).toEqual([]);
  });

  it('returns an empty array on empty input', () => {
    expect(getActiveStepItems([], defaultFlow)).toEqual([]);
    expect(getActiveStepItems([], null)).toEqual([]);
  });
});

describe('getCodingStepName (deprecated)', () => {
  it('returns IN_PROGRESS when flow is null', () => {
    expect(getCodingStepName(null)).toBe('IN_PROGRESS');
  });

  it('returns the first non-anchor step ordered by `order`', () => {
    const flow: GatekeeperFlow = {
      steps: [
        { name: 'IN_PROGRESS', order: 2 },
        { name: 'DONE', order: 3, isAnchor: true },
        { name: 'TODO', order: 0, isAnchor: true },
        { name: 'DISCOVERY', order: 1 },
      ],
    };
    expect(getCodingStepName(flow)).toBe('DISCOVERY');
  });

  it('falls back to IN_PROGRESS when every step is an anchor', () => {
    const flow: GatekeeperFlow = {
      steps: [
        { name: 'TODO', order: 0, isAnchor: true },
        { name: 'DONE', order: 1, isAnchor: true },
      ],
    };
    expect(getCodingStepName(flow)).toBe('IN_PROGRESS');
  });
});

describe('getCodingStepItems (deprecated)', () => {
  it('matches step name case-insensitively', () => {
    const items = [item('1', 'IN_PROGRESS'), item('2', 'review'), item('3', 'in_progress')];
    expect(getCodingStepItems(items, 'in_progress').map(i => i.id)).toEqual(['1', '3']);
  });

  it('returns an empty array when no items match', () => {
    expect(getCodingStepItems([item('1', 'TODO')], 'IN_PROGRESS')).toEqual([]);
  });
});
