/**
 * Which agent CLIs exist on this machine (CGLAB-169).
 *
 * Runs in the main process only. The renderer receives the answer and never
 * probes anything itself: detection takes a name and asks the OS about it, so
 * a renderer-supplied name would be a probe primitive first and an execution
 * one soon after. Only ids already in agents.ts are looked up.
 *
 * The reason this is not a one-line `which`: the app's own PATH is not a
 * terminal's. A macOS app launched from Finder inherits launchd's minimal one,
 * with none of `~/.local/bin`, Homebrew, nvm or asdf; a Windows app keeps the
 * one it was started with, so an agent installed while it is open never shows.
 * CGLAB-177 hit the first shape; story 1b9d622e hit both.
 *
 * So every probe uses the PATH a terminal opened NOW would have - the
 * profile's `freshPath`, memoised by the main process - ahead of the inherited
 * one. Nothing here knows how anything was installed: npm, brew, nvm, scoop
 * and a native installer all end on that PATH.
 *
 * The same lookup answers the spawn (`locateExecutable`), so "Installed" means
 * exactly "the terminal will open this".
 */
import { execFile } from 'child_process';
import { AGENT_IDS, listAgents, resolveAgentCommand } from './agents.js';
import { captureLoginPath, mergePath, pathKeyOf } from './ptyEnv.js';
import { LOGIN_PATH_MEMO_MS } from './loginPathCache.js';
import { platform } from './platform.js';

export interface DetectedAgent {
  readonly id: string;
  readonly label: string;
  readonly installed: boolean;
  /**
   * Whether this agent has a flag to skip its own permission prompts.
   *
   * Carried across the IPC border, not recomputed on the other side. Leaving it
   * off here made the picker's toggle permanently dead AND made the dialog
   * state, falsely, that Claude Code cannot skip permissions. The unit tests
   * missed it because they hand-wrote the field into their fixtures — they
   * validated a shape the real producer never emitted.
   */
  readonly supportsAutoApprove: boolean;
}

export interface DetectDeps {
  /** Resolve an executable, optionally against a specific PATH. */
  readonly which: (file: string, pathOverride?: string) => Promise<string | null>;
  /** The PATH a terminal opened now would have, or null when it cannot be obtained. */
  readonly loginPath: () => Promise<string | null>;
  /** Injected so the memo's expiry can be tested without waiting. */
  readonly now?: () => number;
  /** Drop a remembered fresh PATH, so "Check again" sees an install made since. */
  readonly forgetLoginPath?: () => void;
}

/**
 * How long a detection is trusted. The same window as the fresh PATH it was
 * made with: an answer kept for the whole session meant installing an agent
 * with the app open changed nothing until a restart.
 */
export const DETECTION_MEMO_MS = LOGIN_PATH_MEMO_MS;

/** `shell` is the fallback and is always available; probing it is meaningless. */
const ALWAYS_AVAILABLE = new Set(['shell']);

/**
 * The detection, cached as a PROMISE rather than as its result.
 *
 * Caching the result left a window: two callers arriving before the first
 * finished both saw an empty cache and both ran a full detection, which means
 * two login shells. The promise closes it — the second caller awaits the first
 * one's work.
 */
let inFlight: Promise<DetectedAgent[]> | null = null;
/** When `inFlight` was started; it is trusted for DETECTION_MEMO_MS. */
let startedAt = 0;

/**
 * The dependencies detection uses when a caller does not pass any.
 *
 * Installed once at boot by the main process, so that the PATH captured there
 * is the one detection uses. Before this, every call fell back to
 * `loginShellPath`, which runs `$SHELL -lic env` AGAIN — a second login shell
 * per boot, reading the user's whole rc chain, for a value already in hand.
 * The comment in index.ts claimed detection and spawning shared one capture;
 * half of it was true.
 */
/**
 * What detection uses when nobody has installed anything — a plain probe and a
 * login shell of its own. Exported so a test that swaps the deps can put the
 * real ones back rather than leaving the module pointing at a fixture.
 */
export const REAL_DETECTION_DEPS: DetectDeps = {
  // Both indirected: these constants are declared further down, and naming
  // them eagerly here is a temporal-dead-zone error.
  which: (file, pathOverride) => whichOnPath(file, pathOverride),
  loginPath: () => loginShellPath(),
};

let defaultDeps: DetectDeps = REAL_DETECTION_DEPS;

export function setAgentDetectionDeps(deps: DetectDeps): void {
  defaultDeps = deps;
  // Anything already detected was found with the old PATH.
  inFlight = null;
}

/** Called by tests. */
export function __resetAgentDetectionCache(): void {
  inFlight = null;
}

