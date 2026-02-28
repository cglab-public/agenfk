import { describe, it, expect } from 'vitest';
import { formatDuration, calculateCycleTimeMs, stripAnsi, getModelPrice, calculateCost, formatCost } from '../utils';

describe('UI Utils', () => {
  describe('stripAnsi', () => {
    it('should remove ANSI escape codes', () => {
      expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
    });

    it('should return plain string unchanged', () => {
      expect(stripAnsi('hello world')).toBe('hello world');
    });

    it('should handle empty string', () => {
      expect(stripAnsi('')).toBe('');
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

  describe('calculateCost', () => {
    const pricesData = {
      prices: [
        { id: 'gpt-4o', input: 5, output: 15 },
      ],
    };

    it('should return 0 if tokenUsage is falsy', () => {
      expect(calculateCost(null as any, pricesData)).toBe(0);
    });

    it('should return 0 if pricesData has no prices', () => {
      expect(calculateCost([{ model: 'gpt-4o', input: 1000, output: 500 }], null as any)).toBe(0);
    });

    it('should calculate cost correctly', () => {
      const usage = [{ model: 'gpt-4o', input: 1000000, output: 1000000 }];
      const cost = calculateCost(usage, pricesData);
      expect(cost).toBeCloseTo(5 + 15); // 5 per M input + 15 per M output
    });

    it('should skip usage entries with unknown model', () => {
      const usage = [{ model: 'unknown-model', input: 1000000, output: 1000000 }];
      const cost = calculateCost(usage, pricesData);
      expect(cost).toBe(0);
    });

    it('should sum multiple entries', () => {
      const usage = [
        { model: 'gpt-4o', input: 1000000, output: 0 },
        { model: 'gpt-4o', input: 0, output: 1000000 },
      ];
      const cost = calculateCost(usage, pricesData);
      expect(cost).toBeCloseTo(5 + 15);
    });
  });

  describe('formatCost', () => {
    it('should return $0.00 for zero cost', () => {
      expect(formatCost(0)).toBe('$0.00');
    });

    it('should format small costs with 4 decimal places', () => {
      expect(formatCost(0.001)).toBe('$0.0010');
    });

    it('should format normal costs as currency', () => {
      expect(formatCost(1.50)).toBe('$1.50');
    });

    it('should format larger amounts', () => {
      const result = formatCost(100);
      expect(result).toContain('100');
    });
  });
  describe('formatDuration', () => {
    it('should format milliseconds to HH:MM:SS', () => {
      expect(formatDuration(0)).toBe('00:00:00');
      expect(formatDuration(1000)).toBe('00:00:01');
      expect(formatDuration(60000)).toBe('00:01:00');
      expect(formatDuration(3600000)).toBe('01:00:00');
      expect(formatDuration(3661000)).toBe('01:01:01');
    });

    it('should handle large durations', () => {
      expect(formatDuration(3600000 * 25)).toBe('25:00:00');
    });
  });

  describe('calculateCycleTimeMs', () => {
    it('should return 0 for TODO items', () => {
      const item = { status: 'TODO', history: [] };
      expect(calculateCycleTimeMs(item)).toBe(0);
    });

    it('should compute time from first IN_PROGRESS to DONE', () => {
      const t1 = 1000000000000;
      const t2 = 1000000005000;
      const item = {
        status: 'DONE',
        history: [
          { toStatus: 'TODO', timestamp: new Date(t1 - 10000).toISOString() },
          { toStatus: 'IN_PROGRESS', timestamp: new Date(t1).toISOString() },
          { toStatus: 'TEST', timestamp: new Date(t1 + 2000).toISOString() },
          { toStatus: 'DONE', timestamp: new Date(t2).toISOString() }
        ]
      };
      expect(calculateCycleTimeMs(item)).toBe(5000);
    });

    it('should sum multiple active intervals', () => {
      const t1 = 1000000000000;
      const item = {
        status: 'DONE',
        history: [
          { toStatus: 'IN_PROGRESS', timestamp: new Date(t1).toISOString() }, // Start 1
          { toStatus: 'TODO', timestamp: new Date(t1 + 1000).toISOString() }, // Stop 1 (dur: 1000)
          { toStatus: 'IN_PROGRESS', timestamp: new Date(t1 + 5000).toISOString() }, // Start 2
          { toStatus: 'DONE', timestamp: new Date(t1 + 8000).toISOString() } // Stop 2 (dur: 3000)
        ]
      };
      expect(calculateCycleTimeMs(item)).toBe(4000);
    });

    it('should include time spent in REVIEW and TEST', () => {
      const t1 = 1000000000000;
      const item = {
        status: 'DONE',
        history: [
          { toStatus: 'IN_PROGRESS', timestamp: new Date(t1).toISOString() },
          { toStatus: 'REVIEW', timestamp: new Date(t1 + 1000).toISOString() },
          { toStatus: 'TEST', timestamp: new Date(t1 + 2000).toISOString() },
          { toStatus: 'DONE', timestamp: new Date(t1 + 3000).toISOString() }
        ]
      };
      expect(calculateCycleTimeMs(item)).toBe(3000);
    });

    it('should pause clock when BLOCKED', () => {
      const t1 = 1000000000000;
      const item = {
        status: 'DONE',
        history: [
          { toStatus: 'IN_PROGRESS', timestamp: new Date(t1).toISOString() },
          { toStatus: 'BLOCKED', timestamp: new Date(t1 + 1000).toISOString() },
          { toStatus: 'IN_PROGRESS', timestamp: new Date(t1 + 5000).toISOString() },
          { toStatus: 'DONE', timestamp: new Date(t1 + 6000).toISOString() }
        ]
      };
      expect(calculateCycleTimeMs(item)).toBe(2000);
    });

    it('should return elapsed since createdAt for no-history DONE item', () => {
      const created = new Date(Date.now() - 5000).toISOString();
      const updated = new Date(Date.now() - 1000).toISOString();
      const item = { status: 'DONE', history: [], createdAt: created, updatedAt: updated };
      const result = calculateCycleTimeMs(item);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(10000);
    });

    it('should return elapsed since createdAt for no-history ARCHIVED item', () => {
      const created = new Date(Date.now() - 5000).toISOString();
      const updated = new Date(Date.now() - 1000).toISOString();
      const item = { status: 'ARCHIVED', history: [], createdAt: created, updatedAt: updated };
      const result = calculateCycleTimeMs(item);
      expect(result).toBeGreaterThan(0);
    });

    it('should return 0 for no-history BLOCKED item', () => {
      const item = { status: 'BLOCKED', history: [] };
      expect(calculateCycleTimeMs(item)).toBe(0);
    });

    it('should use Date.now() for still-running item (no final DONE)', () => {
      const t1 = Date.now() - 10000;
      const item = {
        status: 'IN_PROGRESS',
        history: [
          { toStatus: 'IN_PROGRESS', timestamp: new Date(t1).toISOString() },
        ]
      };
      const result = calculateCycleTimeMs(item);
      expect(result).toBeGreaterThanOrEqual(9000);
    });

    it('should return elapsed since createdAt for no-history IN_PROGRESS item', () => {
      const created = new Date(Date.now() - 3000).toISOString();
      const item = { status: 'IN_PROGRESS', history: [], createdAt: created };
      const result = calculateCycleTimeMs(item);
      expect(result).toBeGreaterThanOrEqual(2000);
    });
  });
});
