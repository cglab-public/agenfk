/**
 * BUG db4e8cc2 — which ports the desktop may adopt a server on.
 *
 * The server and the CLI honour AGENFK_PORT, then PORT. The desktop used to
 * scan a fixed 3000-3015 and trust the port file whatever it named, so a build
 * told to use another port adopted the server on 3000 anyway: on Windows the
 * WSL server is forwarded to localhost.
 *
 * This separates PORTS only. A desktop and a server that share a home share
 * its database too, unless AGENFK_DB_PATH (or another home) says otherwise.
 */

/** How many ports from the start are checked: a few stale listeners' worth. */
export const ADOPT_RANGE_SIZE = 16;

const MAX_PORT = 65535;

type Env = Record<string, string | undefined>;

export type PortSetting =
  | { kind: 'unset' }
  | { kind: 'port'; port: number }
  /** Set, but names no port: the server it starts would not start either. */
  | { kind: 'invalid'; raw: string };

/**
 * AGENFK_PORT, else PORT, read exactly as the server reads it
 * (`parseInt(AGENFK_PORT || PORT)`), so the desktop never keeps to one port
 * while the server it starts requests another.
 */
export function portSetting(env: Env): PortSetting {
  const raw = env.AGENFK_PORT || env.PORT;
  if (!raw) return { kind: 'unset' };
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port >= 1 && port <= MAX_PORT
    ? { kind: 'port', port }
    : { kind: 'invalid', raw };
}

/**
 * The ports to look for a running server on: 16 from the configured port, or
 * from the default when none is set. Empty when the setting is unreadable:
 * that must never mean "use 3000".
 */
export function adoptPortRange(env: Env, defaultPort: number): number[] {
  const setting = portSetting(env);
  if (setting.kind === 'invalid') return [];
  const start = setting.kind === 'port' ? setting.port : defaultPort;
  const end = Math.min(start + ADOPT_RANGE_SIZE - 1, MAX_PORT);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

/**
 * The port file, kept only when it names a port the desktop may adopt.
 *
 * Unconfigured, it passes through: a server that bumped past the scanned range
 * is still found by its file. Configured, a file naming another port was
 * written by some other server in this home, possibly the one the user works
 * with, and is ignored.
 */
export function portFileWithin(
  readPort: () => number | null,
  env: Env,
  defaultPort: number,
): () => number | null {
  if (portSetting(env).kind === 'unset') return readPort;
  const allowed = new Set(adoptPortRange(env, defaultPort));
  return () => {
    const port = readPort();
    return port !== null && allowed.has(port) ? port : null;
  };
}
