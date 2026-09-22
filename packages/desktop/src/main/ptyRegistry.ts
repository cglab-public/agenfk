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
import { resolveAgentCommand, canDictateSessionId, HERDR_AGENT_ID } from './agents.js';
import { TitleReader, activityFromTitle } from './agentState.js';
import { buildPtyEnv } from './ptyEnv.js';
import { envWithoutHerdr, herdrAttachCommand } from './herdrAttach.js';
import { homedir } from 'node:os';
import { buildTmuxShellCommand, tmuxSessionName } from './tmux.js';
import { FlowControl } from './flowControl.js';
import { killProcessTree } from './processTree.js';

/** The slice of node-pty this module uses. Kept narrow so tests can stand in. */
export interface PtyLike {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /**
   * Stop and restart reading from the child.
   *
   * The two that make backpressure possible at all, and their absence is why
   * there was none: with no way to stop the producer, every byte a firehose
   * emitted had to be forwarded and held somewhere. node-pty has had both all
   * along ("for customizable flow control"); this interface simply never asked
   * for them. See flowControl.ts for when they are called.
   */
  pause(): void;
  resume(): void;
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
  /**
   * Where a session that belongs to no card runs.
   *
   * Ask AgEnFK opens an agent on an OBJECTIVE — there is no item yet, and
   * producing one first is exactly what that screen exists to avoid. The
   * renderer still sends an id and never a path: this resolves the project's
   * own checkout, the way `resolveCwd` resolves a card's worktree.
   */
  readonly resolveProjectCwd?: (projectId: string) => Promise<{ cwd: string }>;
  /**
   * An agent is being dispatched (BUG 53ed7163).
   *
   * Called when a PTY ACTUALLY STARTS, because that is the moment an agent
   * exists. Nothing registered a run before this: the tailer follows runs, the
   * parser reads the transcript and the panel draws the events, and the feed
   * was correctly empty forever - complete on both ends, disconnected in the
   * middle.
   */
  readonly registerRun?: (info: { itemId: string; agentId: string; agentSessionId?: string }) => void;
  /**
   * The first thing the agent is told: the card, in its own words.
   *
   * Handed to the CLI as an ARGUMENT at launch (agents.ts `promptArgs`), not
   * typed afterwards. Typing was a race nobody wins — these CLIs paint, load
   * their servers and only then take the terminal into raw mode, and anything
   * sent in that window is gone.
   *
   * Optional, and null-returning where there is nothing to say: a terminal
   * that opens empty is the old behaviour, not a failure. Resolved HERE rather
   * than sent by the renderer, so what starts the agent is the CARD's text and
   * not whatever a caller decided to put in somebody else's terminal.
   */
  readonly promptFor?: (itemId: string) => Promise<string | null>;

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
  /**
   * Signal a pty's whole process GROUP.
   *
   * Injected so a test can watch the reach rather than the signal. Agents
   * spawn MCP servers, npx and language servers, and `pty.kill()` reaches none
   * of them — see processTree.ts, where the dangerous half lives.
   */
  readonly killTree?: (pid: number, signal?: string, options?: { fallbackToPid?: boolean }) => void;
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
  /** The card this session belongs to. Empty when it belongs to an objective. */
  readonly itemId: string;
  /**
   * The project a card-less session runs in.
   *
   * Exactly one of `itemId` and `projectId` carries the session's identity. A
   * session on an objective has no card to take a worktree, a branch or a run
   * from, so it gets the project's checkout and registers nothing.
   */
  readonly projectId?: string;
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
  /** Bytes in flight to this session's terminal. See flowControl.ts. */
  readonly flow: FlowControl;
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

  /*
   * How many times sessions have been reaped, so a spawn can tell whether the
   * world it was started in still exists.
   *
   * There are two awaits between entering `spawn` and creating the pty —
   * resolving the worktree, which can run `git worktree add` and take seconds,
   * and recovering the login PATH, which has an eight second deadline. Every
   * reaper walks the session map as it is at that instant, so anything in
   * flight registers itself afterwards, into a window that is gone. What that
   * leaves is not a stray record: it is a real agent holding a real worktree,
   * with no tab, no window and no route to kill it.
   *
   * TWO counters, and the global one is not redundant. `killAll` has to
   * invalidate a spawn for a window the registry has never heard of, and the
   * only thing it can see is the session map — which an in-flight spawn is by
   * definition not in yet. A per-window counter alone misses exactly that.
   */
  private globalGeneration = 0;
  private readonly windowGeneration = new Map<number, number>();

