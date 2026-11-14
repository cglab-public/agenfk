/**
 * One clock for the whole rail (CGLAB 50878ebe).
 *
 * Every spinning row had its own `setInterval` at 80ms. `liveAgents.ts` argues
 * against exactly that, two files away and in its own words: "it needs a clock
 * — and one clock for the whole board, not one per card. A busy board with a
 * timer each would wake the renderer hundreds of times independently."
 *
 * The rail then did it per card. Twelve and a half state updates per second
 * per running row: ten sessions is 125 React renders a second, thirty is 375,
 * for as long as the window is in front. That is not a leak, which is why it
 * ranked below the ones that are — but it keeps the renderer permanently off
 * idle, which blocks V8's idle-time collection and holds the compositor awake,
 * in an app whose sessions are meant to run for hours.
 *
 * Tested as a plain subscription rather than through React, because the
 * property that matters — how many timers exist — is invisible from a
 * component and is the whole point.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribeToFrames, FRAME_MS, FRAME_COUNT, SPINNER_FRAMES } from '../sharedTick';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('how many clocks exist', () => {
  it('runs none at all while nobody is watching', () => {
    // An idle board must not wake up. Same rule LiveAgents follows when its
    // last entry expires.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs exactly one, however many rows are spinning', () => {
    /*
     * THE test. Thirty is the app's own cap on terminals, so it is the real
     * worst case rather than a round number — and under the old design it
     * meant thirty timers and 375 renders a second.
     */
    const offs = Array.from({ length: 30 }, () => subscribeToFrames(() => {}));
    expect(vi.getTimerCount()).toBe(1);
    offs.forEach(off => off());
  });

  it('stops once the last watcher leaves', () => {
    const a = subscribeToFrames(() => {});
    const b = subscribeToFrames(() => {});
    a();
    expect(vi.getTimerCount()).toBe(1);   // b is still watching
    b();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts again after it has stopped', () => {
    // Stopping must not be terminal: rows come and go all the time.
    subscribeToFrames(() => {})();
    const off = subscribeToFrames(() => {});
    expect(vi.getTimerCount()).toBe(1);
    off();
  });

  it('does not stop early when the same watcher unsubscribes twice', () => {
    /*
     * React calls an effect's cleanup once, but StrictMode double-invokes and
     * a careless caller can too. Counting unsubscribes instead of tracking
     * them would let a double call stop a clock other rows still need.
     */
    const off = subscribeToFrames(() => {});
    const other = subscribeToFrames(() => {});
    off();
    off();
    expect(vi.getTimerCount()).toBe(1);
    other();
  });
});

describe('what the watchers see', () => {
  it('advances a frame on every tick', () => {
    const seen: number[] = [];
    const off = subscribeToFrames(f => seen.push(f));
    vi.advanceTimersByTime(FRAME_MS * 3);
    expect(seen).toEqual([1, 2, 3]);
    off();
  });

  it('wraps rather than counting upward forever', () => {
    // The frame indexes a fixed array of glyphs. An unbounded counter would
    // read past the end of it.
    const seen: number[] = [];
    const off = subscribeToFrames(f => seen.push(f));
    vi.advanceTimersByTime(FRAME_MS * (FRAME_COUNT + 1));
    expect(Math.max(...seen)).toBeLessThan(FRAME_COUNT);
    off();
  });

  it('gives every watcher the same frame', () => {
    /*
     * Not incidental — it is better than what it replaces. Independent timers
     * drifted apart, so a row of spinners span out of step with each other.
     * One clock puts them in lockstep, which is what a person expects when
     * several things are working at once.
     */
    const a: number[] = [];
    const b: number[] = [];
    const offA = subscribeToFrames(f => a.push(f));
    vi.advanceTimersByTime(FRAME_MS * 2);
    const offB = subscribeToFrames(f => b.push(f));
    vi.advanceTimersByTime(FRAME_MS * 2);
    expect(a.slice(-2)).toEqual(b);
    offA(); offB();
  });

  it('keeps ticking for the others when one watcher throws', () => {
    // One row failing to render must not freeze every other spinner on the
    // board, which is what an unguarded loop over subscribers would do.
    const survived: number[] = [];
    const offBad = subscribeToFrames(() => { throw new Error('render failed'); });
    const offGood = subscribeToFrames(f => survived.push(f));
    expect(() => vi.advanceTimersByTime(FRAME_MS * 2)).not.toThrow();
    expect(survived).toHaveLength(2);
    offBad(); offGood();
  });

  it('does not deliver to a watcher that has left', () => {
    const seen: number[] = [];
    const off = subscribeToFrames(f => seen.push(f));
    const keepAlive = subscribeToFrames(() => {});
    off();
    vi.advanceTimersByTime(FRAME_MS * 3);
    expect(seen).toEqual([]);
    keepAlive();
  });
});

describe('the cadence', () => {
  it('is the one a spinner needs, not an arbitrary number', () => {
    // 80ms is the conventional spinner cadence; slower reads as stuttering.
    // Asserted so that "make it cheaper" cannot quietly become "make it ugly".
    expect(FRAME_MS).toBe(80);
  });
});

describe('the clock and the glyphs agree', () => {
  it('counts exactly as many frames as there are spinner characters', () => {
    /*
     * They now live in one file and the count is DERIVED from the array, so
     * this can no longer drift — which is the point. It stays as the statement
     * of the rule, so that anyone who re-declares the count separately, the
     * way it used to be, finds out here.
     */
    expect(SPINNER_FRAMES).toHaveLength(FRAME_COUNT);
  });

  it('indexes a real glyph for every frame the clock can produce', () => {
    // The failure the two-file version could actually reach: a frame with no
    // character behind it renders `undefined` into the row.
    for (let f = 0; f < FRAME_COUNT; f += 1) expect(SPINNER_FRAMES[f]).toBeTruthy();
  });
});
