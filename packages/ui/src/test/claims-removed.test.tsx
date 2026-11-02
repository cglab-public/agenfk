/**
 * @file 26c059f6 — claims are gone from the board.
 *
 * The fleet sheet held a child back when a sibling claimed the same files.
 * With claims removed it says nothing about them: a fan-out launches every
 * child, whatever claims an old card still carries.
 */
import { describe, it, expect } from 'vitest';
import { planFleet, type FleetInputs } from '../fleetPlan';

describe('the fleet plan', () => {
  const OK: FleetInputs['depth'] = { allowed: true, reason: null };
  type Item = FleetInputs['all'][number];
  const kid = (id: string, claims?: string[]): Item =>
    ({ id, title: `t-${id}`, status: 'TODO', parentId: 'epic', claims } as Item);
  const epic = { id: 'epic', title: 'The epic', status: 'IN_PROGRESS' } as Item;

  it('launches every child, whatever old claims they carry', () => {
    const p = planFleet({ parentId: 'epic', all: [epic, kid('a', ['shared/']), kid('b', ['shared/file.ts']), kid('c')], depth: OK });
    expect(p.children.map(c => c.launch)).toEqual([true, true, true]);
    expect(p.children.some(c => /claim/.test(String(c.hold ?? '')))).toBe(false);
  });
});
