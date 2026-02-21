import { describe, it, expect } from 'vitest';
import { formatDuration } from '../components/KanbanBoard';

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
});
