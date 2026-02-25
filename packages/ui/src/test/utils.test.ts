import { describe, it, expect } from 'vitest';
import { formatDuration } from '../components/KanbanBoard';
import { calculateCycleTimeMs } from '../utils';

describe('UI Utils', () => {
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
  });
});
