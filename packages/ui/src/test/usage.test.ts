/**
 * GH-389: what the board shows of a card's usage. Built from the per-step rows
 * the server records when the card leaves a step (usageByStep), plus the turns
 * of the step it is in now, which no row covers yet; a closed card shows the
 * total recorded at close, which includes its sub-cards.
 *
 * Cost: what the harnesses reported (pi) plus, only when the board's price
 * table is loaded, an ESTIMATE for models none of whose turns were priced.
 */
import { describe, it, expect } from 'vitest';
import { summarizeCardUsage, estimateCost, abbreviateTokens } from '../usage';
import type { ModelUsage, TokenEvent } from '../types';

type CardArg = Parameters<typeof summarizeCardUsage>[0];
const asCard = (o: object) => o as CardArg;

const totals = (o: Partial<Record<string, number>> = {}) => ({
  turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, unpricedTurns: 0, ...o,
});
const step = (name: string, t: Record<string, number>, byModel: ModelUsage[] = []) =>
  ({ step: name, to: 'X', enteredAt: '2026-11-19T09:00:00.000Z', leftAt: '2026-11-19T10:00:00.000Z', complete: true, byModel, total: totals(t) });
const live = (o: Record<string, unknown> = {}): TokenEvent => ({
  id: Math.random().toString(), ts: '2026-11-19T10:30:00.000Z', client: 'claude-code', sessionId: 's', model: 'claude-opus-5-5',
  input: 1, cachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0, total: 2, ...o,
} as TokenEvent);

describe('summarizeCardUsage', () => {
  it('lists each recorded step, then the current one counted live', () => {
    const item = {
      status: 'REVIEW',
      history: [{ toStatus: 'REVIEW', timestamp: '2026-11-19T10:00:00.000Z' }],
      usageByStep: [step('IN_PROGRESS', { turns: 2, input: 10, output: 5 })],
    };
    const s = summarizeCardUsage(asCard(item), [live({ input: 3 }), live({ input: 4 })]);

    expect(s.steps.map((r) => [r.step, r.live, r.total.turns, r.total.input])).toEqual([
      ['IN_PROGRESS', false, 2, 10],
      ['REVIEW', true, 2, 7],
    ]);
    expect(s.total).toMatchObject({ turns: 4, input: 17 });
    expect(s.measured).toBe(true);
  });

  it('a closed card shows the total recorded at close, which includes its sub-cards', () => {
    const item = {
      status: 'DONE',
      usageByStep: [step('WORK', { turns: 1, input: 5 })],
      cardUsage: { byModel: [], total: totals({ turns: 9, input: 500 }), byStep: [], cards: 3 },
    };
    const s = summarizeCardUsage(asCard(item), []);
    expect(s.total).toMatchObject({ turns: 9, input: 500 });
    expect(s.subCards).toBe(2);
    expect(s.steps.map((r) => r.step)).toEqual(['WORK']);
  });

  it('nothing recorded is "not measured", not a zero', () => {
    const s = summarizeCardUsage(asCard({ status: 'TODO', usageByStep: [] }), []);
    expect(s.measured).toBe(false);
  });

  it('per model, recorded steps and live turns add up', () => {
    const item = {
      status: 'REVIEW',
      history: [{ toStatus: 'REVIEW', timestamp: '2026-11-19T10:00:00.000Z' }],
      usageByStep: [step('IN_PROGRESS', { turns: 1, input: 10 }, [{ client: 'pi', model: 'qwen', ...totals({ turns: 1, input: 10 }) }])],
    };
    const s = summarizeCardUsage(asCard(item), [live({ client: 'pi', model: 'qwen', input: 5 })]);
    expect(s.byModel).toEqual([expect.objectContaining({ client: 'pi', model: 'qwen', turns: 2, input: 15 })]);
  });
});

describe('estimateCost', () => {
  const prices = { prices: [{ id: 'claude-opus-5-5', input: 10, output: 50, input_cached: 1 }] };
  const model = (o: Record<string, unknown>) => ({ client: 'claude-code', model: 'claude-opus-5-5', ...totals(), ...o });

  it('prices a wholly unpriced model from the table, cache reads at the cached rate', () => {
    const c = estimateCost([model({ turns: 1, unpricedTurns: 1, input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 })], prices);
    // input 10 + output 50 + cache read 1 + cache write at the input rate 10
    expect(c).toEqual({ reported: 0, estimated: 71, unpricedModels: [] });
  });

  it('keeps what a harness reported and does not estimate it again', () => {
    const c = estimateCost([model({ turns: 2, unpricedTurns: 0, input: 1_000_000, costUsd: 0.4 })], prices);
    expect(c).toEqual({ reported: 0.4, estimated: 0, unpricedModels: [] });
  });

  it('names the models it could not price instead of counting them as free', () => {
    const c = estimateCost([model({ model: 'mystery-1', turns: 1, unpricedTurns: 1, input: 5 })], prices);
    expect(c.unpricedModels).toEqual(['mystery-1']);
    expect(c.estimated).toBe(0);
  });

  it('without a price table, only the reported cost', () => {
    const c = estimateCost([model({ turns: 1, unpricedTurns: 1, input: 5 }), model({ model: 'q', turns: 1, costUsd: 0.1 })], null);
    expect(c).toEqual({ reported: 0.1, estimated: 0, unpricedModels: ['claude-opus-5-5'] });
  });
});

describe('abbreviateTokens', () => {
  it('reads like the tab label #385 asked for', () => {
    expect(abbreviateTokens(950)).toBe('950');
    expect(abbreviateTokens(42_300)).toBe('42k');
    expect(abbreviateTokens(3_670_000)).toBe('3.7M');
  });
});
