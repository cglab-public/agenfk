/**
 * @vitest-environment node
 *
 * Backpressure between the pty and the terminal (CGLAB b69adb45).
 *
 * There was none. The pty read at tty speed, every chunk was forwarded to the
 * renderer immediately, and xterm absorbed the difference as retained memory:
 * its own WriteBuffer holds up to 50 MB of unparsed output before it starts
 * discarding, and its source says it becomes unresponsive a hundred times
 * below that. At thirty terminals the ceiling is over a gigabyte — but the
 * window locks up long before that, which is worse, because it reads as a hang
 * rather than as a leak.
 *
 * This is the accounting half, kept apart from the pty so it can be tested as
 * arithmetic: how many bytes are in flight, and when does that mean stop.
 *
 * THE DANGEROUS DIRECTION IS PAUSED-FOREVER, not paused-too-often. A terminal
 * that stutters is a nuisance; a pty that is never resumed is an agent frozen
 * mid-task with no error anywhere. Most of what follows is about that.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FlowControl, HIGH_WATERMARK, LOW_WATERMARK, STUCK_MS } from '../main/flowControl';

let paused: number;
let resumed: number;
let fc: FlowControl;

beforeEach(() => {
  vi.useFakeTimers();
  paused = 0;
  resumed = 0;
  fc = new FlowControl({ pause: () => { paused += 1; }, resume: () => { resumed += 1; } });
});

afterEach(() => {
  fc.dispose();
  vi.useRealTimers();
});

describe('the watermarks', () => {
  it('lets ordinary output through untouched', () => {
    // The common case by far. A prompt, a line of output, a spinner frame:
    // none of that should ever involve the flow-control machinery.
    fc.sent(2_000);
    expect(paused).toBe(0);
  });

  it('pauses once more is in flight than the terminal can be holding', () => {
    fc.sent(HIGH_WATERMARK + 1);
    expect(paused).toBe(1);
  });

  it('does not pause a second time while already paused', () => {
    // `pause()` on an already-paused socket is harmless, but calling it per
    // chunk of a firehose is thousands of no-op syscalls a second.
    fc.sent(HIGH_WATERMARK + 1);
    fc.sent(50_000);
    fc.sent(50_000);
    expect(paused).toBe(1);
  });

  it('stays paused while the terminal is still behind', () => {
    /*
     * Hysteresis, and the reason there are two marks rather than one. Resuming
     * the moment it drops below the HIGH mark would put it straight back over
     * on the next chunk — pause, resume, pause, resume, at the rate output
     * arrives, which costs more than having no flow control at all.
     *
     * The ack must land the count squarely BETWEEN the two marks, and the
     * first version of this test did not: it acked 9 000 of HIGH + 10 000,
     * leaving the count above both. Nothing in the file ever occupied the gap,
     * so the second watermark — the headline design decision — had no test at
     * all, and deleting it kept every test green.
     */
    fc.sent(HIGH_WATERMARK + 10_000);
    fc.acked(HIGH_WATERMARK - LOW_WATERMARK);      // now between LOW and HIGH
    expect(resumed).toBe(0);
  });

  it('resumes when the terminal has caught up', () => {
    fc.sent(HIGH_WATERMARK + 1);
    fc.acked(HIGH_WATERMARK + 1 - LOW_WATERMARK + 1);
    expect(resumed).toBe(1);
  });

  it('does not resume something that was never paused', () => {
    // Acks arrive constantly during normal output. None of them is an event.
    fc.sent(1_000);
    fc.acked(1_000);
    expect(resumed).toBe(0);
    expect(paused).toBe(0);
  });
});

