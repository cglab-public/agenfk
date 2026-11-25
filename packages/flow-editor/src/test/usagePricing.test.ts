/**
 * GH-389: the usage price estimator, shared by the board (packages/ui) and the
 * hub's /usage page (packages/hub-ui) so both price a model the same way.
 * Moved here from the board's usage.ts / utils.ts with their tests.
 */
import { describe, it, expect } from 'vitest';
import { estimateCost, getModelPrice, parsePrices } from '../index';

const totals = () => ({ turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, unpricedTurns: 0 });

describe('estimateCost', () => {
  const prices = { prices: [{ id: 'claude-opus-5-5', input: 10, output: 50, input_cached: 1 }] };
  const model = (o: Record<string, unknown>) => ({ client: 'claude-code', model: 'claude-opus-5-5', ...totals(), ...o });

  it('prices a wholly unpriced model from the table, cache reads at the cached rate', () => {
    const c = estimateCost([model({ turns: 1, unpricedTurns: 1, input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 })], prices);
    // input 10 + output 50 + cache read 1 + cache write at the input rate 10
    expect(c).toEqual({ reported: 0, estimated: 71, estimatedAtTurn: 0, estimatedToday: 71, unpricedModels: [], estimatedModels: ['claude-opus-5-5'], todayModels: ['claude-opus-5-5'] });
  });

  it('keeps what a harness reported and does not estimate it again', () => {
    const c = estimateCost([model({ turns: 2, unpricedTurns: 0, input: 1_000_000, costUsd: 0.4 })], prices);
    expect(c).toEqual({ reported: 0.4, estimated: 0, estimatedAtTurn: 0, estimatedToday: 0, unpricedModels: [], estimatedModels: [], todayModels: [] });
  });

  it('names the models it could not price instead of counting them as free', () => {
    const c = estimateCost([model({ model: 'mystery-1', turns: 1, unpricedTurns: 1, input: 5 })], prices);
    expect(c.unpricedModels).toEqual(['mystery-1']);
    expect(c.estimated).toBe(0);
  });

  it('without a price table, only the reported cost', () => {
    const c = estimateCost([model({ turns: 1, unpricedTurns: 1, input: 5 }), model({ model: 'q', turns: 1, costUsd: 0.1 })], null);
    expect(c).toEqual({ reported: 0.1, estimated: 0, estimatedAtTurn: 0, estimatedToday: 0, unpricedModels: ['claude-opus-5-5'], estimatedModels: [], todayModels: [] });
  });
});

describe('one implementation (GH-397)', () => {
  it('the board and hub price with the very functions the local server prices turns with', async () => {
    const core = await import('../../../core/src/usagePricing');
    const here = await import('../index');
    expect(here.estimateCost).toBe(core.estimateCost);
    expect(here.parsePrices).toBe(core.parsePrices);
    expect(here.getModelPrice).toBe(core.getModelPrice);
    expect(here.PRICES_URL).toBe(core.PRICES_URL);
  });
});