  /**
   * End a session and everything it started.
   *
   * One method, called from all three reaping paths, because a missed path is
   * a leak that only ever shows up as "my fans are on".
   *
   * BOTH signals, deliberately. The group kill is the new reach; `pty.kill()`
   * is what already worked, and dropping it would make this a swap rather than
   * an addition — with a worse failure if a child turns out not to lead its
   * group. The direct child therefore gets the hangup twice, which costs
   * nothing: it is already on its way out from the first.
   */
  /**
   * The group killer, injected or real.
   *
   * An adapter because the two signatures differ: the injected dep takes
   * options third, the real function takes its own deps there. Calling the
   * default with the options in the wrong slot typechecked as a `KillDeps`
   * missing `kill` — caught by tsc, and the reason this is one place rather
   * than two call sites.
   */
  private get killTree(): (pid: number, signal?: string, options?: { fallbackToPid?: boolean }) => void {
    return this.deps.killTree ?? ((pid, signal, options) => killProcessTree(pid, signal, undefined, options));
  }

  private reap(session: Session): void {
    session.flow.dispose();
    /*
     * NOT GUARDED against a recycled pid, and that is a known gap rather than
     * an oversight.
     *
     * Between the OS reaping the child and node-pty delivering its exit — it
     * defers until the socket closes, up to 200ms — the session is still in
     * this map holding a pid the OS may already have handed to something else.
     * This app is an unusually bad place for that, because every pty child it
     * spawns is itself a group leader, so a recycled pid is disproportionately
     * likely to be a live pgid.
     *
     * An `exited` flag was tried and was dead code: by the time the exit is
     * known, the session has already been removed from the map, and during the
     * window itself there is nothing to set the flag from. Closing this
     * properly needs a liveness check at signal time, which is its own piece
     * of work rather than a line here.
     */
    this.killTree(session.pty.pid);
    session.pty.kill();
  }

  private generationOf(windowId: number): number {
    return this.globalGeneration + (this.windowGeneration.get(windowId) ?? 0);
  }

  constructor(private readonly deps: PtyRegistryDeps) {}

  /**
   * Open a terminal for a card.
   *
   * The renderer supplies only an item id and an agent id. The command comes
   * from the closed set in agents.ts and the directory from the resolver — so
   * an XSS in the renderer bundle cannot choose what runs or where.
   */
  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    /*
     * Captured BEFORE the first await. Everything below has to be able to ask
     * "is the world I was started in still here?", and the answer is only
     * meaningful against the moment the caller asked.
     */
    const generation = this.generationOf(req.windowId);

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

    const attaching = req.agentId === HERDR_AGENT_ID;

    /*
     * Two sources, one variable. An attach cannot come from `resolveAgentCommand`
     * because its id is deliberately absent from the agent table; it gets its
     * own closed set of one, gated by the equality above.
     */
    /*
     * The card's own words, resolved BEFORE the command is built, because they
     * become part of it. Never for an attach: that joins a session somebody
     * else started, possibly mid-edit, and a fresh prompt would interrupt work
     * already happening.
     */
    const prompt = !attaching && req.resume !== true && req.itemId && this.deps.promptFor
      // A card that cannot be read still gets a terminal. Failing the spawn
      // over the convenience would be the worse trade.
      ? await this.deps.promptFor(req.itemId).catch(() => null)
      : null;

