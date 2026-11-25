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
  /**
   * Set, but names no port from 1 to 65535. The server would refuse some of
   * these and take a random port for 0 or a negative value.
   */
  | { kind: 'invalid'; name: 'AGENFK_PORT' | 'PORT'; raw: string };

/**
 * AGENFK_PORT, else PORT, read exactly as the server reads it
 * (`parseInt(AGENFK_PORT || PORT)`), so the desktop never keeps to one port
 * while the server it starts requests another.
 */
export function portSetting(env: Env): PortSetting {
  const name = env.AGENFK_PORT ? 'AGENFK_PORT' : 'PORT';
  const raw = env[name];
  if (!raw) return { kind: 'unset' };
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port >= 1 && port <= MAX_PORT
    ? { kind: 'port', port }
    : { kind: 'invalid', name, raw };
}

/**
 * The startup error for an unreadable port setting, or null when it is fine.
 * Checked before any server is looked for, so the dialog names the variable
 * instead of failing 15 s later on a server that never answered.
 */
export function invalidPortMessage(env: Env): string | null {
  const setting = portSetting(env);
  if (setting.kind !== 'invalid') return null;
  return `${setting.name} is set to "${setting.raw}", which is not a port. `
    + `Set it to a number from 1 to ${MAX_PORT}, or unset it to use the default.`;
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
 * The port the server we forked bound, read from its startup line on stdout
 * ("AgEnFK API Server running on 127.0.0.1:3187 (with WebSockets)"), or null
 * for any other line.
 *
 * This is how the desktop learns where ITS server is. The shared port file
 * cannot say: it may still name the server we declined to adopt until ours
 * overwrites it, and the poll would open that one as our own.
 */
export function parseBoundPort(line: string): number | null {
  const m = /^AgEnFK API Server running on \S+:(\d+) \(with WebSockets\)$/.exec(line);
  if (!m) return null;
  const port = Number.parseInt(m[1], 10);
  return port >= 1 && port <= MAX_PORT ? port : null;
}

/**
 * Collects the bound port from the child's stdout, which is free text: log
 * lines can echo request data. Only a line that is the startup line in FULL
 * counts, partial lines are held until their newline, and the FIRST match
 * stays: a later look-alike cannot move it.
 */
export function boundPortReader(): { push(chunk: string): void; port(): number | null; reset(): void } {
  let pending = '';
  let found: number | null = null;
  return {
    push(chunk) {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      // A runaway line with no newline is not the startup line.
      if (pending.length > 4096) pending = '';
      for (const line of lines) {
        if (found === null) found = parseBoundPort(line);
      }
    },
    port: () => found,
    reset() { pending = ''; found = null; },
  };
}
