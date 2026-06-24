import { describe, it, expect } from 'vitest';
import {
  getActiveStepItems,
  decideGatekeeperAuthorization,
  findItemAcrossProjects,
  detectCrossProjectItem,
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

describe('findItemAcrossProjects', () => {
  const items = [
    { id: 'aaaaaaaa-1111', projectId: 'projA', title: 'A' },
    { id: 'bbbbbbbb-2222', projectId: 'projB', title: 'B' },
  ];

  it('finds an item by full id regardless of project', () => {
    expect(findItemAcrossProjects(items, 'bbbbbbbb-2222')?.projectId).toBe('projB');
  });

  it('finds an item by id prefix', () => {
    expect(findItemAcrossProjects(items, 'aaaaaaaa')?.projectId).toBe('projA');
  });

  it('returns null when nothing matches', () => {
    expect(findItemAcrossProjects(items, 'zzzz')).toBeNull();
  });

  it('returns null for empty/blank id', () => {
    expect(findItemAcrossProjects(items, '')).toBeNull();
  });

  it('prefers an EXACT id match over a prefix match', () => {
    const colliding = [
      { id: 'abc-prefix-first', projectId: 'projA' },
      { id: 'abc', projectId: 'projB' }, // exact match, listed second
    ];
    expect(findItemAcrossProjects(colliding, 'abc')?.projectId).toBe('projB');
  });
});

describe('detectCrossProjectItem (B1: prefer in-project, avoid prefix-collision false positives)', () => {
  it('returns null when an in-project item matches — even if another project shares the prefix', () => {
    const all = [
      { id: 'bbbb1111-9999', projectId: 'projX', title: 'X-item' }, // other project, same prefix, listed first
      { id: 'bbbb1111-0000', projectId: 'projY', title: 'Y-item' }, // the cwd project's legit item
    ];
    // cwd = projY; prefix 'bbbb1111' collides, but Y has a match → NOT cross-project
    expect(detectCrossProjectItem(all, 'bbbb1111', 'projY')).toBeNull();
  });

  it('returns the other-project item only when no in-project match exists', () => {
    const all = [
      { id: 'cccc2222-1111', projectId: 'projX', title: 'X-only' },
      { id: 'dddd3333-1111', projectId: 'projY', title: 'Y-other' },
    ];
    const r = detectCrossProjectItem(all, 'cccc2222', 'projY');
    expect(r?.projectId).toBe('projX');
  });

  it('returns null when the match is already in the current project', () => {
    const all = [{ id: 'eeee4444', projectId: 'projY', title: 'mine' }];
    expect(detectCrossProjectItem(all, 'eeee4444', 'projY')).toBeNull();
  });

  it('returns null without an item id or current project', () => {
    const all = [{ id: 'x', projectId: 'projX' }];
    expect(detectCrossProjectItem(all, undefined, 'projY')).toBeNull();
    expect(detectCrossProjectItem(all, 'x', undefined)).toBeNull();
  });
});
