/**
 * The live PTY sessions (CGLAB-169).
 *
 * A session is a real child process holding a real shell in a real worktree,
 * so two properties matter more than the happy path:
 *
 *  1. **Sessions are owned.** A session id is just a string once it reaches the
 *     renderer. Without an ownership check any window could write into any
 *     other window's shell, which is keystroke injection into a process running
 *     with the user's credentials in their repository.
 *  2. **Sessions are reaped.** A PTY outlives the window that opened it unless
 *     something kills it, and a shell attached to a worktree with no window in
 *     front of it is a process the user cannot find or stop.
 *
 * The spawner and the cwd resolver are injected, so neither the ownership rules
 * nor the reaping need real processes to test.
 */
import { randomUUID } from 'crypto';
import { resolveAgentCommand, canDictateSessionId } from './agents.js';
import { buildPtyEnv } from './ptyEnv.js';
import { buildTmuxShellCommand, tmuxSessionName } from './tmux.js';

/** The slice of node-pty this module uses. Kept narrow so tests can stand in. */
export interface PtyLike {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtySpawner = (
  file: string,
  args: readonly string[],
  opts: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv },
) => PtyLike;

export interface PtyRegistryDeps {
  readonly spawn: PtySpawner;
  /** Resolves the worktree for a card. Throws rather than falling back. */
  readonly resolveCwd: (itemId: string) => Promise<{ cwd: string; branchName: string | null }>;
  /** Sends a message to one window only. */
  readonly emit: (windowId: number, channel: string, payload: unknown) => void;
  /**
   * The PATH recovered from a login shell, if one was obtained at boot.
   *
   * This is the same PATH agent detection probes with, and handing it to the
   * spawn is the point: detecting against one PATH and launching against
   * another is how a picker that says "Installed" produces ENOENT.
   */
  readonly loginPath?: () => string | null;
  /**
   * Whether sessions should survive the app closing.
   *
   * When tmux is available the agent runs INSIDE a tmux session and our PTY is
   * only a view attached to it, so closing the app detaches instead of killing.
   * When it is not, the agent is spawned directly — a working terminal without
   * persistence, rather than a failure.
   */
  readonly tmux?: { readonly available: boolean };
}

/** What a spawn gives back: a live process, and the conversation it holds. */
export interface SpawnResult {
  readonly sessionId: string;
  readonly agentSessionId?: string;
}

export interface SpawnRequest {
  readonly itemId: string;
  readonly agentId: string;
  readonly windowId: number;
  readonly cols: number;
  readonly rows: number;
  /** Run the agent with its own permission prompts disabled. Off by default. */
  readonly autoApprove?: boolean;
  /**
   * Keep the session alive after the app quits, by running it inside tmux.
   *
   * Off by default, and only honoured where tmux exists. Running inside tmux
   * changes the terminal the agent lives in — the tmux prefix competes with
   * the agent's own shortcuts — which is a change to opt into rather than
   * discover, and sessions that predate the feature kept working without it.
   */
  readonly persist?: boolean;
  /**
   * The conversation to resume, when resuming.
   *
   * Omitted on a fresh spawn: the registry MINTS one here, because this is
   * where the validation lives and where argv is assembled. Generating it in
   * the renderer would move an untrusted value one step closer to a process
   * argument for no benefit at all.
   */
  readonly agentSessionId?: string;
  readonly resume?: boolean;
}

interface Session {
  readonly pty: PtyLike;
  readonly windowId: number;
}

/**
 * One message for "you do not own this" and for "this does not exist".
 *
 * Distinguishing them would let a renderer enumerate other windows' sessions by
 * comparing errors, which is the whole thing ownership is here to prevent.
 */
const UNKNOWN_SESSION = 'Unknown session.';

