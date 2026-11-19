/**
 * GH-389: a card's usage when it closes. The total is every turn charged to
 * the card and to all its descendants, read from the stored turns - not added
 * up from the step rows, so a turn that arrived after its step was counted
 * still counts here. The breakdown is the card's own step rows.
 */
import { describe, it, expect } from 'vitest';
import type { TokenEvent } from '@agenfk/core';
import { computeCardUsage } from '../usage/stepUsage';

const ev = (itemId: string, input: number, over: Partial<TokenEvent> = {}): TokenEvent => ({
  id: Math.random().toString(), ts: '2026-11-19T10:00:00.000Z', client: 'claude-code', sessionId: 's', model: 'claude-opus-5-5',
  input, cachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0, total: input + 1, itemId,
  sourcePath: '/p', sourceOffset: 0, ...over,
});

const zero = { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, unpricedTurns: 0 };

function storage(items: any[], events: TokenEvent[]) {
  return {
    async getItem(id: string) { return items.find((i) => i.id === id) ?? null; },
    async listItems(q: { projectId: string }) { return items.filter((i) => i.projectId === q.projectId); },
    async queryTokenEvents(q: { itemId: string }) { return events.filter((e) => e.itemId === q.itemId); },
  };
}

describe('computeCardUsage', () => {
  const items = [
    { id: 'story', projectId: 'p', usageByStep: [
      { step: 'WORK', to: 'REVIEW', total: { ...zero, turns: 1, input: 5 } },
      { step: 'REVIEW', to: 'DONE', total: { ...zero, turns: 1, input: 7 } },
    ] },
    { id: 'task-a', projectId: 'p', parentId: 'story' },
    { id: 'task-b', projectId: 'p', parentId: 'story' },
    { id: 'sub', projectId: 'p', parentId: 'task-a' },
    { id: 'unrelated', projectId: 'p' },
  ];
  const events = [ev('story', 12), ev('task-a', 100), ev('task-b', 1000), ev('sub', 10000), ev('unrelated', 99999)];

  it('totals the card and every descendant, and nothing else', async () => {
    const u = await computeCardUsage(storage(items, events), 'story');
    expect(u!.total.input).toBe(12 + 100 + 1000 + 10000);
    expect(u!.total.turns).toBe(4);
    expect(u!.cards).toBe(4);
  });

  it('breaks the card down by its own steps', async () => {
    const u = await computeCardUsage(storage(items, events), 'story');
    expect(u!.byStep).toEqual([
      { step: 'WORK', total: { ...zero, turns: 1, input: 5 } },
      { step: 'REVIEW', total: { ...zero, turns: 1, input: 7 } },
    ]);
  });

  it('a leaf card is just itself', async () => {
    const u = await computeCardUsage(storage(items, events), 'sub');
    expect(u!.total.input).toBe(10000);
    expect(u!.cards).toBe(1);
    expect(u!.byStep).toEqual([]);
  });

  it('a card that is gone has no usage', async () => {
    expect(await computeCardUsage(storage(items, events), 'nope')).toBeNull();
  });

  it('carries whether the closing step was read completely', async () => {
    expect((await computeCardUsage(storage(items, events), 'story', false))!.complete).toBe(false);
    expect((await computeCardUsage(storage(items, events), 'story'))!.complete).toBe(true);
  });

  it('a sub-card that closed with turns missing makes the parent total incomplete too (review finding)', async () => {
    const withIncompleteChild = items.map((i) => (i.id === 'task-a' ? { ...i, cardUsage: { complete: false } } : i));
    expect((await computeCardUsage(storage(withIncompleteChild, events), 'story'))!.complete).toBe(false);
  });

  it('includes the closing step that is not stored yet, and names the step it closes in', async () => {
    const pending = { step: 'REVIEW2', to: 'DONE', enteredAt: 'a', leftAt: 'b', complete: true, byModel: [], total: { ...zero, turns: 1, input: 3 } };
    const u = await computeCardUsage(storage(items, events), 'story', true, pending as any, 'DONE');
    expect(u!.byStep.map((r) => r.step)).toEqual(['WORK', 'REVIEW', 'REVIEW2']);
    expect(u!.atStatus).toBe('DONE');
  });
});

