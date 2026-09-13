/**
 * Which agent CLIs exist on this machine (CGLAB-169).
 *
 * Runs in the main process only. The renderer receives the answer and never
 * probes anything itself: detection takes a name and asks the OS about it, so
 * a renderer-supplied name would be a probe primitive first and an execution
 * one soon after. Only ids already in agents.ts are looked up.
 *
 * The reason this is not a one-line `which`: a macOS app launched from Finder
 * inherits launchd's minimal PATH, not a terminal's. It contains none of
 * `~/.local/bin`, Homebrew, nvm or asdf, so everything reports missing on a
 * machine that plainly has them. CGLAB-177 hit this exact shape when the run
 * hook did not load as installed. The login-shell PATH is only paid for when
 * the cheap probe comes up empty — spawning a login shell runs the user's rc
 * files and is slow.
 */
import { execFile } from 'child_process';
import { AGENT_IDS, listAgents } from './agents.js';
import { captureLoginPath } from './ptyEnv.js';

export interface DetectedAgent {
  readonly id: string;
  readonly label: string;
  readonly installed: boolean;
}

export interface DetectDeps {
  /** Resolve an executable, optionally against a specific PATH. */
  readonly which: (file: string, pathOverride?: string) => Promise<string | null>;
  /** The PATH a login shell would have, or null when it cannot be obtained. */
  readonly loginPath: () => Promise<string | null>;
}

/** `shell` is the fallback and is always available; probing it is meaningless. */
const ALWAYS_AVAILABLE = new Set(['shell']);

let cache: DetectedAgent[] | null = null;

/** Called after an install, and by tests. */
export function __resetAgentDetectionCache(): void {
  cache = null;
}

const run = (file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> =>
  new Promise(resolve => {
    // execFile with an argv array — never a shell string. These arguments are
    // from the closed set, but the habit is what keeps it true after an edit.
    execFile(file, args, { env: env ?? process.env, timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });

export const whichOnPath = (file: string, pathOverride?: string): Promise<string | null> => {
  const env = pathOverride ? { ...process.env, PATH: pathOverride } : undefined;
  // `which`, not `command -v`. `command` is a SHELL BUILTIN, not a binary, so
  // execFile'ing it fails with ENOENT every time — an earlier version tried it
  // first and silently fell through, paying a failed spawn on every probe for
  // an answer it could never give.
  return process.platform === 'win32'
    ? run('where', [file], env)
    : run('which', [file], env);
};

/**
 * The PATH an interactive login shell would have.
 *
 * Delegates to the shared capture in ptyEnv so detection and spawning agree on
 * one answer. Two separate implementations is exactly how they came to
 * disagree: the picker said "Installed" and the spawn failed with ENOENT.
 */
export const loginShellPath = (): Promise<string | null> => captureLoginPath();

/**
 * Detect every agent in the closed set, installed or not.
 *
 * Returns all of them, not just the present ones: the picker groups into
 * "Installed" and "Not installed", and it cannot group what it was not told
 * about — a user would never learn the other agents exist.
 */
export async function detectAgents(deps: DetectDeps = { which: whichOnPath, loginPath: loginShellPath }): Promise<DetectedAgent[]> {
  if (cache) return cache;

  const probe = async (id: string, pathOverride?: string): Promise<boolean> => {
    if (ALWAYS_AVAILABLE.has(id)) return true;
    try {
      return Boolean(await deps.which(id, pathOverride));
    } catch {
      // A failed probe is "not found", never a thrown detection.
      return false;
    }
  };

  const ids = [...AGENT_IDS];
  let found = new Map<string, boolean>();
  for (const id of ids) found.set(id, await probe(id));

  // Only now, and only if the cheap answer was empty, pay for a login shell.
  const anythingReal = ids.some(id => !ALWAYS_AVAILABLE.has(id) && found.get(id));
  if (!anythingReal) {
    let extraPath: string | null = null;
    try {
      extraPath = await deps.loginPath();
    } catch {
      // A broken rc file degrades detection; it must not wedge the picker.
      extraPath = null;
    }
    if (extraPath) {
      const retried = new Map<string, boolean>();
      for (const id of ids) retried.set(id, await probe(id, extraPath));
      found = retried;
    }
  }

  const labels = new Map(listAgents().map(a => [a.id, a.label]));
  const result = ids.map(id => ({
    id,
    label: labels.get(id) ?? id,
    installed: Boolean(found.get(id)),
  }));

  // Do not cache a run in which nothing real was found: it is far more likely
  // that detection failed than that the machine has no CLI at all, and caching
  // it would leave the picker wrong for the whole session.
  if (result.some(a => !ALWAYS_AVAILABLE.has(a.id) && a.installed)) cache = result;
  return result;
}
