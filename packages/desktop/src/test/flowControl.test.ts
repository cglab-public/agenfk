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
     */
    fc.sent(HIGH_WATERMARK + 10_000);
    fc.acked(9_000);
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
    // The timer must not outlive the pause it was guarding, or it fires
    // against a session that recovered and calls resume on a live socket.
    fc.sent(HIGH_WATERMARK + 1);
    fc.acked(HIGH_WATERMARK + 1);
    expect(resumed).toBe(1);
    vi.advanceTimersByTime(STUCK_MS * 3);
    expect(resumed).toBe(1);
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
    fc.sent(HIGH_WATERMARK + 1);
    fc.dispose();
    vi.advanceTimersByTime(STUCK_MS * 2);
    expect(resumed).toBe(0);
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