export class PtyRegistry {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly deps: PtyRegistryDeps) {}

  /**
   * Open a terminal for a card.
   *
   * The renderer supplies only an item id and an agent id. The command comes
   * from the closed set in agents.ts and the directory from the resolver — so
   * an XSS in the renderer bundle cannot choose what runs or where.
   */
  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    // Minted here, not in the renderer: this is where the UUID is validated and
    // where argv is assembled. Only for agents that can actually be told their
    // own id — returning one we never handed over would be a lie the caller
    // stores and later tries to resume with.
    const agentSessionId = req.agentSessionId
      ?? (canDictateSessionId(req.agentId) ? randomUUID() : undefined);

    const command = resolveAgentCommand(req.agentId, {
      autoApprove: req.autoApprove === true,
      agentSessionId,
      resume: req.resume === true,
    });
    // Resolve BEFORE spawning: a failure here must leave no half-registered
    // session behind, or later write/kill calls report an ownership problem
    // when the real problem was that the worktree could not be made.
    const { cwd } = await this.deps.resolveCwd(req.itemId);

    // Inside tmux when we can. The session name is derived from the card and
    // the agent, so reopening ATTACHES to the one still running rather than
    // starting a second agent beside it in the same worktree.
    // Both: the machine can, AND the project asked. Either alone is not enough.
    const useTmux = this.deps.tmux?.available === true && req.persist === true;
    const file = useTmux ? '/bin/sh' : command.file;
    const args = useTmux
      ? ['-c', buildTmuxShellCommand(
          // The decision is part of the session's identity: a session created
          // with prompts disabled must not be silently reattached to after the
          // user turns that back off. See tmuxSessionName.
          tmuxSessionName(req.itemId, req.agentId, { autoApprove: req.autoApprove === true }),
          req.agentId,
          // The agent is nested a level deeper now; losing this here would
          // silently re-enable prompts the user turned off.
          command.args,
        )]
      : command.args;

    const pty = this.deps.spawn(file, args, {
      cwd,
      cols: req.cols,
      rows: req.rows,
      // Never process.env directly. It carries launchd's minimal PATH, no TERM
      // at all, and every variable describing how Electron was launched.
      env: buildPtyEnv(process.env, this.deps.loginPath?.()),
    });

    // Opaque and unguessable, and deliberately not derived from the item id:
    // a session id travels to the renderer, and one built from a card id would
    // let a window address a session it never opened just by knowing the card.
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { pty, windowId: req.windowId });

    pty.onData(data => {
      // Only to the owner. Broadcasting would put one card's shell output —
      // including whatever the agent prints — into every open window.
      this.deps.emit(req.windowId, 'pty:data', { sessionId, data });
    });

    pty.onExit(({ exitCode }) => {
      // The user typed `exit`, or the agent died. Drop the entry first so a
      // later write cannot reach a dead pty, then tell the window, or the tab
      // simply stops responding and looks hung.
      this.sessions.delete(sessionId);
      this.deps.emit(req.windowId, 'pty:exit', { sessionId, exitCode });
    });

    // Two ids, and they are not the same kind of thing. `sessionId` addresses
    // a live process for write/resize/kill and dies with it; `agentSessionId`
    // addresses a CONVERSATION and is the only reason a restored terminal is
    // worth anything. Returned together so no caller has to guess which one a
    // bare "sessionId" meant — sending a pty handle to `--resume` would
    // silently start a fresh conversation.
    return { sessionId, agentSessionId };
  }

  private own(sessionId: string, windowId: number): Session {
    const session = this.sessions.get(sessionId);
    if (!session || session.windowId !== windowId) throw new Error(UNKNOWN_SESSION);
    return session;
  }

  write(sessionId: string, windowId: number, data: string): void {
    this.own(sessionId, windowId).pty.write(data);
  }

  resize(sessionId: string, windowId: number, cols: number, rows: number): void {
    this.own(sessionId, windowId).pty.resize(cols, rows);
  }

  kill(sessionId: string, windowId: number): void {
    const session = this.own(sessionId, windowId);
    session.pty.kill();
    this.sessions.delete(sessionId);
  }

  /** A window closed. Its shells must not outlive it. */
  killAllForWindow(windowId: number): void {
    for (const [id, session] of [...this.sessions]) {
      if (session.windowId !== windowId) continue;
      session.pty.kill();
      this.sessions.delete(id);
    }
  }

  /** The app is quitting. */
  killAll(): void {
    for (const [id, session] of [...this.sessions]) {
      session.pty.kill();
      this.sessions.delete(id);
    }
  }

  countForWindow(windowId: number): number {
    let n = 0;
    for (const session of this.sessions.values()) if (session.windowId === windowId) n += 1;
    return n;
  }
}
