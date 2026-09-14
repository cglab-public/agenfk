/**
 * Session persistence by delegation.
 *
 * A terminal we spawn is a child of this app: close the app and the agent dies
 * with it. tmux breaks that link — it runs as its own daemon and owns the
 * process, while our PTY is only a view attached to it. So making a session
 * survive is not a matter of building a supervisor; it is delegating to one
 * that has existed for twenty years, and which also keeps the scrollback.
 *
 * Two honesty requirements shape this file.
 *
 * tmux is a native program (libevent, ncurses) and is not something we can
 * ship. Bundling it would reintroduce per-platform native builds, which is
 * exactly what this app currently avoids — node-pty is pure Node-API, so there
 * is no compile step anywhere. So tmux is detected, and its absence is reported
 * with the command that fixes it.
 *
 * **There is no tmux for Windows.** Not "usually missing" — no port exists. A
 * request for it there must therefore become a NAMED warning the UI can
 * explain, never a flag that is quietly dropped. A control that appears to work
 * and does nothing is the precise defect review caught in the auto-approve
 * chain, and it is worse than the feature being absent.
 */
import { resolveAgentCommand } from './agents.js';

/** The UI renders this; it is a fact about the platform, not an action. */
export const TMUX_UNSUPPORTED_ON_WINDOWS = 'tmux_unsupported_on_windows' as const;

export const TMUX_INSTALL_HINT: Record<string, string> = {
  darwin: 'brew install tmux',
  linux: 'apt install tmux  (or dnf/pacman)',
};

export interface TmuxStatus {
  readonly available: boolean;
  /** How to get it. Absent where installing is not the answer. */
  readonly hint?: string;
  /** Present when persistence cannot exist here at all. */
  readonly warning?: typeof TMUX_UNSUPPORTED_ON_WINDOWS;
}

export interface TmuxDetectDeps {
  readonly platform: NodeJS.Platform;
  readonly which: (file: string) => Promise<string | null>;
}

export async function detectTmux(deps: TmuxDetectDeps): Promise<TmuxStatus> {
  if (deps.platform === 'win32') {
    // Not probed. A spawn here could only fail, and reporting "not installed"
    // would imply installing is possible.
    return { available: false, warning: TMUX_UNSUPPORTED_ON_WINDOWS };
  }
  try {
    if (await deps.which('tmux')) return { available: true };
  } catch {
    // A failed probe is "absent", never a thrown detection.
  }
  return { available: false, hint: TMUX_INSTALL_HINT[deps.platform] ?? TMUX_INSTALL_HINT.linux };
}

/** tmux truncates beyond this, and a truncated name no longer matches. */
const NAME_MAX = 48;
const PREFIX = 'agenfk-';

/**
 * A stable, shell-safe session name for a card and agent.
 *
 * Readable prefix plus a hash: a person has to recognise it in `tmux ls`, and
 * it has to survive being interpolated into a shell line. The hash is what
 * keeps it inside tmux's length limit — a name that gets truncated can no
 * longer be found by `has-session`, so the old session is orphaned and a new
 * one spawns beside it on every launch.
 */
export function tmuxSessionName(
  itemId: string,
  agentId: string,
  /**
   * What the session was created WITH.
   *
   * Part of the identity, not decoration. A tmux session outlives the app, and
   * reattaching runs no new command line — so a session created with
   * permission prompts disabled keeps running that way forever, including
   * after the user turns the setting back off. Folding the decision into the
   * name means a changed setting produces a different session instead of
   * silently reattaching to the old one.
   */
  opts: { autoApprove?: boolean } = {},
): string {
  // Not crypto — this is a collision-avoidance label, and a dependency-free
  // hash keeps this module importable from anywhere in main.
  let hash = 5381;
  const input = `${itemId}:${agentId}:${opts.autoApprove === true ? 'auto' : 'ask'}`;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  const readable = `${PREFIX}${agentId.replace(/[^A-Za-z0-9]/g, '')}-`;
  return `${readable}${hash.toString(36)}`.slice(0, NAME_MAX);
}

/** Only names this module generates. Anything else is refused, not quoted. */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The shell line that attaches to a session, creating it only if absent.
 *
 * Our PTY runs THIS, not the agent. The agent lives inside the tmux session,
 * so closing the app detaches rather than kills.
 */
export function buildTmuxShellCommand(
  sessionName: string,
  agentId: string,
  extraArgs: readonly string[],
): string {
  if (!SAFE_NAME.test(sessionName)) {
    // It reaches a shell line. Accepting an arbitrary name would be command
    // injection with extra steps, so it is refused rather than escaped.
    throw new Error(`Refusing an unrecognised tmux session name: ${JSON.stringify(sessionName)}`);
  }
  // Throws for anything outside the closed set — the same gate the direct
  // spawn path uses, so this route cannot become a way around it.
  const command = resolveAgentCommand(agentId);
  // `extraArgs` is the caller's ALREADY-RESOLVED argument list, so
  // command.args must not be added again: doing so emitted every base argument
  // twice (`bash -l -l` today, and silently doubling for whichever agent gains
  // a base argument next). resolveAgentCommand is still called above, for the
  // closed-set gate and for the executable name.
  const agentLine = [command.file, ...extraArgs].map(quote).join(' ');

  // `=` forces an EXACT match. Without it tmux matches by prefix, so a session
  // named `agenfk-ab` would be attached for `agenfk-abc123` — putting the user
  // inside another card's shell.
  const target = quote(`=${sessionName}`);
  const optTarget = quote(`=${sessionName}:`);
  const name = quote(sessionName);

  // `|| true` on each option: an older tmux that does not know one of these
  // must not take the attach down with it.
  const ensure = `(tmux has-session -t ${target} 2>/dev/null || tmux -u new-session -d -s ${name} ${quote(agentLine)})`;
  const configure = [
    `tmux set-option -t ${optTarget} history-limit 100000 2>/dev/null || true`,
    `tmux set-option -t ${optTarget} mouse on 2>/dev/null || true`,
  ].map(c => `(${c})`).join(' && ');
  // -u: agent output is full of box drawing and emoji, and without it tmux
  // mangles them.
  const attach = `tmux -u attach-session -t ${target}`;

  return `${ensure} && ${configure} && ${attach}`;
}
