/**
 * GH-389: the usage of the step a card is leaving. Summed from the token
 * events attributed to the card since it entered that step, after flushing the
 * logs of the sessions that worked on it, so the last turns count.
 *
 * Cost: only what a harness reported itself (pi). A turn without it is counted
 * as unpriced, so a total never passes a partial cost off as complete; the
 * board and hub price those turns from the model and token counts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { TokenEvent } from '@agenfk/core';
import { aggregateUsage, computeStepUsage, describeUsage } from '../usage/stepUsage';

const ev = (over: Partial<TokenEvent> = {}): TokenEvent => ({
  id: Math.random().toString(), ts: '2026-11-19T10:00:00Z', client: 'claude-code', sessionId: 's', model: 'claude-opus-5-5',
  input: 10, cachedInput: 150, cacheRead: 100, cacheWrite: 50, output: 20, reasoning: 0, total: 180,
  sourcePath: '/p', sourceOffset: 0, ...over,
});

describe('aggregateUsage', () => {
  it('sums per client and model, and in total', () => {
    const u = aggregateUsage([ev(), ev(), ev({ client: 'pi', model: 'qwen3.8', costUsd: 0.5 })]);

    expect(u.byModel).toEqual([
      { client: 'claude-code', model: 'claude-opus-5-5', turns: 2, input: 20, cacheRead: 200, cacheWrite: 100, output: 40, reasoning: 0, costUsd: 0, unpricedTurns: 2 },
      { client: 'pi', model: 'qwen3.8', turns: 1, input: 10, cacheRead: 100, cacheWrite: 50, output: 20, reasoning: 0, costUsd: 0.5, unpricedTurns: 0 },
    ]);
    expect(u.total).toEqual({ turns: 3, input: 30, cacheRead: 300, cacheWrite: 150, output: 60, reasoning: 0, costUsd: 0.5, unpricedTurns: 2 });
  });

  it('an event without the read/write split counts its cached input as cache reads (Codex)', () => {
    const u = aggregateUsage([ev({ client: 'codex', cacheRead: undefined, cacheWrite: undefined, cachedInput: 70 })]);
    expect(u.total).toMatchObject({ cacheRead: 70, cacheWrite: 0 });
  });

  it('nothing to sum is zero turns, not an error', () => {
    expect(aggregateUsage([]).total).toEqual({ turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, unpricedTurns: 0 });
  });
});

describe('computeStepUsage', () => {
  const item = {
    id: 'card-1',
    createdAt: '2026-11-19T08:00:00.000Z',
    history: [
      { toStatus: 'IN_PROGRESS', timestamp: '2026-11-19T09:00:00.000Z' },
      { toStatus: 'REVIEW', timestamp: '2026-11-19T09:30:00.000Z' },
      { toStatus: 'IN_PROGRESS', timestamp: '2026-11-19T09:45:00.000Z' }, // rolled back: re-entered
      { toStatus: 'REVIEW', timestamp: '2026-11-19T11:00:00.000Z' }, // the move being recorded
    ],
  };

  function deps(events: TokenEvent[]) {
    return {
      storage: {
        sessionsForItem: vi.fn(async () => [{ client: 'pi', sessionId: 'pi-1' }]),
        queryTokenEvents: vi.fn(async (q: any) => events.filter((e) => e.itemId === q.itemId && e.ts >= q.since && e.ts < q.until)),
      },
      flush: vi.fn(async () => 0),
    };
  }

  it('sums the card events since it LAST entered the step it is leaving, after flushing its sessions', async () => {
    const d = deps([
      ev({ itemId: 'card-1', ts: '2026-11-19T09:10:00.000Z', input: 1000 }), // the earlier visit
      ev({ itemId: 'card-1', ts: '2026-11-19T10:00:00.000Z', input: 7 }),
      ev({ itemId: 'other', ts: '2026-11-19T10:00:00.000Z', input: 99 }),
    ]);

    const u = await computeStepUsage({ ...d, item, from: 'IN_PROGRESS', to: 'REVIEW', at: '2026-11-19T11:00:00.000Z' });

    expect(d.flush).toHaveBeenCalledWith([{ client: 'pi', sessionId: 'pi-1' }]);
    expect(u).toMatchObject({ step: 'IN_PROGRESS', to: 'REVIEW', enteredAt: '2026-11-19T09:45:00.000Z', leftAt: '2026-11-19T11:00:00.000Z', complete: true });
    expect(u.total.input).toBe(7);
  });

  it('a step the card never entered by a recorded move counts from its creation', async () => {
    const d = deps([ev({ itemId: 'card-1', ts: '2026-11-19T08:30:00.000Z', input: 3 })]);
    const u = await computeStepUsage({ ...d, item: { ...item, history: [] }, from: 'TODO', to: 'IN_PROGRESS', at: '2026-11-19T09:00:00.000Z' });
    expect(u.enteredAt).toBe('2026-11-19T08:00:00.000Z');
    expect(u.total.input).toBe(3);
  });

  it('a flush that takes too long does not hold the move: it counts what is there and says it is incomplete', async () => {
    const d = deps([ev({ itemId: 'card-1', ts: '2026-11-19T10:00:00.000Z', input: 7 })]);
    d.flush.mockImplementation(() => new Promise(() => { /* never settles */ }));

    const u = await computeStepUsage({ ...d, item, from: 'IN_PROGRESS', to: 'REVIEW', at: '2026-11-19T11:00:00.000Z', flushTimeoutMs: 20 });

    expect(u.complete).toBe(false);
    expect(u.total.input).toBe(7);
  });

  it('a flush that fails still counts what is there, as incomplete', async () => {
    const d = deps([]);
    d.flush.mockRejectedValue(new Error('EACCES'));
    const u = await computeStepUsage({ ...d, item, from: 'IN_PROGRESS', to: 'REVIEW', at: '2026-11-19T11:00:00.000Z' });
    expect(u.complete).toBe(false);
  });
});