    const command = attaching
      ? herdrAttachCommand()
      : resolveAgentCommand(req.agentId, {
          // Only on a FIRST launch. Resuming means the conversation already
          // exists — handing it the card again would start it over.
          prompt: req.resume === true ? undefined : (prompt ?? undefined),
          autoApprove: req.autoApprove === true,
          agentSessionId,
          resume: req.resume === true,
        });
    /*
     * An ATTACH resolves nothing.
     *
     * herdr is already running and already owns the panes; opening a view onto
     * it needs no card, no branch and no worktree - which is the whole reason
     * an adopted session works in its own directory rather than being dragged
     * into one of ours. The cwd below is only what a NEW pane would inherit if
     * somebody made one from inside; the session itself is unaffected by it.
     */
    // Resolve BEFORE spawning: a failure here must leave no half-registered
    // session behind, or later write/kill calls report an ownership problem
    // when the real problem was that the worktree could not be made.
    /*
     * Three origins for a working directory, and only one of them is a card.
     * The herdr attach runs from home because it is attaching to somebody
     * else's pane; an objective session runs in the project's own checkout,
     * because there is no card to cut a worktree from and cutting one would
     * mean creating the card this screen is trying to propose.
     */
    const onObjective = !req.itemId && !!req.projectId;
    if (onObjective && !this.deps.resolveProjectCwd) {
      throw new Error('This build cannot open a session on an objective.');
    }
    const { cwd } = attaching
      ? { cwd: homedir() }
      : onObjective
        ? await this.deps.resolveProjectCwd!(req.projectId!)
        : await this.deps.resolveCwd(req.itemId);

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
    const freshCommand = attaching
      // There is no "fresh" attach. The session exists or it does not, and a
      // retry that started something new would be the opposite of attaching.
      ? command
      : resolveAgentCommand(req.agentId, {
          // The prompt belongs to the FIRST launch. A retry that is really a
          // resume must not start the conversation over with it.
          prompt: prompt ?? undefined,
          autoApprove: req.autoApprove === true,
          agentSessionId,
          resume: false,
        });

    // Never for an attach: herdr IS the multiplexer that makes the session
    // outlive this app, so wrapping it in tmux would nest one inside the other
    // to buy something it already provides.
    /*
     * `!onObjective`, because the tmux session name is derived from the CARD:
     * two objectives would resolve to the same name and the second would
     * attach to the first's agent instead of starting its own.
     */
    const useTmux = !attaching && !onObjective
      && this.deps.tmux?.available === true && req.persist === true;
    /*
     * Under tmux the agent line only appears inside `new-session`, which
     * `has-session` short-circuits — so pressing Start on a card whose session
     * is STILL ALIVE reattaches to it and the card prompt is never delivered.
     * That is the right thing to do (the conversation is mid-flight; typing
     * into it would interrupt work), but doing it silently is not: the person
     * pressed a button that promised to hand the agent this card. Said once,
     * in the log, where the geometry lines already are.
     */
    if (useTmux && prompt) {
      console.log(`[PTY] tmux: an existing session for ${req.itemId} keeps its own prompt; the card was not re-sent`);
    }
    const file = useTmux ? '/bin/sh' : command.file;
    const args = useTmux
      ? ['-c', buildTmuxShellCommand(
          // The decision is part of the session's identity: a session created
          // with prompts disabled must not be silently reattached to after the
          // user turns that back off. See tmuxSessionName.
          // Named after the card, which an objective session does not have —
          // and two objectives must not collide into one tmux session, so this
          // path simply does not persist.
          tmuxSessionName(req.itemId, req.agentId, { autoApprove: req.autoApprove === true }),
          req.agentId,
          // The agent is nested a level deeper now; losing this here would
          // silently re-enable prompts the user turned off.
          command.args,
        )]
      : command.args;

