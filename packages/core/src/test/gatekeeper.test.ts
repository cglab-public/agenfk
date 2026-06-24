import { describe, it, expect } from 'vitest';
import {
  getActiveStepItems,
  decideGatekeeperAuthorization,
  type GatekeeperFlow,
  type GatekeeperItem,
} from '../gatekeeper';

const item = (id: string, status: string, type = 'TASK', title?: string): GatekeeperItem => ({
  id,
  status,
  type,
  title: title ?? `t-${id}`,
});

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

describe('getActiveStepItems (moved to core)', () => {
  it('treats any non-anchor working step as active — including custom TDD steps', () => {
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

  it('excludes anchors and inactive statuses', () => {
    const items = [item('1', 'TODO'), item('2', 'BLOCKED'), item('3', 'IN_PROGRESS'), item('4', 'DONE')];
    expect(getActiveStepItems(items, tddFlow).map(i => i.id)).toEqual(['3']);
  });
});

describe('decideGatekeeperAuthorization', () => {
  it('AUTHORIZES a TASK in a custom coding step (the bug-fix scenario)', () => {
    // This is the exact case the old CLI command wrongly rejected:
    // a TASK sitting in CREATE_UNIT_TESTS (not literal IN_PROGRESS).
    const items = [item('t1', 'CREATE_UNIT_TESTS')];
    const d = decideGatekeeperAuthorization(items, tddFlow, { intent: 'write tests' });
    expect(d.authorized).toBe(true);
    expect(d.task?.id).toBe('t1');
    expect(d.message).toContain('AUTHORIZED');
    expect(d.message).toContain('CREATE_UNIT_TESTS');
  });

  it('authorizes a BUG in an active step too', () => {
    const d = decideGatekeeperAuthorization([item('b1', 'DISCOVERY', 'BUG')], tddFlow, {});
    expect(d.authorized).toBe(true);
    expect(d.task?.id).toBe('b1');
  });

  it('is flow-aware for arbitrary role names (role is advisory, not a status gate)', () => {
    const d = decideGatekeeperAuthorization([item('t1', 'REVIEW')], tddFlow, { role: 'review' });
    expect(d.authorized).toBe(true);
    expect(d.message).toContain('REVIEW');
  });

  it('reports a breach when no TASK/BUG is in an active step', () => {
    const items = [item('t1', 'TODO'), item('t2', 'DONE')];
    const d = decideGatekeeperAuthorization(items, tddFlow, {});
    expect(d.authorized).toBe(false);
    expect(d.task).toBeNull();
    expect(d.message).toContain('WORKFLOW BREACH');
  });

  it('hints to advance a TASK/BUG when only a STORY/EPIC is active', () => {
    const d = decideGatekeeperAuthorization([item('s1', 'IN_PROGRESS', 'STORY', 'My Story')], tddFlow, {});
    expect(d.authorized).toBe(false);
    expect(d.message).toContain('My Story');
    expect(d.message).toMatch(/TASK or BUG/);
  });

  it('is AMBIGUOUS when multiple tasks are active and no item id is given', () => {
    const items = [item('t1', 'IN_PROGRESS'), item('t2', 'CREATE_UNIT_TESTS')];
    const d = decideGatekeeperAuthorization(items, tddFlow, {});
    expect(d.authorized).toBe(false);
    expect(d.ambiguous).toBe(true);
    expect(d.message).toContain('t1'.substring(0, 8));
    expect(d.message).toContain('AMBIGUOUS');
  });

  it('resolves a specific item by id (full or prefix) when multiple are active', () => {
    const items = [item('aaaaaaaa-1', 'IN_PROGRESS'), item('bbbbbbbb-2', 'CREATE_UNIT_TESTS')];
    const d = decideGatekeeperAuthorization(items, tddFlow, { itemId: 'bbbbbbbb' });
    expect(d.authorized).toBe(true);
    expect(d.task?.id).toBe('bbbbbbbb-2');
  });

  it('rejects an item id that is not in an active step', () => {
    const items = [item('t1', 'IN_PROGRESS'), item('t2', 'DONE')];
    const d = decideGatekeeperAuthorization(items, tddFlow, { itemId: 't2' });
    expect(d.authorized).toBe(false);
    expect(d.message).toContain('t2');
  });

  it('refuses to authorize work directly on an EPIC/STORY even when targeted by id', () => {
    const d = decideGatekeeperAuthorization([item('e1', 'IN_PROGRESS', 'EPIC', 'Epic X')], tddFlow, { itemId: 'e1' });
    expect(d.authorized).toBe(false);
    expect(d.message).toContain('EPIC');
  });
});