describe('when the renderer stops answering', () => {
  it('resumes anyway rather than freezing the agent', () => {
    /*
     * THE failure this design could introduce, and it is worse than the
     * problem being fixed. The ack has to cross an IPC boundary, and the
     * renderer can stop sending: a hung window, a pane torn down while its
     * session lives, a reload landing between write and callback. Without
     * this the pty stays paused forever and the agent is frozen mid-task,
     * silently, with no error on any screen.
     *
     * A stuttering terminal is a nuisance. A frozen agent is lost work, so
     * when the two are in tension this chooses the nuisance.
     */
    fc.sent(HIGH_WATERMARK + 1);
    expect(paused).toBe(1);
    vi.advanceTimersByTime(STUCK_MS + 100);
    expect(resumed).toBe(1);
  });

  it('gives it the full grace period each time it makes progress', () => {
    // A renderer that is merely SLOW is not a stuck one. Any ack is proof of
    // life and should buy the full window again, or a busy terminal would be
    // force-resumed on a fixed schedule while it was working perfectly.
    fc.sent(HIGH_WATERMARK + 20_000);
    vi.advanceTimersByTime(STUCK_MS - 1_000);
    fc.acked(1_000);
    vi.advanceTimersByTime(STUCK_MS - 1_000);
    expect(resumed).toBe(0);
  });

  it('stops watching once it resumes on its own', () => {
    /*
     * Asserted on the TIMER, not on the resume count, and that is the whole
     * difference between this test and the decorative one it replaces. A
     * stale valve firing against a released session is a no-op — the guard
     * inside it sees `paused` is false — so the leak is invisible through the
     * pause/resume callbacks. What it is not invisible to is the timer itself:
     * one left pending per recovered session, each holding ten seconds.
     */
    fc.sent(HIGH_WATERMARK + 1);
    fc.acked(HIGH_WATERMARK + 1);
    expect(resumed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('arithmetic that has to survive a real stream', () => {
  it('never lets the count go negative', () => {
    /*
     * Acks and exits race across a process boundary. An ack for a chunk sent
     * before a reset, or a double ack, would drive the count below zero — and
     * then a genuinely overloaded terminal would never reach the high mark
     * again, which is silent: flow control simply stops working.
     */
    fc.sent(1_000);
    fc.acked(5_000);
    fc.sent(HIGH_WATERMARK + 1);
    expect(paused).toBe(1);
  });

  it('ignores a chunk of nothing', () => {
    fc.sent(0);
    fc.acked(0);
    expect(paused).toBe(0);
    expect(resumed).toBe(0);
  });

  it('counts a long burst cumulatively, not per chunk', () => {
    // The real shape of a firehose: thousands of small reads, none of which
    // is anywhere near the mark on its own.
    for (let i = 0; i < 200; i += 1) fc.sent(1_000);
    expect(paused).toBe(1);
  });
});

describe('shutting down', () => {
  it('drops its timer, so a dead session cannot fire one', () => {
    // Same correction: the count is what proves it. A disposed session that
    // left its valve armed holds a ten second timer for a process that no
    // longer exists, and nothing in the callbacks would ever show it.
    fc.sent(HIGH_WATERMARK + 1);
    expect(vi.getTimerCount()).toBe(1);
    fc.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is safe to dispose twice', () => {
    fc.dispose();
    expect(() => fc.dispose()).not.toThrow();
  });
});

describe('the constants themselves', () => {
  it('keeps the high mark far below where xterm becomes unresponsive', () => {
    /*
     * Not a tautology — it is the number the whole design is aimed at. xterm's
     * own source puts DISCARD_WATERMARK at 50 MB and says it "gets unresponsive
     * with a 100 times lower number (>500 kB)". A high mark at or above that is
     * flow control that permits the freeze it exists to prevent.
     */
    expect(HIGH_WATERMARK).toBeLessThan(500 * 1024);
  });

  it('leaves real room between the marks', () => {
    // Too close together and the hysteresis above is decorative: it would
    // flap on a single chunk.
    expect(LOW_WATERMARK).toBeLessThan(HIGH_WATERMARK / 2);
  });
});

/**
 * Drift, and why the valve alone is not enough (review follow-up).
 *
 * The accounting can acquire a permanent floor: bytes main counted that the
 * renderer will never ack. The obvious source is an older preload with no
 * `ack` method at all, paired with a newer bundle — a real pairing after a
 * partial install, and one the pane deliberately tolerates rather than
 * throwing, because a blank terminal is worse than no backpressure.
 *
 * Once that floor exceeds LOW_WATERMARK the session cannot recover by acking,
 * and the valve does NOT save it: releasing leaves the count above HIGH, so
 * the very next chunk re-pauses and re-arms. Measured against this class, a
 * 40 KB floor took throughput from ~8 MB/s to ~18 KB/s — one chunk every ten
 * seconds, forever. "A stuttering terminal is a nuisance" was the wrong
 * description of that; it is a frozen agent that still looks alive.
 *
 * So the valve firing has to mean more than "release once". It is the signal
 * that the ack path is not working, and a count nobody is decrementing is
 * worse than no count at all.
 */
describe('when the acks never come back at all', () => {
  it('does not fall into a pause-per-chunk crawl', () => {
    /*
     * The regression test for the cliff. A renderer that acks NOTHING is the
     * worst case; if throughput survives that, it survives any partial drift.
     * Twenty bursts, each far over the high mark, and the valve given time to
     * fire between them: the count must not be carrying the whole history.
     */
    for (let i = 0; i < 20; i += 1) {
      fc.sent(HIGH_WATERMARK + 1);
      vi.advanceTimersByTime(STUCK_MS + 10);
    }
    // One pause and one release per burst, rather than a permanently paused
    // pty crawling forward one chunk per grace period.
    expect(resumed).toBe(20);
    expect(paused).toBe(20);
  });

  it('forgets the backlog when it gives up on it', () => {
    /*
     * The mechanism that makes the above true, stated directly. After the
     * valve fires, the outstanding count is known to be untrustworthy — those
     * bytes were drawn, or they were lost with the renderer, and either way
     * nobody is going to ack them. Keeping them would poison every future
     * measurement, which is exactly the cliff.
     *
     * Checked from the outside: a single further chunk, far below the high
     * mark, must not re-pause. It would if the old backlog were still counted.
     */
    fc.sent(HIGH_WATERMARK * 4);
    vi.advanceTimersByTime(STUCK_MS + 10);
    expect(resumed).toBe(1);

    fc.sent(1_000);
    expect(paused).toBe(1);
  });

  it('still pauses again for a genuinely new backlog', () => {
    // Forgetting must not disable the feature. After the reset, a fresh burst
    // over the mark pauses as it always would.
    fc.sent(HIGH_WATERMARK + 1);
    vi.advanceTimersByTime(STUCK_MS + 10);
    fc.sent(HIGH_WATERMARK + 1);
    expect(paused).toBe(2);
  });
});

describe('letting go of a session', () => {
  it('unpauses the pty on the way out', () => {
    /*
     * A paused node-pty socket loses data on destroy: the exit path waits for
     * the socket to close and, failing that, destroys it after 200ms — and
     * destroy on a paused stream discards the read buffer. So a child that
     * exits while paused loses whatever it wrote last, a window that did not
     * exist before flow control. Disposing has to hand the socket back first.
     */
    fc.sent(HIGH_WATERMARK + 1);
    expect(paused).toBe(1);
    fc.dispose();
    expect(resumed).toBe(1);
  });

  it('does not resume a session that was never paused', () => {
    fc.sent(1_000);
    fc.dispose();
    expect(resumed).toBe(0);
  });

  it('stays quiet if data arrives after it is gone', () => {
    /*
     * node-pty's own comment: "Sometimes a data event is emitted after exit."
     * Re-pausing a dead pty and arming a ten second timer for it is pure
     * waste, and it contradicts what dispose says it does.
     */
    fc.dispose();
    fc.sent(HIGH_WATERMARK * 3);
    expect(paused).toBe(0);
    vi.advanceTimersByTime(STUCK_MS * 2);
    expect(resumed).toBe(0);
  });
});
