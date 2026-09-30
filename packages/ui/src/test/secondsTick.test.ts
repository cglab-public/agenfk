/**
 * 9569b4d7 — one once-a-second clock for every running verify on the board.
 *
 * Each "Verifying… 1m 12s" badge needs its elapsed time to tick. A timer per
 * badge is what sharedTick.ts was written to undo for the rail's spinners: a
 * busy board wakes the renderer once per card. So the badges share one clock,
 * and an idle board runs none.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribeToSeconds, formatElapsed } from '../secondsTick';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('subscribeToSeconds', () => {
  it('runs no timer while nobody watches, and one however many watch', () => {
    expect(vi.getTimerCount()).toBe(0);
    const a = subscribeToSeconds(() => {});
    const b = subscribeToSeconds(() => {});
    expect(vi.getTimerCount()).toBe(1);
    a();
    expect(vi.getTimerCount()).toBe(1);
    b();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('calls every watcher once a second', () => {
    const seen: number[] = [];
    const stop = subscribeToSeconds(() => seen.push(1));
    vi.advanceTimersByTime(3000);
    expect(seen).toHaveLength(3);
    stop();
    vi.advanceTimersByTime(3000);
    expect(seen).toHaveLength(3);
  });
});

describe('formatElapsed', () => {
  it('reads as seconds, then minutes and seconds, then hours and minutes', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(5_400)).toBe('5s');
    expect(formatElapsed(72_000)).toBe('1m 12s');
    expect(formatElapsed(3_723_000)).toBe('1h 2m');
  });
  it('never shows a negative time for a clock slightly behind the server', () => {
    expect(formatElapsed(-2_000)).toBe('0s');
  });
});
