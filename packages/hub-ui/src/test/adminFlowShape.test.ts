import { describe, it, expect } from 'vitest';
import { flattenAdminFlow } from '../pages/adminFlowShape';

describe('flattenAdminFlow', () => {
  it('lifts steps + name + description out of the nested definition envelope', () => {
    const row = {
      id: 'f1',
      name: 'Hub Flow',
      description: 'org default',
      source: 'hub',
      version: 3,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      definition: {
        name: 'Hub Flow',
        description: 'org default',
        steps: [
          { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true },
          { id: 's1', name: 'work', label: 'Work', order: 1 },
          { id: 's2', name: 'done', label: 'Done', order: 2, isAnchor: true },
        ],
      },
    };
    const flat = flattenAdminFlow(row);
    expect(flat.id).toBe('f1');
    expect(flat.name).toBe('Hub Flow');
    expect(flat.steps).toHaveLength(3);
    expect(flat.steps[1].name).toBe('work');
    expect(flat.source).toBe('hub');
    expect(flat.hubVersion).toBe(3);
    expect(flat.version).toBe('3');
  });

  it('returns empty steps array (not undefined) when definition is missing', () => {
    const flat = flattenAdminFlow({ id: 'f2', name: 'broken', source: 'hub', version: 1 });
    expect(Array.isArray(flat.steps)).toBe(true);
    expect(flat.steps).toHaveLength(0);
  });

  it('falls back to definition fields when top-level fields are missing', () => {
    const row = {
      id: 'f3',
      definition: { name: 'Only In Def', description: 'tucked', steps: [{ id: 's', name: 'x', label: 'X', order: 0 }] },
    };
    const flat = flattenAdminFlow(row);
    expect(flat.name).toBe('Only In Def');
    expect(flat.description).toBe('tucked');
    expect(flat.steps).toHaveLength(1);
  });

  it('handles community-imported flows (source=community)', () => {
    const row = {
      id: 'f4', name: 'Imported', source: 'community', version: 1,
      definition: { name: 'Imported', steps: [{ id: 's', name: 'x', label: 'X', order: 0 }] },
    };
    const flat = flattenAdminFlow(row);
    expect(flat.source).toBe('community');
    expect(flat.steps).toHaveLength(1);
  });
});
