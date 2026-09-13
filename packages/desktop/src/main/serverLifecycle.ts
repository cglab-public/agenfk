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
    waitMs = DEFAULT_WAIT_MS,
    attempts = DEFAULT_ATTEMPTS,
    host = '127.0.0.1',
  } = opts;

  // Is somebody already home? A published port with nothing answering is a
  // leftover file from a crash, not a running server.
  const published = readPort();
  if (published !== null && await probe(published)) {
    return resolved(published, host, true);
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
