/**
 * CGLAB-167 — getting the desktop app a server to talk to.
 *
 * The invariant: never end up with two servers on one SQLite database. A
 * developer who ran `agenfk up` in a terminal and then opens the app must get
 * the server that is already running, not a second one racing it for the same
 * file. So we look before we leap, and we only stop what we started.
 *
 * Every dependency is injected rather than imported. The decision logic here
 * is the part that can go subtly wrong, and it deserves tests that do not need
 * a real port, a real child process, or a running Electron.
 */

/** Raised when no server answered within the allotted attempts. */
export class ServerUnavailableError extends Error {
  constructor(attempts: number, waitMs: number) {
    super(
      `AgEnFK server did not respond after ${attempts} attempt(s) ` +
      `(~${Math.round((attempts * waitMs) / 1000)}s). ` +
      `Check the server log for a startup failure.`,
    );
    this.name = 'ServerUnavailableError';
  }
}

export interface ResolveServerOptions {
  /** Read the port the server published, or null when it has not yet. */
  readPort: () => number | null;
  /**
   * Ports to check for a running server when the port file says nothing.
   *
   * The file is not proof of absence: a server started by `agenfk up` can be
   * listening on 3000 with no port file at all (observed on a dev machine —
   * a clean shutdown removes the file, and a later start need not recreate it
   * before we look). Without this, "no file" would be read as "no server" and
   * we would fork a second one onto the same SQLite database.
   */
  fallbackPorts?: number[];
  /**
   * How many rounds to look for an existing server before starting our own.
   *
   * More than one, because a probe is a network call with a timeout and a
   * single transient failure has an expensive consequence: a live-but-briefly-
   * slow server (mid-backup, loaded machine) gets read as absent, and we fork
   * a second server onto its database. Being slow to start beats corrupting
   * state.
   */
  adoptAttempts?: number;
  /** True when a server answers on this port (a real health request). */
  probe: (port: number) => Promise<boolean>;
  /** Start our own server. Throwing here is surfaced, not swallowed. */
  spawn: () => void;
  /** Delay between polls. */
  waitMs?: number;
  /** How many polls before giving up. */
  attempts?: number;
  host?: string;
}

export interface ResolvedServer {
  port: number;
  url: string;
  /** True when we attached to a server someone else started. */
  adopted: boolean;
  /** Shut down — a no-op for an adopted server, which is not ours to kill. */
  stop(stopChild: () => void): void;
}

const DEFAULT_ATTEMPTS = 60;
const DEFAULT_WAIT_MS = 250;
const DEFAULT_ADOPT_ATTEMPTS = 3;

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

function resolved(port: number, host: string, adopted: boolean): ResolvedServer {
  return {
    port,
    url: `http://${host}:${port}`,
    adopted,
    stop(stopChild: () => void) {
      if (!adopted) stopChild();
    },
  };
}

/**
 * Find a live server, starting one if there isn't a live one already.
 *
 * Note the poll waits for the server to *answer*, not merely for the port file
 * to appear. The file is written at bind time, a moment before the first
 * request can be served; a window loaded in that gap shows a connection error
 * instead of the board.
 */
export async function resolveServer(opts: ResolveServerOptions): Promise<ResolvedServer> {
  const {
    readPort,
    probe,
    spawn,
    fallbackPorts = [],
    waitMs = DEFAULT_WAIT_MS,
    attempts = DEFAULT_ATTEMPTS,
    adoptAttempts = DEFAULT_ADOPT_ATTEMPTS,
    host = '127.0.0.1',
  } = opts;

  // Is somebody already home? The published port is checked first because it
  // is the authoritative answer when present; the fallbacks catch a server
  // that is running without having left a port file behind. A port with
  // nothing answering is a leftover from a crash, not a running server.
  for (let round = 0; round < adoptAttempts; round++) {
    const published = readPort();
    const candidates = [...new Set([published, ...fallbackPorts])]
      .filter((p): p is number => p !== null && p !== undefined);

    for (const port of candidates) {
      if (await probe(port)) return resolved(port, host, true);
    }
    if (round < adoptAttempts - 1) await sleep(waitMs);
  }

  spawn();

  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = readPort();
    if (port !== null && await probe(port)) {
      return resolved(port, host, false);
    }
    await sleep(waitMs);
  }

  throw new ServerUnavailableError(attempts, waitMs);
}
