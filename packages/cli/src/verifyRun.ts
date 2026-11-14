// Follow loop for async validate runs (CGLAB-10), used by `agenfk verify`.
// The MCP server follows runs with its own loop (server/src/index.ts) on the
// same poll schedule (core nextPollDelay, cc5e4943). Dependency-injected (poll/onOutput) so
// it is unit-testable without HTTP. Deliberately has NO overall deadline — a
// verifyCommand may legitimately run for an hour; only *consecutive* poll
// failures abort, and that error says the run may still be in progress.

import { nextPollDelay } from '@agenfk/core';

export interface RunSnapshot {
  status: 'running' | 'passed' | 'failed';
  output?: string;
  message?: string;
  itemStatus?: string;
  /** The step checks of a refused run (CGLAB-380). */
  checks?: Array<{ id: string; blocking?: boolean }>;
}

export interface FollowOptions {
  /** Fetch the current run snapshot (one short-timeout HTTP GET). */
  poll: () => Promise<RunSnapshot>;
  /** Receives only the NEW portion of output on each poll. */
  onOutput: (chunk: string) => void;
  /**
   * The longest delay between polls (default 1500ms). A running run is polled
   * after 100ms, then twice as long each time up to this (cc5e4943): a quick
   * verify returns in a fraction of a second, a long one is not polled harder.
   * A poll error always waits this long before the retry.
   */
  intervalMs?: number;
  /** Test seam: how a delay is waited. */
  sleep?: (ms: number) => Promise<void>;
  /** Consecutive poll failures tolerated before giving up (default 10). */
  maxConsecutiveErrors?: number;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function followValidateRun(opts: FollowOptions): Promise<RunSnapshot> {
  const intervalMs = opts.intervalMs ?? 1500;
  const wait = opts.sleep ?? sleep;
  let nextDelay = nextPollDelay(undefined, intervalMs);
  const maxConsecutiveErrors = opts.maxConsecutiveErrors ?? 10;
  let emitted = 0;
  let consecutiveErrors = 0;
  let lastError: unknown;

  for (;;) {
    let snapshot: RunSnapshot;
    try {
      snapshot = await opts.poll();
      consecutiveErrors = 0;
    } catch (err) {
      // A poll can mark its error as fatal (e.g. the server answered 404
      // RUN_NOT_FOUND after a restart) — retrying won't change a definitive
      // answer, so surface it immediately instead of burning the retry budget.
      if ((err as any)?.fatal) throw err;
      lastError = err;
      consecutiveErrors++;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        const reason = (lastError as any)?.message || String(lastError);
        throw new Error(
          `Lost contact with the AgEnFK server while following the validation run (${reason}). ` +
          `The run may still be in progress on the server — check the item's comments before re-running verify.`,
        );
      }
      await wait(intervalMs);
      continue;
    }

    const output = snapshot.output ?? '';
    if (output.length > emitted) {
      opts.onOutput(output.slice(emitted));
      emitted = output.length;
    }
    if (snapshot.status !== 'running') return snapshot;
    await wait(nextDelay);
    nextDelay = nextPollDelay(nextDelay, intervalMs);
  }
}
