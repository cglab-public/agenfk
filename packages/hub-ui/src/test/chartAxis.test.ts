// niceTicks is shared by the activity timeline and the PR volume chart (epic
// 4dbedfe3). Integer counts get integer ticks: a fractional step used to round
// into duplicates for a quiet period (max 1 gave 0,0,0,1,1,1 — duplicate React
// keys and repeated labels).
import { describe, it, expect } from 'vitest';
import { niceTicks } from '../components/chartAxis';

describe('niceTicks', () => {
  it('gives distinct whole-number ticks for a quiet period', () => {
    expect(niceTicks(1)).toEqual([0, 1]);
    expect(niceTicks(2)).toEqual([0, 1, 2]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
  });

  it('has an axis even with nothing to show', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
  });

  it('starts at 0, reaches at least the max, never repeats, in at most seven ticks', () => {
    for (let max = 1; max <= 500; max++) {
      const t = niceTicks(max);
      expect(t[0]).toBe(0);
      expect(t[t.length - 1]).toBeGreaterThanOrEqual(max);
      expect(new Set(t).size).toBe(t.length);
      expect(t.every(Number.isInteger)).toBe(true);
      expect(t.length).toBeLessThanOrEqual(7);
    }
  });
});
