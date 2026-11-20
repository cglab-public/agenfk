/**
 * GH-397: one pricing implementation for the local server (which prices each
 * turn when it is ingested) and the board and hub (which add the stored prices
 * up, and price only older usage that has none, at today's prices).
 */
import { describe, it, expect } from 'vitest';
import { addCostViews, costTotal, estimateCost, getModelPrice, parsePrices, priceTokens } from '../usagePricing';

const table = { prices: [{ id: 'claude-opus-5-5', input: 10, output: 50, input_cached: 1 }] };
const row = (o: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5-5', turns: 1, unpricedTurns: 0, costUsd: 0, estimatedCostUsd: 0,
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...o,
});

describe('priceTokens', () => {
  it('prices one turn from the table: cache reads at the cached rate, cache writes at the input rate', () => {
    const c = priceTokens('claude-opus-5-5', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, table);
    expect(c).toBe(71);
  });

  it('is null for a model the table does not know, and without a table', () => {
    expect(priceTokens('mystery-1', { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }, table)).toBeNull();
    expect(priceTokens('claude-opus-5-5', { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }, null)).toBeNull();
  });

  it('a turn of zero tokens of a known model costs zero, not null', () => {
    expect(priceTokens('claude-opus-5-5', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, table)).toBe(0);
  });
});

describe('getModelPrice: a stored price must be the model\'s own (review finding)', () => {
  const rows = (order: string[]) => ({ prices: order.map(id => ({ id, input: id.length, output: 1 })) });
  const ids = ['claude-sonnet-4', 'claude-sonnet-4.5', 'claude-opus-4', 'claude-opus-4-8'];

  it('a dated id is priced as its undated model, not as a later version', () => {
    for (const order of [ids, [...ids].reverse()]) {
      expect(getModelPrice('claude-sonnet-4-20250514', rows(order).prices)?.id).toBe('claude-sonnet-4');
    }
  });

  it('a provider-prefixed, dated id is priced as its own model (second review)', () => {
    for (const order of [ids, [...ids].reverse()]) {
      expect(getModelPrice('anthropic/claude-sonnet-4-20250514', rows(order).prices)?.id).toBe('claude-sonnet-4');
      expect(getModelPrice('us.anthropic.claude-sonnet-4-20250514', rows(order).prices)?.id).toBe('claude-sonnet-4');
      expect(getModelPrice('us.anthropic.claude-sonnet-4-20250514-v1:0', rows(order).prices)?.id).toBe('claude-sonnet-4');
    }
  });

  it('a version written in dashes finds the table row written in dots', () => {
    expect(getModelPrice('claude-sonnet-4-5-20250929', rows(ids).prices)?.id).toBe('claude-sonnet-4.5');
  });

  it('the fuzzy match takes the longest id the name holds, whatever the table order', () => {
    for (const order of [ids, [...ids].reverse()]) {
      expect(getModelPrice('us.anthropic.claude-opus-4-8-v1', rows(order).prices)?.id).toBe('claude-opus-4-8');
    }
  });
});

describe('parsePrices', () => {
  it('a row whose cached rate is null (the public table writes null) is kept and prices cache reads at the input rate', () => {
    const parsed = parsePrices({ prices: [{ id: 'gpt-5-pro', input: 15, output: 120, input_cached: null }] });
    expect(parsed.prices).toHaveLength(1);
    expect(priceTokens('gpt-5-pro', { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, parsed)).toBe(15);
  });
});

describe('estimateCost with stored estimates', () => {
  it('adds the estimate stored when the turns were used, and prices nothing again', () => {
    const c = estimateCost([row({ turns: 3, estimatedCostUsd: 1.25, input: 1_000_000 })], table);
    expect(c).toEqual({
      reported: 0, estimated: 1.25, estimatedAtTurn: 1.25, estimatedToday: 0,
      unpricedModels: [], estimatedModels: ['claude-opus-5-5'], todayModels: [],
    });
  });

  it('a stored estimate needs no price table: the figure is the same with the table unavailable', () => {
    const rows = [row({ turns: 2, estimatedCostUsd: 0.5 }), row({ model: 'qwen', turns: 1, costUsd: 0.25 })];
    expect(costTotal(estimateCost(rows, null))).toBe(0.75);
    expect(costTotal(estimateCost(rows, table))).toBe(0.75);
  });

  it('older usage with neither price is priced at today\'s prices and counted apart', () => {
    const c = estimateCost([row({ turns: 1, unpricedTurns: 1, input: 1_000_000 })], table);
    expect(c.estimatedAtTurn).toBe(0);
    expect(c.estimatedToday).toBe(10);
    expect(c.estimated).toBe(10);
    expect(c.todayModels).toEqual(['claude-opus-5-5']);
  });

  it('a model with some turns priced when used and some older ones keeps the stored part and names the model as not priced (review finding: turns do not tell their tokens)', () => {
    // One older turn may have used 1M tokens and three new ones a thousand: a share by turn count would misprice it.
    const c = estimateCost([row({ turns: 4, unpricedTurns: 1, estimatedCostUsd: 2, input: 4_000_000 })], table);
    expect(c.estimatedAtTurn).toBe(2);
    expect(c.estimatedToday).toBe(0);
    expect(costTotal(c)).toBe(2);
    expect(c.unpricedModels).toEqual(['claude-opus-5-5']);
  });

  it('a missing estimatedCostUsd (an older event) counts as zero', () => {
    const { estimatedCostUsd: _drop, ...older } = row({ turns: 1, costUsd: 0.3 });
    const c = estimateCost([older as any], table);
    expect(c.estimatedAtTurn).toBe(0);
    expect(costTotal(c)).toBe(0.3);
  });

  it('numbers that arrive as strings (Postgres json) are read as numbers', () => {
    const c = estimateCost([row({ turns: '2', estimatedCostUsd: '0.5', costUsd: '0.25' }) as any], table);
    expect(costTotal(c)).toBe(0.75);
  });
});

describe('addCostViews', () => {
  it('adds every part and names each model once', () => {
    const a = estimateCost([row({ estimatedCostUsd: 1 })], table);
    const b = estimateCost([row({ unpricedTurns: 1, input: 1_000_000 }), row({ model: 'q', costUsd: 2 })], table);
    const s = addCostViews(a, b);
    expect(s).toEqual({
      reported: 2, estimated: 11, estimatedAtTurn: 1, estimatedToday: 10,
      unpricedModels: [], estimatedModels: ['claude-opus-5-5'], todayModels: ['claude-opus-5-5'],
    });
    expect(costTotal(s)).toBe(13);
  });
});
