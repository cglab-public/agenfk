/**
 * Which agent CLIs a terminal may launch, and nothing else (CGLAB-169).
 *
 * The renderer runs the same bundle a browser would. If it could name the
 * executable, an XSS in that bundle would be arbitrary code execution on the
 * user's machine, in their worktree, with their credentials. So the renderer
 * sends an ID from this set and the main process decides what to run. The
 * mapping is written down, never derived from the incoming string — a lookup
 * built as `{ file: id }` would look like indirection while still being
 * attacker-controlled text.
 *
 * The set is what AgEnFK actually integrates with (`agenfk integration list`),
 * minus Cursor: AgEnFK supports Cursor, but it is an editor with nothing to
 * spawn in a PTY, so offering it would put an option in the menu that cannot
 * work. `pi` is deliberately absent too — packages/server has a pi-parser, but
 * that is the read side of run ingestion, not an installable CLI.
 *
 * src/test/agents.test.ts asserts this list against the CLI's
 * INTEGRATION_LABELS, so adding an integration without considering it here
 * fails rather than silently drifting.
 */

export interface AgentCommand {
  /** Executable name. Resolved against PATH by the caller, never a path from the renderer. */
  readonly file: string;
  /** Fixed argv. node-pty takes file + argv and does not go through a shell. */
  readonly args: readonly string[];
}

export interface AgentChoice {
  readonly id: string;
  readonly label: string;
  /**
   * Whether this agent has a flag to skip its own permission prompts.
   *
   * Reported so the UI can disable the toggle with a reason, rather than
   * offering a control that quietly does nothing.
   */
  readonly supportsAutoApprove: boolean;
}

export interface SpawnOptions {
  /**
   * Run the agent with its own safety prompts disabled.
   *
   * Off unless explicitly requested. An agent in this mode edits, deletes and
   * pushes without asking, so it must never be something a caller gets by
   * forgetting a parameter.
   */
  readonly autoApprove?: boolean;
  /**
   * The conversation this terminal belongs to.
   *
   * WE generate it and hand it to the agent on a fresh spawn, rather than
   * discovering it afterwards — which is what makes resume work on the very
   * first terminal, with no hook installed and nothing to parse out of the
   * agent's output. Validated as a UUID before it reaches argv.
   */
  readonly agentSessionId?: string;
  /** Resume that conversation rather than starting it. */
  readonly resume?: boolean;
}

/**
 * Menu order, default first. `shell` is not an agent — it is what a user wants
 * when nothing is installed, or when they just want to run git in the worktree.
 */
/**
 * How one agent handles conversations, as argv TEMPLATES per mode.
 *
 * Templates rather than flags because the agents do not share a shape: claude
 * and pi take `--session-id` / `--resume` flags, while codex's resume is a
 * SUBCOMMAND that must come first. A flag-shaped design works for the first two
 * and breaks on the third.
 *
 * `fresh` returning an empty array means "this agent cannot be told its own
 * id" — true of codex, and different from having no descriptor at all, which
 * means "cannot resume".
 */
interface AgentSessionSupport {
  readonly fresh: (agentSessionId: string) => string[];
  readonly resume: (agentSessionId: string) => string[];
}

interface AgentEntry {
  readonly id: string;
  readonly label: string;
  readonly command: AgentCommand;
  /** Absent where the agent cannot resume, or where nobody has verified it. */
  readonly session?: AgentSessionSupport;
  /**
   * Argv to append when auto-approve is asked for. Separate entries, never one
   * string: a multi-token flag delivered as a single argv element reaches the
   * CLI as one nonsense option instead of the settings intended.
   *
   * Absent where the agent has no such flag. Inventing one would be worse than
   * ignoring the request — a wrong flag either fails the launch or means
   * something else entirely.
   */
  readonly autoApproveArgs?: readonly string[];
}

