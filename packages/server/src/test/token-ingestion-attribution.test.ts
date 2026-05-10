import { describe, it, expect } from 'vitest';
import { findActiveItemAt } from '../token-ingestion/attribution';
import type { AgEnFKItem } from '@agenfk/core';

const FLOW = {
  steps: [
    { name: 'TODO', order: 0, isAnchor: true },
    { name: 'IN_PROGRESS', order: 1 },
    { name: 'REVIEW', order: 2 },
    { name: 'DONE', order: 3, isAnchor: true },
  ],
};

function makeItem(id: string, history: { from: string; to: string; ts: string }[]): AgEnFKItem {
  return {
    id,
    projectId: 'p1',
    type: 'TASK',
    title: id,
    description: '',
    status: history[history.length - 1]?.to as any,
    createdAt: new Date(history[0]?.ts ?? '2026-05-01'),
    updatedAt: new Date(history[history.length - 1]?.ts ?? '2026-05-01'),
    history: history.map((h, i) => ({
      id: `h-${id}-${i}`,
      fromStatus: h.from as any,
      toStatus: h.to as any,
      timestamp: new Date(h.ts),
    })),
  } as AgEnFKItem;
}

describe('findActiveItemAt', () => {
  it('returns null when no items have transitioned to a working step', () => {
    const items: AgEnFKItem[] = [
      makeItem('a', [{ from: 'TODO', to: 'TODO', ts: '2026-05-01T00:00:00Z' }]),
    ];
    expect(findActiveItemAt(items, FLOW, '2026-05-10T00:00:00Z')).toBeNull();
  });

  it('returns the item whose most-recent transition INTO an active step is at or before T', () => {
    const a = makeItem('a', [
      { from: 'TODO', to: 'IN_PROGRESS', ts: '2026-05-10T00:00:00Z' },
    ]);
    const b = makeItem('b', [
      { from: 'TODO', to: 'IN_PROGRESS', ts: '2026-05-10T01:00:00Z' },
    ]);
    expect(findActiveItemAt([a, b], FLOW, '2026-05-10T02:00:00Z')).toBe('b');
    expect(findActiveItemAt([a, b], FLOW, '2026-05-10T00:30:00Z')).toBe('a');
  });

  it('skips items that transitioned out of an active step before T', () => {
    const a = makeItem('a', [
      { from: 'TODO', to: 'IN_PROGRESS', ts: '2026-05-10T00:00:00Z' },
      { from: 'IN_PROGRESS', to: 'DONE', ts: '2026-05-10T01:00:00Z' },
    ]);
    const b = makeItem('b', [
      { from: 'TODO', to: 'IN_PROGRESS', ts: '2026-05-10T00:30:00Z' },
    ]);
    // At T = 02:00, a is DONE (anchor), b is IN_PROGRESS → b wins
    expect(findActiveItemAt([a, b], FLOW, '2026-05-10T02:00:00Z')).toBe('b');
  });

  it('treats PAUSED/BLOCKED/ARCHIVED/TRASHED/IDEAS as inactive', () => {
    const a = makeItem('a', [
      { from: 'TODO', to: 'IN_PROGRESS', ts: '2026-05-10T00:00:00Z' },
      { from: 'IN_PROGRESS', to: 'PAUSED', ts: '2026-05-10T01:00:00Z' },
    ]);
    const b = makeItem('b', [
      { from: 'TODO', to: 'REVIEW', ts: '2026-05-10T00:30:00Z' },
    ]);
    expect(findActiveItemAt([a, b], FLOW, '2026-05-10T02:00:00Z')).toBe('b');
  });

  it('handles a single item that re-entered an active step', () => {
    const a = makeItem('a', [
      { from: 'TODO', to: 'IN_PROGRESS', ts: '2026-05-10T00:00:00Z' },
      { from: 'IN_PROGRESS', to: 'REVIEW', ts: '2026-05-10T01:00:00Z' },
      { from: 'REVIEW', to: 'IN_PROGRESS', ts: '2026-05-10T02:00:00Z' },
    ]);
    expect(findActiveItemAt([a], FLOW, '2026-05-10T03:00:00Z')).toBe('a');
  });

  it('ignores items whose only transition is after T', () => {
    const a = makeItem('a', [
      { from: 'TODO', to: 'IN_PROGRESS', ts: '2026-05-10T05:00:00Z' },
    ]);
    expect(findActiveItemAt([a], FLOW, '2026-05-10T03:00:00Z')).toBeNull();
  });
});