/**
 * "Check again" (story 1b9d622e): forget the answer AND the PATH it was found
 * with. Forgetting only the answer re-probed with a PATH captured before the
 * install, and said Not installed for up to thirty seconds more.
 */
export function refreshAgentDetection(): void {
  inFlight = null;
  defaultDeps.forgetLoginPath?.();
}

const run = (file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> =>
  new Promise(resolve => {
    // execFile with an argv array — never a shell string. These arguments are
    // from the closed set, but the habit is what keeps it true after an edit.
    execFile(file, args, { env: env ?? process.env, timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });

export const whichOnPath = async (file: string, pathOverride?: string): Promise<string | null> => {
  const env = pathOverride ? { ...process.env, [pathKeyOf(process.env)]: pathOverride } : undefined;
  // `which`, not `command -v`. `command` is a SHELL BUILTIN, not a binary, so
  // execFile'ing it fails with ENOENT every time — an earlier version tried it
  // first and silently fell through, paying a failed spawn on every probe for
  // an answer it could never give.
  const out = await run(platform.pathLookup, [file], env);
  // `where` lists every match, and on Windows the first is often npm's sh
  // shim, which nothing there can start. The profile picks the runnable one.
  return out ? platform.pickExecutable(out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) : null;
};

/**
 * Where `file` is, as a terminal opened now would find it, or null.
 *
 * The fresh PATH leads and the inherited one follows - merged, not swapped,
 * because something the app was started with may be needed too. Never throws:
 * a broken rc file or a failed lookup is "not found".
 */
export async function locateExecutable(file: string, deps: DetectDeps = defaultDeps): Promise<string | null> {
  return lookUp(file, await probePath(deps), deps);
}

/** The PATH to probe with: fresh ahead of inherited, or undefined for the inherited alone. */
async function probePath(deps: DetectDeps): Promise<string | undefined> {
  let fresh: string | null = null;
  try {
    fresh = await deps.loginPath();
  } catch {
    // A broken rc file degrades detection; it must not wedge the picker.
    fresh = null;
  }
  return fresh ? mergePath(fresh, process.env[pathKeyOf(process.env)]) : undefined;
}

async function lookUp(file: string, pathOverride: string | undefined, deps: DetectDeps): Promise<string | null> {
  try {
    return (await deps.which(file, pathOverride)) || null;
  } catch {
    // A failed probe is "not found", never a thrown detection.
    return null;
  }
}

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
export async function detectAgents(deps: DetectDeps = defaultDeps): Promise<DetectedAgent[]> {
  const now = deps.now ?? Date.now;
  if (inFlight && now() - startedAt < DETECTION_MEMO_MS) return inFlight;
  const attempt = detectOnce(deps);
  inFlight = attempt;
  startedAt = now();
  const forget = () => { if (inFlight === attempt) inFlight = null; };

  let result: DetectedAgent[];
  try {
    result = await attempt;
  } catch (e) {
    // A failed detection must not become the session's answer.
    forget();
    throw e;
  }
  // The rule that was here before the promise cache, kept: a run in which
  // nothing real was found is far more likely a failed detection than a
  // machine with no CLI at all, and remembering it would leave the picker
  // wrong for the whole session. Concurrent callers still share this attempt —
  // the point of the promise is one login shell, not one outcome forever.
  if (!result.some(a => !ALWAYS_AVAILABLE.has(a.id) && a.installed)) forget();
  return result;
}

async function detectOnce(deps: DetectDeps): Promise<DetectedAgent[]> {
  const ids = [...AGENT_IDS];
  // Once per detection, not once per agent: on a cold memo it is a login shell.
  const pathOverride = await probePath(deps);
  const found = new Map<string, boolean>();
  for (const id of ids) {
    if (ALWAYS_AVAILABLE.has(id)) {
      found.set(id, true);
      continue;
    }
    // The EXECUTABLE, not the id. They are deliberately different — the id
    // is 'claude-code', the harness vocabulary the server and hub speak,
    // while the binary on PATH is `claude`. Probing the id reported Claude
    // Code as missing on a machine that had it, and offered an install
    // command for something already installed.
    found.set(id, Boolean(await lookUp(resolveAgentCommand(id).file, pathOverride, deps)));
  }

  // The whole entry, not just the label: picking fields off one by one is how
  // supportsAutoApprove went missing in the first place.
  const meta = new Map(listAgents().map(a => [a.id, a]));
  const result = ids.map(id => ({
    id,
    label: meta.get(id)?.label ?? id,
    supportsAutoApprove: meta.get(id)?.supportsAutoApprove === true,
    installed: Boolean(found.get(id)),
  }));

  // Whether this is worth remembering is decided by the caller above, which
  // owns the cache.
  return result;
}