describe('describeUsage', () => {
  it('names the step, the turns and each token kind', () => {
    const line = describeUsage({
      step: 'IN_PROGRESS', to: 'REVIEW', enteredAt: 'a', leftAt: 'b', complete: true,
      byModel: [], total: { turns: 4, input: 1200, cacheRead: 340000, cacheWrite: 5600, output: 8900, reasoning: 0, costUsd: 0, unpricedTurns: 4 },
    });
    expect(line).toMatch(/Usage in IN_PROGRESS/);
    expect(line).toMatch(/4 turns/);
    expect(line).toMatch(/1,200 input/);
    expect(line).toMatch(/340,000 cache read/);
    expect(line).toMatch(/5,600 cache write/);
    expect(line).toMatch(/8,900 output/);
  });

  it('shows the reported cost, and says when some turns are unpriced', () => {
    const line = describeUsage({
      step: 'S', to: 'T', enteredAt: 'a', leftAt: 'b', complete: true,
      byModel: [], total: { turns: 3, input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0, costUsd: 0.4567, unpricedTurns: 1 },
    });
    expect(line).toMatch(/\$0\.46/);
    expect(line).toMatch(/1 turn unpriced/);
  });

  it('says plainly when nothing was measured', () => {
    const line = describeUsage({
      step: 'S', to: 'T', enteredAt: 'a', leftAt: 'b', complete: true,
      byModel: [], total: { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, unpricedTurns: 0 },
    });
    expect(line).toMatch(/no usage recorded/i);
  });

  it('flags an incomplete count', () => {
    const line = describeUsage({
      step: 'S', to: 'T', enteredAt: 'a', leftAt: 'b', complete: false,
      byModel: [], total: { turns: 1, input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0, costUsd: 0, unpricedTurns: 1 },
    });
    expect(line).toMatch(/incomplete/i);
  });
});
