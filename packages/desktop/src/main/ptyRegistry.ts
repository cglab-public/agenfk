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
   * The PATH a login shell would have.
   *
   * May answer with a PROMISE, and that is what lets the app paint before the
   * capture finishes. `spawn` is already async, so a terminal opened in the
   * first second waits for the same capture instead of being handed null and
   * a degraded PATH — which is the very thing the capture exists to prevent.
   */
  readonly loginPath?: () => string | null | Promise<string | null>;
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
/**
 * How many terminals one window may have running at once.
 *
 * Far above any real use — nobody opens thirty agents by hand — because the
 * point is not to ration, it is to bound. Each spawn is a real child process,
 * the map only shrinks on exit, kill or window close, and this module's own
 * header threat-models an XSS in the renderer: a loop on `pty:spawn` created
 * processes without limit. `countForWindow` was written as the cap and never
 * given a caller.
 */
/**
 * How quickly a resume has to die to count as "could not find it".
 *
 * Generous on purpose. An agent that refuses to start prints its message and
 * exits in well under a second; one that actually resumed is still running
 * minutes later. Anything in between is rare, and erring long only costs a
 * needless fresh session — erring short would leave the dead tab this exists
 * to prevent.
 */
const RESUME_FAILURE_MS = 5_000;

export const MAX_SESSIONS_PER_WINDOW = 30;

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
    // Checked BEFORE anything is created, so a refusal leaves nothing behind.
    if (this.countForWindow(req.windowId) >= MAX_SESSIONS_PER_WINDOW) {
      throw new Error(
        `Too many terminals open in this window (${MAX_SESSIONS_PER_WINDOW}). Close one first.`,
      );
    }
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
    /*
     * The same command, asked for fresh rather than resumed.
     *
     * Rebuilt from the descriptor rather than by stripping a flag off `args`:
     * the modes are argv TEMPLATES, not a base plus a switch — codex's resume
     * is a SUBCOMMAND (`codex resume <id>`), so there is no flag to remove.
     */
    const freshCommand = resolveAgentCommand(req.agentId, {
      autoApprove: req.autoApprove === true,
      agentSessionId,
      resume: false,
    });

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

    const env = buildPtyEnv(process.env, (await this.deps.loginPath?.()) ?? null);

    // Opaque and unguessable, and deliberately not derived from the item id:
    // a session id travels to the renderer, and one built from a card id would
    // let a window address a session it never opened just by knowing the card.
    const sessionId = randomUUID();

    /**
     * Start a pty and wire it under `sessionId`.
     *
     * Extracted so a failed RESUME can be replaced by a fresh session UNDER THE
     * SAME ID. The renderer is bound to that id — a new one would leave the tab
     * addressing a process that does not exist.
     */
    const launch = (launchArgs: readonly string[], resuming: boolean): void => {
      const pty = this.deps.spawn(file, launchArgs, { cwd, cols: req.cols, rows: req.rows, env });
      this.sessions.set(sessionId, { pty, windowId: req.windowId });
      const startedAt = Date.now();

      pty.onData(data => {
        // Only to the owner. Broadcasting would put one card's shell output —
        // including whatever the agent prints — into every open window.
        this.deps.emit(req.windowId, 'pty:data', { sessionId, data });
      });

      pty.onExit(({ exitCode }) => {
        /*
         * A RESUME that died on the spot could not find what it was asked to
         * continue. Start fresh instead of leaving a dead tab.
         *
         * `claude --continue` means "the most recent conversation IN THIS
         * DIRECTORY", and nothing can know whether one exists until it runs:
         * a worktree created moments ago has never had the agent in it, and
         * the agent only persists a conversation after an exchange — so
         * opening a terminal, saying nothing and closing it records a session
         * row with no conversation behind it. Both are ordinary, and both left
         * "No conversation found to continue" and an exit code 1 on screen.
         *
         * Resuming is a courtesy. Starting fresh is the correct behaviour when
         * there is nothing to resume, so the failure must not be terminal.
         *
         * Narrow on purpose:
         *  - only a resume, because a plain session exiting is just an exit;
         *  - only an EARLY exit, because an agent that ran for ten minutes and
         *    then exited finished work rather than failed to start;
         *  - only ONCE, or a command that always fails becomes a spawn loop.
         */
        const diedOnTheSpot = Date.now() - startedAt < RESUME_FAILURE_MS;
        if (resuming && exitCode !== 0 && diedOnTheSpot) {
          // Said out loud. Silently swapping a resumed session for a fresh one
          // would leave the user believing they still have the context.
          this.deps.emit(req.windowId, 'pty:data', {
            sessionId,
            data: '\r\n\x1b[33mNothing to resume here — starting a new session.\x1b[0m\r\n',
          });
          launch(freshArgs, false);
          return;
        }
        // The user typed `exit`, or the agent died. Drop the entry first so a
        // later write cannot reach a dead pty, then tell the window, or the tab
        // simply stops responding and looks hung.
        this.sessions.delete(sessionId);
        this.deps.emit(req.windowId, 'pty:exit', { sessionId, exitCode });
      });
    };

    /*
     * Not under tmux. There the agent runs INSIDE a tmux session and our pty is
     * a view attached to it, so an exit here means the view detached — the
     * agent is still alive, and respawning would start a SECOND one beside it
     * in the same worktree.
     */
    const freshArgs = freshCommand.args;
    launch(args, req.resume === true && !useTmux);

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
