// Follow loop for async validate runs (CGLAB-10), shared by `agenfk verify`
// and the MCP validate_progress path. Dependency-injected (poll/onOutput) so
// it is unit-testable without HTTP. Deliberately has NO overall deadline — a
// verifyCommand may legitimately run for an hour; only *consecutive* poll
// failures abort, and that error says the run may still be in progress.

export interface RunSnapshot {
  status: 'running' | 'passed' | 'failed';
  output?: string;
  message?: string;
  itemStatus?: string;
}

export interface FollowOptions {
  /** Fetch the current run snapshot (one short-timeout HTTP GET). */
  poll: () => Promise<RunSnapshot>;
  /** Receives only the NEW portion of output on each poll. */
  onOutput: (chunk: string) => void;
  /** Delay between polls (default 1500ms). */
  intervalMs?: number;
  /** Consecutive poll failures tolerated before giving up (default 10). */
  maxConsecutiveErrors?: number;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function followValidateRun(opts: FollowOptions): Promise<RunSnapshot> {
  const intervalMs = opts.intervalMs ?? 1500;
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
      lastError = err;
      consecutiveErrors++;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        const reason = (lastError as any)?.message || String(lastError);
        throw new Error(
          `Lost contact with the AgEnFK server while following the validation run (${reason}). ` +
          `The run may still be in progress on the server — check the item's comments before re-running verify.`,
        );
      }
      await sleep(intervalMs);
      continue;
    }

    const output = snapshot.output ?? '';
    if (output.length > emitted) {
      opts.onOutput(output.slice(emitted));
      emitted = output.length;
    }
    if (snapshot.status !== 'running') return snapshot;
    await sleep(intervalMs);
  }
}
