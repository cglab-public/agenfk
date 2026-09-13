/**
 * The environment a terminal is born into (CGLAB-169).
 *
 * The least visible part of the subsystem and the one that breaks the most.
 * Nothing throws and nothing logs; the agent's interface simply renders in the
 * wrong colours, or the launch fails with ENOENT for a binary the user plainly
 * has. The symptom points at the agent, never at us.
 *
 * Two independent problems are solved here.
 *
 * TERM. A main process launched from Finder has no TERM at all, so node-pty
 * falls back to plain `xterm` — no 256 colours, no truecolor. Every agent TUI
 * draws degraded, on every machine, always. An inherited TERM is overridden
 * rather than trusted: it describes whatever launched the app, and we know what
 * we actually render.
 *
 * PATH. That same process inherits launchd's minimal PATH, which contains none
 * of ~/.local/bin, Homebrew, nvm, asdf or mise. Detection already recovers a
 * usable PATH from a login shell; before this module the spawn then used the
 * minimal one anyway, so the picker could say "installed" and launching could
 * still fail. That is CGLAB-177's bug one layer down.
 */
import { execFile } from 'child_process';
import * as os from 'os';

/**
 * Marks a login shell spawned BY the capture, so a user whose rc file launches
 * or talks to this app cannot make the capture spawn a shell that spawns the
 * capture again.
 */
export const LOGIN_CAPTURE_GUARD = 'AGENFK_SHELL_CAPTURE';

/**
 * Variables that describe how *we* were launched, not how the user works.
 *
 * A deny list rather than an allow list on purpose: a developer's own exports
 * are exactly what make their tools work, and an allow list would quietly break
 * every setup we failed to anticipate. ELECTRON_RUN_AS_NODE is the sharpest
 * one — an agent that shells out to node would re-enter our own binary.
 */
const STRIP_PREFIXES = ['ELECTRON_', 'VITE_', 'MAIN_VITE_', 'PRELOAD_VITE_', 'RENDERER_VITE_', 'npm_', 'AGENFK_SHELL_'];
const STRIP_EXACT = new Set(['NODE_ENV', 'NODE_OPTIONS', 'INIT_CWD', 'VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID']);

const shouldStrip = (key: string): boolean =>
  STRIP_EXACT.has(key) || STRIP_PREFIXES.some(p => key.startsWith(p));

/**
 * Merge a recovered PATH over an inherited one.
 *
 * Recovered entries lead, because they are the ones the inherited PATH is
 * missing. It is a merge and not a replacement: something the app was launched
 * with may genuinely be needed, and dropping it trades one missing-binary bug
 * for another. Empty segments are dropped — an empty PATH entry means "the
 * current directory" to some shells, which is a real hazard in a directory an
 * agent is writing to.
 */
export function mergePath(recovered: string | null | undefined, inherited: string | null | undefined): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [...(recovered ?? '').split(':'), ...(inherited ?? '').split(':')]) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.join(':');
}

/** Read `env` output into a map. */
export function parseEnvDump(dump: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of dump.split('\n')) {
    const eq = line.indexOf('=');
    // No '=' means it is not an assignment — a login shell prints banners, motd
    // and rc-file chatter alongside the env output.
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (key === LOGIN_CAPTURE_GUARD) continue;
    // slice, not split: base64 secrets, connection strings and JWTs carry '='
    // in the value and splitting on every one truncates them.
    out[key] = line.slice(eq + 1);
  }
  return out;
}

/**
 * The PATH an interactive login shell would have.
 *
 * Returns null on any failure — a broken rc file must degrade the terminal's
 * PATH, never stop the app from opening one.
 */
export function captureLoginPath(timeoutMs = 5000): Promise<string | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  // The guard, actually read. It was previously set into the child and
  // stripped from the result but never checked, so the comment promised a
  // safeguard that did not exist — and its test only asserted the constant was
  // non-empty, which passed with the mechanism entirely absent.
  if (process.env[LOGIN_CAPTURE_GUARD] === '1') return Promise.resolve(null);
  const shell = process.env.SHELL || os.userInfo().shell || '/bin/bash';
  return new Promise(resolve => {
    execFile(
      shell,
      ['-lic', 'env'],
      { env: { ...process.env, [LOGIN_CAPTURE_GUARD]: '1' }, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? null : (parseEnvDump(String(stdout)).PATH ?? null)),
    );
  });
}

/**
 * Build the environment for a PTY.
 *
 * `loginPath` is the PATH recovered from a login shell, if one was obtained.
 * Passing it here is the whole point: detecting an agent with one PATH and
 * spawning it with another is how "installed" turns into ENOENT.
 */
export function buildPtyEnv(base: NodeJS.ProcessEnv, loginPath?: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || shouldStrip(key)) continue;
    env[key] = value;
  }

  if (loginPath) env.PATH = mergePath(loginPath, base.PATH);

  // Forced, not defaulted. See the header: an inherited TERM describes whoever
  // launched us, and there may not be one at all.
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'agenfk';

  // A shell with no HOME cannot read its own configuration.
  if (!env.HOME) env.HOME = os.homedir();

  return env;
}
