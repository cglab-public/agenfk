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
}

/**
 * Menu order, default first. `shell` is not an agent — it is what a user wants
 * when nothing is installed, or when they just want to run git in the worktree.
 */
interface AgentEntry {
  readonly id: string;
  readonly label: string;
  readonly command: AgentCommand;
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

const AGENTS: ReadonlyArray<AgentEntry> = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: { file: 'claude', args: [] },
    autoApproveArgs: ['--dangerously-skip-permissions'],
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
  { id: 'pi', label: 'Pi', command: { file: 'pi', args: [] } },
  { id: 'gemini', label: 'Gemini CLI', command: { file: 'gemini', args: [] } },
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
  if (!opts.autoApprove || !found.autoApproveArgs?.length) return found.command;
  return { file: found.command.file, args: [...found.command.args, ...found.autoApproveArgs] };
}
