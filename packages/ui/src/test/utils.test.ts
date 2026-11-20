import { describe, it, expect } from 'vitest';
import { formatDuration, calculateCycleTimeMs, stripAnsi, getModelPrice, formatCost } from '../utils';
import { getModelPrice as sharedGetModelPrice } from '@agenfk/flow-editor';

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
    it('is the price lookup the hub shares, not a copy of it', () => {
      expect(getModelPrice).toBe(sharedGetModelPrice);
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
