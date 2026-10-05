/**
 * The login shell's PATH, captured once and re-captured when it goes stale
 * (CGLAB 8a6cdf70).
 *
 * Capturing it is expensive in a way the call site hides: `$SHELL -lic env`
 * runs the user's entire rc chain — nvm, rbenv, conda — with a megabyte
 * buffer and a five second timeout, to produce a value that is almost always
 * identical to the last one.
 *
 * The version this replaces memoised it and re-captured on expiry, with no
 * single flight. That is fine with one caller and wrong with several, which
 * is the normal case here: N concurrent callers all await the same stale
 * promise, all wake in the same microtask batch, all compare against the same
 * stale timestamp, and all start a capture. A burst of terminal spawns more
 * than the memo window after boot forked one login shell per spawn.
 *
 * Extracted from the Electron bootstrap so the concurrency can be driven
 * deliberately in a test — the same reason `adoptFailure.ts` lives apart.
 *
 * The expiry is not negotiable, and is itself the fix to an earlier bug: a
 * single永 memoised promise turned a boot optimisation into a session-long
 * pin, so a PATH that changed while the app was open was never seen again.
 */

/**
 * How long a captured PATH is trusted before it is taken again.
 *
 * Long enough that a burst of spawns shares one capture; short enough that
 * installing a tool and opening a terminal finds it.
 */
export const LOGIN_PATH_MEMO_MS = 30_000;

export interface LoginPathCacheDeps {
  /** Runs the real capture. Answers null when it fails or times out. */
  readonly capture: () => Promise<string | null>;
  /** Injected so expiry can be tested without waiting. */
  readonly now?: () => number;
  readonly memoMs?: number;
}

/**
 * Build the accessor.
 *
 * It ANSWERS WITH A PROMISE on purpose, and that is what lets the app paint
 * before the first capture finishes: a terminal opened in the first second
 * waits for the capture already running rather than being handed null and a
 * degraded PATH — which is the very thing the capture exists to prevent.
 */
export function makeLoginPathCache(deps: LoginPathCacheDeps): () => Promise<string | null> {
  const now = deps.now ?? Date.now;
  const memoMs = deps.memoMs ?? LOGIN_PATH_MEMO_MS;

  /** The capture currently running, if one is. This is the single flight. */
  let inFlight: Promise<string | null> | null = null;
  let value: string | null = null;
  let capturedAt = 0;

  const start = (): Promise<string | null> => {
    const run = deps.capture()
      /*
       * A rejection answers null rather than escaping. This is awaited on the
       * spawn path, and nothing should be able to make opening a terminal
       * throw because a shell misbehaved.
       */
      .catch(() => null)
      .then(captured => {
        value = captured;
        capturedAt = now();
        return captured;
      })
      .finally(() => {
        // Cleared only if we are still the current flight, so a late finally
        // cannot cancel a newer capture that has already replaced this one.
        if (inFlight === run) inFlight = null;
      });
    inFlight = run;
    return run;
  };

  return () => {
    // Someone is already doing this. Join them — the whole point.
    if (inFlight) return inFlight;

    /*
     * A null is NOT a fresh value. A capture that timed out or hit a broken rc
     * file answers null, and treating that as cached would degrade every spawn
     * for the rest of the session to whatever minimal PATH launchd handed the
     * app — the exact failure this module exists to avoid. So a failure is
     * always retried, while a success is trusted for the memo window.
     */
    if (value !== null && now() - capturedAt < memoMs) return Promise.resolve(value);
    return start();
  };
}