/** The shape of a conversation id we are willing to put in argv. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENTS: ReadonlyArray<AgentEntry> = [
  {
    // 'claude-code', not 'claude'. This is the SAME vocabulary the server's
    // client enum uses (server/index.ts) and that the hub already speaks in
    // pr.opened and token events. A parallel set of ids is what produced
    // "Unknown agent \"claude-code\"" the first time a run's harness reached
    // a spawn — and a mapping table between two lists in different packages
    // would have drifted again.
    id: 'claude-code',
    label: 'Claude Code',
    command: { file: 'claude', args: [] },
    autoApproveArgs: ['--dangerously-skip-permissions'],
    // Verified with `claude --help` on a real machine, not copied from a
    // reference implementation.
    session: {
      fresh: id => ['--session-id', id],
      resume: id => ['--resume', id],
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    command: { file: 'codex', args: [] },
    autoApproveArgs: [
      '-c', 'approval_policy=never',
      '-c', 'sandbox_mode=danger-full-access',
      '--dangerously-bypass-hook-trust',
    ],
    // The odd one out, and the reason this is an argv TEMPLATE per mode rather
    // than a resume flag appended at the end. codex has no way to be told its
    // own id on a fresh spawn (`fresh` returns nothing, deliberately — see
    // `canDictateSessionId`), and its resume is a SUBCOMMAND that comes before
    // everything else: `codex resume [SESSION_ID]`. Appended as a flag, codex
    // would read the id as a prompt.
    //
    // Never `codex resume --last`: that picks the most recently RECORDED
    // session, not the one belonging to this worktree. This product runs
    // parallel sessions across separate worktrees, so --last would cheerfully
    // resume another card's conversation.
    session: {
      fresh: () => [],
      resume: id => ['resume', id],
    },
  },
  // pi.dev. One of the DEEPEST integrations AgEnFK has: scripts/install.mjs
  // ships bin/agenfk-pi-extension.ts into ~/.pi/agent/extensions/, giving pi
  // NATIVE enforcement — pre-edit gatekeeper, mcp-enforcer and PR-sizing — not
  // the instructional kind. The server also parses its session transcripts
  // (agent-runs/pi-parser.ts).
  //
  // It is absent from the CLI's INTEGRATION_LABELS, which is a gap in that
  // list rather than a statement about pi. Trusting that list as the source of
  // truth is what left pi out of the first cut of this file.
  {
    id: 'pi',
    label: 'Pi',
    command: { file: 'pi', args: [] },
    // `pi --help`: "--session-id <id>  Use exact project session ID, creating
    // it if missing" — which is exactly the semantics dictating an id needs.
    session: {
      fresh: id => ['--session-id', id],
      resume: id => ['--resume', id],
    },
  },
  // No `session` descriptor, and that is a statement rather than an omission:
  // gemini was not installed on the machine where the others were verified with
  // `--help`, so claiming resume support would be guessing about a command line
  // nobody has run. It resolves to "cannot resume" until someone checks.
  { id: 'gemini', label: 'Gemini CLI', command: { file: 'gemini', args: [] } },
  // A login shell has no conversation to resume. Out by nature.
  { id: 'shell', label: 'Shell', command: { file: process.platform === 'win32' ? 'powershell.exe' : 'bash', args: ['-l'] } },
];

export const AGENT_IDS: readonly string[] = AGENTS.map(a => a.id);

/** The picker's contents. Labels are for people; ids are the wire format. */
export function listAgents(): AgentChoice[] {
  return AGENTS.map(({ id, label, autoApproveArgs }) => ({
    id,
    label,
    supportsAutoApprove: Boolean(autoApproveArgs?.length),
  }));
}

/**
 * Map an id from the renderer to a command.
 *
 * Exact match only: no trimming, no case folding, no normalisation. Anything
 * that is not literally one of the written-down ids is refused, which covers
 * absolute paths, traversal, shell metacharacters and empty values without
 * needing a rule for each.
 */
export function resolveAgentCommand(agentId: string, opts: SpawnOptions = {}): AgentCommand {
  const found = AGENTS.find(a => a.id === agentId);
  if (!found) {
    throw new Error(`Unknown agent "${String(agentId)}". Expected one of: ${AGENT_IDS.join(', ')}`);
  }

  // Session arguments go FIRST. codex's resume is a subcommand, so it has to
  // precede everything, and no agent here needs the opposite order.
  const sessionArgs: string[] = [];
  if (opts.agentSessionId !== undefined) {
    if (!UUID_RE.test(opts.agentSessionId)) {
      // Refused, never escaped. This string is handed to a process as an
      // argument, and it is generated by us — so a bad one is a bug, and argv
      // is exactly where "it is ours, so it is fine" stops being safe.
      throw new Error(`Refusing an unrecognised session id: ${JSON.stringify(opts.agentSessionId)}`);
    }
    const build = opts.resume ? found.session?.resume : found.session?.fresh;
    // Absent for agents that cannot do this. Emitting a flag they do not know
    // would stop them launching at all, which is worse than not resuming.
    if (build) sessionArgs.push(...build(opts.agentSessionId));
  }

  const approveArgs = opts.autoApprove && found.autoApproveArgs?.length ? found.autoApproveArgs : [];
  if (!sessionArgs.length && !approveArgs.length) return found.command;
  return { file: found.command.file, args: [...sessionArgs, ...found.command.args, ...approveArgs] };
}

/** Whether this agent can resume a conversation at all. */
export function canResume(agentId: string): boolean {
  return Boolean(AGENTS.find(a => a.id === agentId)?.session?.resume);
}

/**
 * Whether we can choose the conversation's id ourselves.
 *
 * False for codex: it resumes, but only by an id it assigned. Callers need the
 * distinction because it decides whether a fresh terminal can be made
 * resumable at the moment it is opened, or whether the id has to be discovered
 * afterwards.
 */
export function canDictateSessionId(agentId: string): boolean {
  const fresh = AGENTS.find(a => a.id === agentId)?.session?.fresh;
  return Boolean(fresh && fresh('3f2504e0-4f89-11d3-9a0c-0305e82c3301').length > 0);
}
