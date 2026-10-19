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

import type { AdoptVerdict } from './adoption.js';

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

/**
 * The published server holds a database we cannot show to be another one, so
 * starting our own beside it could put two servers on one SQLite file.
 */
export class DatabaseOwnerError extends Error {
  constructor(readonly port: number) {
    super(
      `An AgEnFK server is already running on port ${port}, and this app could not tell ` +
      `whether it uses the same database as this app. Starting a second server could damage ` +
      `that database, so none was started. Stop the other server (\`agenfk down\`), or give ` +
      `this app its own database with AGENFK_DB_PATH.`,
    );
    this.name = 'DatabaseOwnerError';
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
  /**
   * The port the server WE started bound, as the child itself reported it.
   * Never the shared port file: until our server overwrites it, it may still
   * name the server we declined to adopt, and that one answers first.
   * Defaults to readPort, for callers whose port file is their own.
   */
  readSpawnedPort?: () => number | null;
  /**
   * Whose database is on `port`? Asked only of a published, live server
   * outside fallbackPorts (a configured port range that excludes it): "same"
   * adopts it, "different" leaves it alone, "unknown" refuses to start a
   * second server (DatabaseOwnerError). Absent, such a server is adopted.
   */
  databaseOwner?: (port: number) => Promise<'same' | 'different' | 'unknown'>;
  /** True when a server answers on this port (a real health request). */
  probe: (port: number) => Promise<boolean>;
  /**
   * Whether a server the probe accepted is ours to adopt (BUG cdae6039).
   * Absent, every live server is adopted. A skipped one sits on another
   * database, so starting our own beside it is safe.
   */
  judge?: (port: number) => Promise<AdoptVerdict>;
  /** Start our own server. Throwing here is surfaced, not swallowed. */
  /** May be async: it is awaited before the port is polled. */
  spawn: () => void | Promise<void>;
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
  /** Set when the adopted server runs another version on our database. */
  versionMismatch?: { serverVersion: string; database: 'same' | 'unknown' };
  /** Shut down — a no-op for an adopted server, which is not ours to kill. */
  stop(stopChild: () => void): void;
}

const DEFAULT_ATTEMPTS = 60;
const DEFAULT_WAIT_MS = 250;
const DEFAULT_ADOPT_ATTEMPTS = 3;

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

const ADOPT_ALL = async (): Promise<AdoptVerdict> => ({ kind: 'adopt' });

function resolved(
  port: number,
  host: string,
  adopted: boolean,
  verdict: AdoptVerdict = { kind: 'adopt' },
): ResolvedServer {
  return {
    port,
    url: `http://${host}:${port}`,
    adopted,
    ...(verdict.kind === 'adopt-mismatch'
      ? { versionMismatch: { serverVersion: verdict.serverVersion, database: verdict.database } }
      : {}),
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
    readSpawnedPort = readPort,
    probe,
    databaseOwner,
    judge = ADOPT_ALL,
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
      if (!await probe(port)) continue;
      // A published server past the range may still be the one that owns our
      // database (BUG db4e8cc2 review): never fork a second beside it.
      if (databaseOwner && port === published && !fallbackPorts.includes(port)) {
        const owner = await databaseOwner(port);
        if (owner === 'different') continue;
        if (owner === 'unknown') throw new DatabaseOwnerError(port);
      }
      const verdict = await judge(port);
      if (verdict.kind !== 'skip') return resolved(port, host, true, verdict);
    }
    if (round < adoptAttempts - 1) await sleep(waitMs);
  }

  await spawn();

  // The port is the one our child reported, so what answers is our own server:
  // there is nothing to judge, and no mismatch to announce.
  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = readSpawnedPort();
    if (port !== null && await probe(port)) {
      return resolved(port, host, false);
    }
    await sleep(waitMs);
  }

  throw new ServerUnavailableError(attempts, waitMs);
}
