/**
 * Backpressure between a pty and the terminal drawing it.
 *
 * There was none. node-pty read at tty speed, every chunk was forwarded to the
 * renderer the moment it arrived, and xterm absorbed the whole difference as
 * retained memory. Its `WriteBuffer` holds up to 50 MB of unparsed output and
 * then THROWS — `write data discarded, use flow control to avoid losing data`
 * (WriteBuffer.ts:105), not a silent truncation, and nothing on our side
 * catches it, so the ceiling was reached as an uncaught exception inside an
 * ipcRenderer listener. Long before that its own source says it "gets
 * unresponsive with a 100 times lower number (>500 kB)". At this app's cap of
 * thirty terminals the ceiling is over a gigabyte — but the window locks up
 * well before it, which is the worse outcome, because a freeze reads as a hang
 * rather than as the memory problem it is.
 *
 * The producer can be stopped: node-pty exposes `pause()`/`resume()` for
 * exactly this. What was missing is knowing WHEN, and that is all this file
 * does — count the bytes handed to the renderer, subtract the ones it says it
 * has drawn, and call a halt when the difference gets large.
 *
 * Kept apart from the pty so the decision is arithmetic and can be tested as
 * arithmetic. The registry owns the wiring; this owns the judgement.
 *
 * ONE DIRECTION IS MUCH WORSE THAN THE OTHER. Pausing too eagerly makes a
 * terminal stutter. Failing to resume freezes the agent mid-task, in silence,
 * with no error on any screen — and the ack has to cross a process boundary to
 * get here, so "it never arrives" is a real state and not a hypothetical. The
 * grace period below exists for that, and it resolves the tension towards the
 * nuisance every time.
 */

/**
 * Stop reading once this many bytes are in flight and undrawn.
 *
 * 128 KB: comfortably above any single burst a terminal handles without
 * noticing, and a quarter of the ~500 KB where xterm's own source says it
 * becomes unresponsive. A mark at or above that number would be flow control
 * that still permits the freeze it exists to prevent.
 */
export const HIGH_WATERMARK = 128 * 1024;

/**
 * Start reading again once it falls back to this.
 *
 * A second mark rather than reusing the first, because resuming as soon as it
 * dipped below HIGH would put it back over on the very next chunk: pause and
 * resume at the rate output arrives, which costs more than having no flow
 * control at all.
 */
export const LOW_WATERMARK = 32 * 1024;

/**
 * How long a pause may go without any progress before it is abandoned.
 *
 * The safety valve, and the most important number here. The renderer might
 * never ack — a hung window, a pane torn down while its session lives, a
 * reload landing between `write` and its callback. Waiting forever for that
 * ack means an agent frozen in the middle of its work with nothing anywhere
 * saying why.
 *
 * Ten seconds is long enough that a merely slow terminal is never mistaken for
 * a dead one (any ack buys the full window again), and short enough that a
 * person does not sit watching a stalled agent.
 */
export const STUCK_MS = 10_000;

export interface FlowControlDeps {
  /** Stop the producer. Safe to assume it is only called while running. */
  readonly pause: () => void;
  /** Start it again. Only called while paused. */
  readonly resume: () => void;
}

export class FlowControl {
  /** Bytes handed to the renderer that it has not reported drawing yet. */
  private outstanding = 0;
  private paused = false;
  private valve: ReturnType<typeof setTimeout> | null = null;
  /** Set by dispose. The session is gone; nothing here applies to it. */
  private done = false;

  constructor(private readonly deps: FlowControlDeps) {}

  /** Bytes were just forwarded to the renderer. */
  sent(bytes: number): void {
    // node-pty's own comment: "Sometimes a data event is emitted after exit."
    // Re-pausing a dead pty and arming a ten second timer for it is waste, and
    // it contradicts what dispose claims to do.
    if (this.done) return;
    this.outstanding += bytes;
    if (this.paused || this.outstanding <= HIGH_WATERMARK) return;
    this.paused = true;
    this.deps.pause();
    this.armValve();
  }

  /** The renderer reports it has drawn this many. */
  acked(bytes: number): void {
    /*
     * Clamped at zero, and this is not defensive noise. Acks and resets race
     * across a process boundary — a late ack for a chunk sent before a reset,
     * or the same one counted twice — and a negative count would mean a
     * genuinely overloaded terminal never reaches the high mark again. Flow
     * control would then be off, silently, with no symptom until the freeze.
     */
    this.outstanding = Math.max(0, this.outstanding - bytes);
    if (!this.paused) return;

    // Any progress at all is proof the renderer is alive, so the grace period
    // starts over. A slow terminal must not be force-resumed on a schedule
    // while it is working perfectly.
    this.armValve();
    if (this.outstanding > LOW_WATERMARK) return;
    this.release();
  }

  /** The session is gone. */
  dispose(): void {
    this.clearValve();
    this.outstanding = 0;
    this.done = true;
    /*
     * Hand the socket back before letting go of it.
     *
     * A paused node-pty socket LOSES DATA on destroy: the exit path waits for
     * the socket to close and, failing that, destroys it after 200ms — and
     * destroying a paused stream discards its read buffer. So a child that
     * exits while flow control has it paused loses whatever it wrote last, a
     * window that did not exist before backpressure and which opens precisely
     * in the high-throughput case this exists for.
     */
    if (!this.paused) return;
    this.paused = false;
    this.deps.resume();
  }

  private release(): void {
    this.clearValve();
    this.paused = false;
    this.deps.resume();
  }

  private armValve(): void {
    this.clearValve();
    this.valve = setTimeout(() => {
      /*
       * Nothing has been drawn for the whole window, so give up on the count
       * as well as the pause.
       *
       * Releasing alone is not enough, and believing it was is the defect this
       * replaces. The outstanding bytes survive the release, so if the ack
       * path is genuinely broken — an older preload with no `ack` at all is
       * the real pairing — the count never falls below the low mark again.
       * The next chunk re-pauses, this fires again ten seconds later, and the
       * pty crawls forward one chunk per grace period, forever. Measured: a
       * 40 KB permanent drift took throughput from ~8 MB/s to ~18 KB/s. That
       * is not a stuttering terminal, it is a frozen agent that looks alive.
       *
       * Those bytes were either drawn or lost with the renderer. Either way
       * nobody is going to ack them, and a count nobody decrements poisons
       * every later measurement. Forgetting costs one window of imprecision;
       * keeping it costs the feature.
       */
      this.valve = null;
      if (!this.paused) return;
      this.outstanding = 0;
      this.release();
    }, STUCK_MS);
    // Never hold the process open for this. It is a recovery timer for a
    // session that is already in trouble, not work of its own.
    this.valve.unref?.();
  }

  private clearValve(): void {
    if (!this.valve) return;
    clearTimeout(this.valve);
    this.valve = null;
  }
}
