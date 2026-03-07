import { describe, it, expect } from 'vitest';
import { migrateCardsToFlow, MigrationResult } from '../utils';
import { AgEnFKItem, Flow, FlowStep, ItemType, Status } from '../types';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeItem(id: string, status: string): AgEnFKItem {
  return {
    id,
    projectId: 'proj-1',
    type: ItemType.TASK,
    title: `Item ${id}`,
    description: '',
    status: status as Status,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  } as AgEnFKItem;
}

function makeFlow(id: string, steps: Array<{ name: string; order: number; isSpecial?: boolean }>): Flow {
  const flowSteps: FlowStep[] = steps.map((s, i) => ({
    id: `${id}-step-${i}`,
    name: s.name,
    label: s.name,
    order: s.order,
    isSpecial: s.isSpecial,
  }));
  return {
    id,
    name: `Flow ${id}`,
    steps: flowSteps,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

// ── Old/new flow fixtures ──────────────────────────────────────────────────────

// Old flow: IDEAS(special) → TODO → IN_PROGRESS → REVIEW → DONE(special) → BLOCKED(special)
const OLD_FLOW = makeFlow('old', [
  { name: 'IDEAS', order: 0, isSpecial: true },
  { name: 'TODO', order: 1 },
  { name: 'IN_PROGRESS', order: 2 },
  { name: 'REVIEW', order: 3 },
  { name: 'DONE', order: 4, isSpecial: true },
  { name: 'BLOCKED', order: 5, isSpecial: true },
]);

// New flow has same step names → exact match expected
const NEW_FLOW_SAME_NAMES = makeFlow('new-same', [
  { name: 'IDEAS', order: 0, isSpecial: true },
  { name: 'TODO', order: 1 },
  { name: 'IN_PROGRESS', order: 2 },
  { name: 'REVIEW', order: 3 },
  { name: 'DONE', order: 4, isSpecial: true },
  { name: 'BLOCKED', order: 5, isSpecial: true },
]);

// New flow with different step names → positional match
const NEW_FLOW_DIFFERENT_NAMES = makeFlow('new-diff', [
  { name: 'BACKLOG', order: 0, isSpecial: true },
  { name: 'SELECTED', order: 1 },
  { name: 'ACTIVE', order: 2 },
  { name: 'CHECKING', order: 3 },
  { name: 'SHIPPED', order: 4, isSpecial: true },
]);

// New flow with fewer steps than old → fallback for steps beyond new flow length
const NEW_FLOW_SHORT = makeFlow('new-short', [
  { name: 'IDEAS', order: 0, isSpecial: true },
  { name: 'WORKING', order: 1 },
]);

// New flow with all special steps (edge case)
const NEW_FLOW_ALL_SPECIAL = makeFlow('new-all-special', [
  { name: 'IDEAS', order: 0, isSpecial: true },
  { name: 'DONE', order: 1, isSpecial: true },
]);

// New flow with no steps at all (edge case)
const NEW_FLOW_EMPTY: Flow = {
  id: 'new-empty',
  name: 'Empty Flow',
  steps: [],
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('migrateCardsToFlow', () => {
  describe('Exact name match', () => {
    it('should map steps to the same-named step in newFlow (case-insensitive)', () => {
      const items = [
        makeItem('a', 'TODO'),
        makeItem('b', 'IN_PROGRESS'),
        makeItem('c', 'REVIEW'),
      ];
      const results = migrateCardsToFlow(items, OLD_FLOW, NEW_FLOW_SAME_NAMES);

      expect(results).toHaveLength(3);
      results.forEach((r) => {
        expect(r.reason).toBe('exact-match');
        expect(r.newStatus).toBe(r.oldStatus);
      });
    });

    it('should match case-insensitively (lowercase status in item)', () => {
      // Simulate a card whose status happens to be stored lowercase
      const items = [makeItem('x', 'todo')];
      const newFlow = makeFlow('nf', [
        { name: 'TODO', order: 0 },
        { name: 'DONE', order: 1, isSpecial: true },
      ]);
      const oldFlow = makeFlow('of', [
        { name: 'todo', order: 0 },
        { name: 'done', order: 1, isSpecial: true },
      ]);
      const results = migrateCardsToFlow(items, oldFlow, newFlow);
      expect(results[0].reason).toBe('exact-match');
      expect(results[0].newStatus).toBe('TODO');
    });
  });

  describe('Positional match', () => {
    it('should use the same-index step in newFlow when no name match', () => {
      // IN_PROGRESS is at index 2 in OLD_FLOW (sorted by order)
      // ACTIVE is at index 2 in NEW_FLOW_DIFFERENT_NAMES
      const items = [makeItem('a', 'IN_PROGRESS')];
      const results = migrateCardsToFlow(items, OLD_FLOW, NEW_FLOW_DIFFERENT_NAMES);

      expect(results[0].reason).toBe('positional');
      expect(results[0].newStatus).toBe('ACTIVE');
    });

    it('should use positional match for all non-special steps', () => {
      // Old: IDEAS(0,special) TODO(1) IN_PROGRESS(2) REVIEW(3) DONE(4,special) BLOCKED(5,special)
      // New: BACKLOG(0,special) SELECTED(1) ACTIVE(2) CHECKING(3) SHIPPED(4,special)
      const items = [
        makeItem('a', 'TODO'),      // idx 1 → SELECTED
        makeItem('b', 'IN_PROGRESS'), // idx 2 → ACTIVE
        makeItem('c', 'REVIEW'),    // idx 3 → CHECKING
      ];
      const results = migrateCardsToFlow(items, OLD_FLOW, NEW_FLOW_DIFFERENT_NAMES);

      expect(results.find((r) => r.itemId === 'a')?.newStatus).toBe('SELECTED');
      expect(results.find((r) => r.itemId === 'a')?.reason).toBe('positional');
      expect(results.find((r) => r.itemId === 'b')?.newStatus).toBe('ACTIVE');
      expect(results.find((r) => r.itemId === 'b')?.reason).toBe('positional');
      expect(results.find((r) => r.itemId === 'c')?.newStatus).toBe('CHECKING');
      expect(results.find((r) => r.itemId === 'c')?.reason).toBe('positional');
    });
  });

  describe('Fallback to IDEAS', () => {
    it('should fallback to first non-special step when positional index is out of range', () => {
      // REVIEW is at index 3 in OLD_FLOW but NEW_FLOW_SHORT only has 2 steps (idx 0,1)
      // No exact match for REVIEW either
      // Fallback: first non-special in new flow = WORKING
      const items = [makeItem('a', 'REVIEW')];
      const results = migrateCardsToFlow(items, OLD_FLOW, NEW_FLOW_SHORT);

      expect(results[0].reason).toBe('fallback');
      expect(results[0].newStatus).toBe('WORKING');
    });

    it('should fallback to IDEAS if all newFlow steps are special', () => {
      // IN_PROGRESS has no exact match, no positional (index 2 out of range for 2-step flow)
      // Fallback: no non-special step → IDEAS
      const items = [makeItem('a', 'IN_PROGRESS')];
      const results = migrateCardsToFlow(items, OLD_FLOW, NEW_FLOW_ALL_SPECIAL);

      expect(results[0].reason).toBe('fallback');
      expect(results[0].newStatus).toBe('IDEAS');
    });
  });

  describe('Special steps handling', () => {
    it('should skip BLOCKED (platform-fixed status) — not included in results', () => {
      const items = [makeItem('a', 'BLOCKED')];
      const results = migrateCardsToFlow(items, OLD_FLOW, NEW_FLOW_SAME_NAMES);
      expect(results).toHaveLength(0);
    });

    it('should skip IDEAS (platform-fixed status) — not included in results', () => {
      const items = [makeItem('a', 'IDEAS')];
      const results = migrateCardsToFlow(items, OLD_FLOW, NEW_FLOW_SAME_NAMES);
      expect(results).toHaveLength(0);
    });
  });

  describe('Edge cases', () => {
    it('should return empty array when items is empty', () => {
      const results = migrateCardsToFlow([], OLD_FLOW, NEW_FLOW_SAME_NAMES);
      expect(results).toHaveLength(0);
    });

    it('should handle items with status not in oldFlow (unknown step)', () => {
      // Status 'UNKNOWN' is not in OLD_FLOW steps, so oldStep is undefined.
      // No exact match in newFlow → no positional (oldStep is null) → fallback
      const items = [makeItem('a', 'UNKNOWN')];
      const results = migrateCardsToFlow(items, OLD_FLOW, NEW_FLOW_SAME_NAMES);

      expect(results[0].reason).toBe('fallback');
    });

    it('should handle empty newFlow (no steps) gracefully', () => {
      const items = [makeItem('a', 'TODO')];
      // newFlow has no steps → fallbackStep is undefined → newStatus = 'IDEAS'
      const results = migrateCardsToFlow(items, OLD_FLOW, NEW_FLOW_EMPTY);

      expect(results[0].newStatus).toBe('IDEAS');
      expect(results[0].reason).toBe('fallback');
    });

    it('should preserve itemId and oldStatus in results', () => {
      const items = [makeItem('item-123', 'TODO')];
      const results = migrateCardsToFlow(items, OLD_FLOW, NEW_FLOW_SAME_NAMES);

      expect(results[0].itemId).toBe('item-123');
      expect(results[0].oldStatus).toBe('TODO');
    });

    it('skips platform-fixed statuses (IDEAS, BLOCKED, PAUSED, ARCHIVED, TRASHED) — only flow steps are migrated', () => {
      const items = [
        makeItem('a', 'TODO'),
        makeItem('b', 'IN_PROGRESS'),
        makeItem('c', 'REVIEW'),
        makeItem('d', 'IDEAS'),      // platform — skipped
        makeItem('e', 'BLOCKED'),    // platform — skipped
        makeItem('f', 'PAUSED'),     // platform — skipped
        makeItem('g', 'ARCHIVED'),   // platform — skipped
        makeItem('h', 'TRASHED'),    // platform — skipped
      ];
      const results = migrateCardsToFlow(items, OLD_FLOW, NEW_FLOW_SAME_NAMES);
      // Only flow-step items (a, b, c) are in results
      expect(results).toHaveLength(3);
      expect(results.map((r) => r.itemId)).toEqual(['a', 'b', 'c']);
    });
  });
});
