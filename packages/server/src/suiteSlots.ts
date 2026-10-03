/**
 * f8d0a752 — a server-wide limit on concurrent suite runs.
 *
 * Every agent verifying at once used to run its suite at once, each at full
 * parallelism; on a 12-core machine that meant a load of 76-88 and timing
 * tests that failed only under agenfk. A suite run - a step's capture, or the
 * command a flow's final step runs - takes a slot first. Beyond the limit it
 * waits, first in first out, and is told how many runs are ahead.
 *
 * The limit is the app setting maxConcurrentSuiteRuns, one value for the
 * whole server: 0 is automatic (half the CPUs, at least 1); any other whole
 * number is used as given, up to the CPU count.
 */

/** The number of suite runs allowed at once for `cpus` CPUs and the setting's value. */
export function suiteRunLimit(cpus: number, setting: number): number {
  const machine = Math.max(1, Math.floor(cpus));
  if (Number.isInteger(setting) && setting > 0) return Math.min(setting, machine);
  return Math.max(1, Math.floor(machine / 2));
}

export interface SuiteWait { ahead: number; limit: number }

export class SuiteSlots {
  private running = 0;
  /** Each waiter, and how it is told its place (beae41a0: again whenever it moves up). */
  private readonly queue: Array<{ start: () => void; onWait?: (w: SuiteWait) => void; told: number }> = [];

  /** `limit` is read whenever a slot is taken or freed, so a changed setting applies to the queue at once. */
  constructor(private readonly limit: () => number) {}

  /** Take a slot, waiting in line when none is free; resolves to the release. */
  async acquire(onWait?: (w: SuiteWait) => void): Promise<() => void> {
    if (this.running < this.limit() && this.queue.length === 0) {
      this.running++;
      return this.releaser();
    }
    const ahead = this.aheadOf(this.queue.length);
    onWait?.({ ahead, limit: this.limit() });
    await new Promise<void>(resolve => this.queue.push({ start: resolve, onWait, told: ahead }));
    return this.releaser();
  }

  /** Run `fn` in a slot; the slot is freed however `fn` ends. */
  async run<T>(fn: () => Promise<T>, onWait?: (w: SuiteWait) => void): Promise<T> {
    const release = await this.acquire(onWait);
    try { return await fn(); } finally { release(); }
  }

  /** Start whatever the limit now has room for: a raised setting lets the queue through at once (80920048). */
  recheck(): void {
    this.drain();
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.running--;
      this.drain();
    };
  }

  /** How many runs are ahead of the waiter at `index` in the queue. */
  private aheadOf(index: number): number {
    return this.running + index - Math.max(0, this.limit() - 1);
  }

  private drain(): void {
    while (this.queue.length && this.running < this.limit()) {
      this.running++;
      this.queue.shift()!.start();
    }
    // beae41a0: the ones still waiting moved up - each is told its new place.
    this.queue.forEach((w, i) => {
      const ahead = this.aheadOf(i);
      if (ahead === w.told) return;
      w.told = ahead;
      w.onWait?.({ ahead, limit: this.limit() });
    });
  }
}

/** The line a waiting run prints. */
export const waitingLine = (w: SuiteWait) =>
  `[agenfk] waiting for a suite-run slot: ${w.ahead} run(s) ahead, at most ${w.limit} at once (setting maxConcurrentSuiteRuns)\n`;