    /*
     * Stripped AFTER the login-PATH capture, not instead of it: the capture is
     * what lets `herdr` be found at all.
     *
     * MEASURED: herdr launched from inside a herdr pane answers "nested herdr
     * is disabled by default" and exits. If this app was itself started from
     * such a terminal it inherits HERDR_PANE_ID, and every attach would die on
     * startup with a message nobody would trace back to here.
     */
    const baseEnv = buildPtyEnv(process.env, (await this.deps.loginPath?.()) ?? null);
    const env = attaching ? envWithoutHerdr(baseEnv) : baseEnv;

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
      /*
       * The window was reaped while we were resolving. Do not spawn.
       *
       * Checked here rather than after, and that is the point: registering the
       * process and killing it a moment later would still have run an agent
       * loose in the worktree for as long as it took to notice. The renderer
       * has had the mirror of this guard all along — a spawn that resolves
       * after its pane unmounted is explicitly killed — and the asymmetry was
       * the bug.
       */
      if (this.generationOf(req.windowId) !== generation) {
        /*
         * Thrown, not returned quietly. Returning left the caller holding a
         * session id that addresses nothing: a tab that paints no output, no
         * error and no exit banner, while every keystroke and every resize
         * rejected unhandled against `own()`. A silent dead tab is better than
         * the orphan it replaces and worse than saying so — and this method
         * already refuses out loud five lines above, when the window is at its
         * session cap.
         */
        throw new Error('This window was closed while the terminal was opening.');
      }
      const pty = this.deps.spawn(file, launchArgs, { cwd, cols: req.cols, rows: req.rows, env });
      // The geometry a session was born with, and every correction after it.
      // A terminal whose agent draws its input box somewhere the person cannot
      // see is a size disagreement, and this is the only place both numbers
      // are known.
      console.log(`[PTY] ${sessionId} spawned ${req.cols}x${req.rows} in ${cwd}`);
      /*
       * Backpressure, per session.
       *
       * Held here rather than in the renderer because the producer is here:
       * the only thing that can actually slow a firehose down is not reading
       * from it. The renderer's part is to say what it has drawn.
       */
      const flow = new FlowControl({ pause: () => pty.pause(), resume: () => pty.resume() });
      this.sessions.set(sessionId, { pty, windowId: req.windowId, flow });
      // The run exists from the moment the process does, so the tailer has
      // something to follow. The AGENT's id, not this registry's handle: the
      // transcript is named after the id the agent was given.
      /*
       * An attach registers NOTHING.
       *
       * `registerRun` means "this app dispatched an agent", and it did not -
       * the pane was already running, started by somebody else, possibly before
       * this app was open. Recording it would put a run in the feed that no
       * transcript backs, which is the same lie the tree rows refuse when they
       * carry a `herdr:` id instead of a real one.
       */
      if (!attaching) {
        // A run belongs to a card. An objective has none yet — that is the
        // whole point — so there is nothing to register against.
        if (req.itemId) {
          this.deps.registerRun?.({ itemId: req.itemId, agentId: req.agentId, agentSessionId });
        }
      }
      const startedAt = Date.now();

      /*
       * Reads the agent's own status out of the stream (BUG 192).
       *
       * A TAP, beside the forward and never instead of it: the bytes still
       * reach the terminal untouched, and this only watches them go past.
       *
       * Claude Code and Codex publish a spinner in the terminal TITLE while
       * they work. That is the agent declaring its state, where the old signal
       * — any output at all — only ever said "the terminal is drawn", which a
       * TUI repainting its footer makes permanently true.
       */
      const titles = new TitleReader();
      let activity = 'unknown';