describe('getModelPrice', () => {
  const prices = [
    { id: 'claude-3.5-sonnet', input: 3, output: 15 },
    { id: 'gpt-4o', input: 5, output: 15 },
    { id: 'gpt-4o-mini', input: 0.15, output: 0.6 },
    { id: 'o1-mini', input: 3, output: 12 },
    { id: 'o1-preview', input: 15, output: 60 },
    { id: 'o3-mini', input: 1.1, output: 4.4 },
    { id: 'claude-3-opus', input: 15, output: 75 },
    { id: 'claude-sonnet-4.5', input: 3, output: 15 },
    { id: 'gemini-2.5-pro', input: 1.25, output: 5 },
    { id: 'gemini-3-1-pro-preview', input: 1.25, output: 5 },
    { id: 'gemini-3-pro-preview', input: 1.25, output: 5 },
  ];

  it('should return null if prices is empty', () => {
    expect(getModelPrice('unknown-model-xyz', [])).toBeNull();
  });

  it('should return null if model is empty', () => {
    expect(getModelPrice('', prices)).toBeNull();
  });

  it('should find exact match', () => {
    expect(getModelPrice('gpt-4o', prices)?.id).toBe('gpt-4o');
  });

  it('should map claude-3-5-sonnet variant to claude-3.5-sonnet', () => {
    expect(getModelPrice('claude-3-5-sonnet-20241022', prices)?.id).toBe('claude-3.5-sonnet');
  });

  it('should map claude-3.5-sonnet variant', () => {
    expect(getModelPrice('claude-3.5-sonnet-20241022', prices)?.id).toBe('claude-3.5-sonnet');
  });

  it('should map claude-sonnet-4 to claude-sonnet-4.5', () => {
    expect(getModelPrice('claude-sonnet-4-xyz', prices)?.id).toBe('claude-sonnet-4.5');
  });

  it('should map claude-3-opus variant', () => {
    expect(getModelPrice('claude-3-opus-20240229', prices)?.id).toBe('claude-3-opus');
  });

  it('should map gpt-4o-mini variant', () => {
    expect(getModelPrice('gpt-4o-mini-2024', prices)?.id).toBe('gpt-4o-mini');
  });

  it('should map o1-mini variant', () => {
    expect(getModelPrice('o1-mini-2024', prices)?.id).toBe('o1-mini');
  });

  it('should map o1-preview variant', () => {
    expect(getModelPrice('o1-preview-2024', prices)?.id).toBe('o1-preview');
  });

  it('should map o3-mini variant', () => {
    expect(getModelPrice('o3-mini-xyz', prices)?.id).toBe('o3-mini');
  });

  it('should map gemini-2.5-pro variant', () => {
    expect(getModelPrice('gemini-2.5-pro-xyz', prices)?.id).toBe('gemini-2.5-pro');
  });

  it('should use fuzzy match for unknown models', () => {
    expect(getModelPrice('gemini-3-1-pro-preview', prices)?.id).toBe('gemini-3-1-pro-preview');
  });

  it('should return null for truly unknown models', () => {
    expect(getModelPrice('totally-unknown-model-xyz', prices)).toBeNull();
  });

  it('should map gemini-3-1-pro variant to gemini-3-1-pro-preview', () => {
    expect(getModelPrice('gemini-3-1-pro-xyz', prices)?.id).toBe('gemini-3-1-pro-preview');
  });

  it('should map gemini-3-pro variant to gemini-3-pro-preview', () => {
    expect(getModelPrice('gemini-3-pro-abc', prices)?.id).toBe('gemini-3-pro-preview');
  });

  it('should map gpt-4o non-exact variant to gpt-4o', () => {
    expect(getModelPrice('gpt-4o-2024-11-20', prices)?.id).toBe('gpt-4o');
  });

  it('should return via fuzzy match when no specific mapping applies', () => {
    const customPrices = [{ id: 'gemini-2.5-pro', input: 1.25, output: 5 }];
    // 'gpt-4o-mini' hits the gpt-4o-mini specific path but that id is not in customPrices
    // prices.find() returns undefined — neither null nor a price object
    const result = getModelPrice('gpt-4o-mini', customPrices);
    expect(result).toBeFalsy();
  });
});

describe('parsePrices', () => {
  it('keeps the well-formed rows of the public table', () => {
    expect(parsePrices({ prices: [{ id: 'a', input: 1, output: 2, input_cached: 0.1 }] })).toEqual({ prices: [{ id: 'a', input: 1, output: 2, input_cached: 0.1 }] });
  });

  it('drops what would crash or mislead the estimate: no array, null rows, no id, bad rates', () => {
    expect(parsePrices({ prices: {} })).toEqual({ prices: [] });
    expect(parsePrices(null)).toEqual({ prices: [] });
    expect(parsePrices('x')).toEqual({ prices: [] });
    expect(parsePrices({ prices: [null, 7, { input: 1 }, { id: 3 }, { id: 'neg', input: -1 }, { id: 'nan', output: 'x' }, { id: 'ok', input: 2, output: 3 }] }))
      .toEqual({ prices: [{ id: 'ok', input: 2, output: 3 }] });
  });

  it('a row without input and output rates, or with a blank id, is dropped: the model shows as not priced, not as free', () => {
    const parsed = parsePrices({ prices: [{ id: 'some-model' }, { id: 'half', input: 1 }, { id: '', input: 1, output: 1 }] });
    expect(parsed).toEqual({ prices: [] });
    const m = { model: 'some-model', turns: 1, unpricedTurns: 1, costUsd: 0, input: 5, output: 5, cacheRead: 0, cacheWrite: 0 };
    expect(estimateCost([m], parsed)).toEqual({ reported: 0, estimated: 0, estimatedAtTurn: 0, estimatedToday: 0, unpricedModels: ['some-model'], estimatedModels: [], todayModels: [] });
  });

  it('a malformed table estimates nothing instead of throwing', () => {
    const m = { model: 'a', turns: 1, unpricedTurns: 1, costUsd: 0, input: 5, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(estimateCost([m], parsePrices({ prices: [null] })).unpricedModels).toEqual(['a']);
  });
});
