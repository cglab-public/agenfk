/**
 * @vitest-environment jsdom
 *
 * Which cards have an agent working on them right now (CGLAB-170).
 *
 * The obvious implementation is wrong, and it is worth saying why here so
 * nobody re-derives it. `AgentRun.status` exists and has a `'running'` value —
 * but BUG df4b3343 records that the hook never issues the closing
 * `PATCH /agent-runs/:id`, so `status` stays `'running'` and `endedAt` stays
 * null forever. Every card that ever had a run would light up permanently,
 * trading one uninformative indicator for another.
 *
 * So liveness is derived from the RECENCY of run events instead. That is a
 * truer statement anyway — "an agent touched this a moment ago" is what the
 * user wants to know, and a stalled agent stops glowing on its own, which no
 * status field would do.
 *
 * The hard part is not lighting up. It is going dark: that has to happen with
 * no further event arriving, which means a timer, and it must not mean one
 * timer per card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LiveAgents, LIVE_TTL_MS } from '../liveAgents';

let live: LiveAgents;

beforeEach(() => {
  vi.useFakeTimers();
  live = new LiveAgents();
});
afterEach(() => {
  live.dispose();
  vi.useRealTimers();
});

describe('what counts as live', () => {
  it('starts with nothing lit', () => {
    expect(live.isLive('i1')).toBe(false);
    expect(live.liveIds()).toEqual([]);
  });

  it('lights a card when a run event arrives for it', () => {
    live.touch('i1');
    expect(live.isLive('i1')).toBe(true);
  });

  it('lights only that card', () => {
    live.touch('i1');
    expect(live.isLive('i2')).toBe(false);
  });

  it('goes dark after the TTL with no further event', () => {
    // The assertion that makes this an indicator rather than a permanent mark.
    // A stalled agent has to stop glowing by itself.
    live.touch('i1');
    vi.advanceTimersByTime(LIVE_TTL_MS + 100);
    expect(live.isLive('i1')).toBe(false);
  });

  it('stays lit while events keep arriving', () => {
    live.touch('i1');
    vi.advanceTimersByTime(LIVE_TTL_MS * 0.6);
    live.touch('i1');
    vi.advanceTimersByTime(LIVE_TTL_MS * 0.6);
    expect(live.isLive('i1'), 'a second event did not restart the countdown').toBe(true);
  });

  it('expires each card on its own schedule', () => {
    live.touch('i1');
    vi.advanceTimersByTime(LIVE_TTL_MS * 0.8);
    live.touch('i2');
    vi.advanceTimersByTime(LIVE_TTL_MS * 0.4);
    expect(live.isLive('i1')).toBe(false);
    expect(live.isLive('i2')).toBe(true);
  });
});

describe('telling the UI something changed', () => {
  it('notifies when a card lights up', () => {
    const seen: string[][] = [];
    live.subscribe(() => seen.push(live.liveIds()));
    live.touch('i1');
    expect(seen.at(-1)).toEqual(['i1']);
  });

  it('notifies when a card goes dark', () => {
    // Without this the dot never disappears on screen, however correct the
    // internal state is — going dark is driven by time, not by a render.
    const seen: string[][] = [];
    live.touch('i1');
    live.subscribe(() => seen.push(live.liveIds()));
    vi.advanceTimersByTime(LIVE_TTL_MS + 100);
    expect(seen.at(-1)).toEqual([]);
  });

  it('does not notify for a repeat event on an already-live card', () => {
    // An agent emits events constantly. Re-rendering the whole board on each
    // one, when nothing visible changed, is the difference between an
    // indicator and a performance problem.
    live.touch('i1');
    const seen: unknown[] = [];
    live.subscribe(() => seen.push(1));
    live.touch('i1');
    live.touch('i1');
    expect(seen).toHaveLength(0);
  });

  it('notifies when a card that had gone dark lights up again', () => {
    /*
     * The gap between KNOWN and LIVE, which is where this used to be wrong:
     * the guard read `lastSeen.has(itemId)` — presence — while being named
     * `wasLive`. So a card that had gone dark but was still in the map counted
     * as "already lit", nobody was told it came back, and anything derived
     * from `liveIds()` stayed staler than `isLive()`.
     *
     * The window has to be BUILT, and the first version of this test did not
     * build it — it expired the entry right onto a sweep tick, which deletes
     * it, leaving `has()` and `isLive()` agreeing and the test passing against
     * the bug. Sweeps are phased from the FIRST touch, so touching another
     * card first and then offsetting by a millisecond puts i1's expiry between
     * two ticks: at 90001ms it is expired, and the sweep that would remove it
     * does not run until 95000ms.
     */
    live.touch('other');           // starts the sweep clock, ticking at +5s
    vi.advanceTimersByTime(1);     // i1 now expires 1ms AFTER a tick
    live.touch('i1');
    vi.advanceTimersByTime(LIVE_TTL_MS + 2_000);
    expect(live.isLive('i1')).toBe(false);
    expect(live.size()).toBe(1);   // expired, and still in the map: the window

    const seen: string[][] = [];
    live.subscribe(() => seen.push(live.liveIds()));
    live.touch('i1');
    expect(seen.at(-1)).toEqual(['i1']);
  });

  it('stops notifying once unsubscribed', () => {
    const seen: unknown[] = [];
    const off = live.subscribe(() => seen.push(1));
    off();
    live.touch('i1');
    expect(seen).toHaveLength(0);
  });
});

describe('cost', () => {
  it('uses one timer for the whole board, not one per card', () => {
    // A timer per card means hundreds of them on a busy board, each waking the
    // renderer independently.
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    const setTimeout = vi.spyOn(globalThis, 'setTimeout');
    for (let i = 0; i < 50; i += 1) live.touch(`item-${i}`);
    const timers = setInterval.mock.calls.length + setTimeout.mock.calls.length;
    expect(timers, `created ${timers} timers for 50 cards`).toBeLessThanOrEqual(1);
    setInterval.mockRestore();
    setTimeout.mockRestore();
  });

  it('stops its timer when nothing is live', () => {
    // Otherwise an idle board wakes up forever for no reason.
    const clear = vi.spyOn(globalThis, 'clearInterval');
    live.touch('i1');
    vi.advanceTimersByTime(LIVE_TTL_MS + 100);
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('forgets cards that went dark, rather than growing forever', () => {
    for (let i = 0; i < 100; i += 1) live.touch(`item-${i}`);
    vi.advanceTimersByTime(LIVE_TTL_MS + 100);
    expect(live.size()).toBe(0);
  });

  it('releases everything on dispose', () => {
    live.touch('i1');
    live.dispose();
    expect(live.liveIds()).toEqual([]);
  });
});