      pty.onData(data => {
        // Only to the owner. Broadcasting would put one card's shell output —
        // including whatever the agent prints — into every open window.
        this.deps.emit(req.windowId, 'pty:data', { sessionId, data });


        /*
         * Counted in the same unit the renderer will ack in — the length of
         * the string that just crossed, not its encoded byte count. The two
         * sides only have to AGREE; an absolute measure of bytes on the wire
         * would be more accurate and, if only one side used it, wrong.
         */
        flow.sent(data.length);

        const title = titles.push(data);
        if (title === null) return;
        const next = activityFromTitle(req.agentId, title);
        // `unknown` never overwrites a state we had: an agent that stops
        // publishing has not told us it stopped working. And only on CHANGE,
        // or a repainting footer floods this channel exactly like the old one.
        if (next === 'unknown' || next === activity) return;
        activity = next;
        this.deps.emit(req.windowId, 'pty:activity', { sessionId, activity: next });
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
        // This pty is finished either way, so its accounting goes with it —
        // before the branch, because the relaunch below replaces the map entry
        // and would otherwise strand this one's grace-period timer.
        flow.dispose();
        /*
         * Still registered? A relaunch replaces a session UNDER THE SAME ID,
         * so if something removed that id first — the user pressed STOP, or a
         * reaper walked past — then re-inserting it puts a process back into a
         * map both reapers have already finished iterating. It would outlive
         * the window, and on quit it would outlive the app.
         */
        const stillOurs = this.sessions.get(sessionId)?.pty === pty;
        if (stillOurs && resuming && exitCode !== 0 && diedOnTheSpot) {
          // Said out loud. Silently swapping a resumed session for a fresh one
          // would leave the user believing they still have the context.
          this.deps.emit(req.windowId, 'pty:data', {
            sessionId,
            data: '\r\n\x1b[33mNothing to resume here — starting a new session.\x1b[0m\r\n',
          });
          launch(freshArgs, false);
          return;
        }
        /*
         * The user typed `exit`, or the agent died — which is how a session
         * ends MOST of the time, and this path did not reap.
         *
         * POSIX only sends SIGHUP to the terminal's FOREGROUND group when the
         * session leader dies, so anything the agent backgrounded or
         * daemonised — its MCP servers, an `npx` still running — survived
         * exactly as it did before the group kill existed.
         *
         * Signalled WITHOUT the bare-pid fallback: the leader is gone, so its
         * pid carries no evidence of who owns it now. The group is still safe,
         * because POSIX keeps a group alive while any member remains and the
         * kernel will not reuse a pid that is still a pgid.
         */
        const current = this.sessions.get(sessionId);
        if (current?.pty === pty) this.killTree(pty.pid, undefined, { fallbackToPid: false });
        // Dropped first so a later write cannot reach a dead pty, then the
        // window is told, or the tab simply stops responding and looks hung.
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
    // Ownership FIRST: a session id this window does not own is refused, and
    // logging it before the check reports a resize that never happened.
    const session = this.own(sessionId, windowId);
    console.log(`[PTY] ${sessionId} resized ${cols}x${rows}`);
    session.pty.resize(cols, rows);
  }

  /**
   * The renderer has drawn this much of what we sent it.
   *
   * Deliberately forgiving about an unknown session, unlike its neighbours: an
   * ack is a report about the past, and one arriving just after a session
   * exited is ordinary rather than a fault. Throwing would turn a routine race
   * into an error dialog.
   */
  ack(sessionId: string, windowId: number, bytes: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.windowId !== windowId) return;
    session.flow.acked(bytes);
  }

  kill(sessionId: string, windowId: number): void {
    const session = this.own(sessionId, windowId);
    /*
     * Dropped from the map BEFORE the signal, and the order is the fix.
     *
     * A pty may deliver its exit synchronously from inside `kill()` — nothing
     * in `PtySpawner`, which is a public injected interface, promises
     * otherwise. Killing first meant that at the moment `onExit` ran the map
     * still held this session, so a dying resume passed the "still ours" check,
     * relaunched, and registered a SECOND pty under the same id — which the
     * delete below then removed, leaving a live agent with no map entry and no
     * route to reach it. Measured on a fake with a synchronous exit: two
     * processes, one alive, zero sessions.
     *
     * Deleting first makes that check false by construction, rather than
     * relying on the timing of somebody else's callback.
     */
    this.sessions.delete(sessionId);
    this.reap(session);
  }

  /** A window closed. Its shells must not outlive it. */
  killAllForWindow(windowId: number): void {
    /*
     * Before the loop, and NOT for the reason it first appears.
     *
     * An awaiting `spawn` cannot resume inside this loop — the loop is wholly
     * synchronous. What the placement actually guards is a pty that delivers
     * its exit synchronously from `kill()` below and relaunches from inside
     * this very iteration. Between that and the delete-before-kill ordering in
     * `kill`, the relaunch is refused twice over.
     */
    this.windowGeneration.set(windowId, (this.windowGeneration.get(windowId) ?? 0) + 1);
    for (const [id, session] of [...this.sessions]) {
      if (session.windowId !== windowId) continue;
      // Delete first, for the reason `kill` gives: a synchronous exit must not
      // find its own session still registered.
      this.sessions.delete(id);
      this.reap(session);
    }
  }

  /** The app is quitting. */
  killAll(): void {
    this.globalGeneration += 1;
    for (const [id, session] of [...this.sessions]) {
      this.sessions.delete(id);
      this.reap(session);
    }
  }

  countForWindow(windowId: number): number {
    let n = 0;
    for (const session of this.sessions.values()) if (session.windowId === windowId) n += 1;
    return n;
  }
}
