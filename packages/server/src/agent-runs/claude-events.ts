/**
 * Claude Code hook payloads → agent-run events (CGLAB-177).
 *
 * The runs pipeline was built around the pi worker, which writes a JSONL
 * transcript the server tails. Claude Code writes no such file, so the bridge
 * runs the other way: its hooks push events into `POST /agent-runs/:id/events`,
 * which already accepts a generic shape. No second parser, and no dependency
 * on pi being installed.
 *
 * The mapping lives here rather than in the hook script because it is the part
 * with decisions in it, and a hook is a bad place for untested logic: it runs
 * out of sight, and anything it gets wrong fails silently.
 */

/** Event kinds the server accepts. Mirrors RUN_EVENT_KINDS in server.ts. */
export const RUN_EVENT_KINDS = new Set([
  'dispatch', 'think', 'tool', 'result', 'diff', 'verdict', 'note',
]);

/** Lanes the server accepts. Mirrors RUN_ACTORS in server.ts. */
type Lane = 'orchestrator' | 'worker' | 'reviewer';

export interface ClaudeHookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown> | unknown;
  session_id?: string;
}

export interface RunEvent {
  lane: Lane;
  kind: string;
  tool?: string;
  text?: string;
}

/**
 * Tools worth a line in a transcript. Reads and searches are deliberately
 * absent: recording every one makes the log unreadable and still tells you
 * nothing about what the agent actually changed.
 */
const RECORDED = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'Task', 'WebFetch', 'Artifact']);

/** Longest text we store per event. Enough to recognise, short enough to read. */
const TEXT_LIMIT = 400;

const clip = (value: string): string =>
  value.length <= TEXT_LIMIT ? value : `${value.slice(0, TEXT_LIMIT)}…`;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Describe a tool call in one line.
 *
 * Only ever from fields that name *what was touched* — a path, a command, a
 * description. Never from a field carrying content: a hook sees every tool
 * input, file bodies routinely hold tokens and keys, and a run transcript is
 * stored and rendered back to whoever opens the card.
 */
function describe(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return clip(str(input.command) || str(input.description) || 'shell command');
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return clip(str(input.file_path) || 'file');
    case 'Task':
      return clip(str(input.description) || str(input.subagent_type) || 'sub-agent');
    case 'WebFetch':
      return clip(str(input.url) || 'fetch');
    default:
      return toolName;
  }
}

/**
 * Convert one hook payload into an event, or null when it should not be
 * recorded. Never throws: a hook that crashes takes the tool call with it.
 */
export function toRunEvent(payload: ClaudeHookPayload | null | undefined): RunEvent | null {
  try {
    const toolName = str(payload?.tool_name);
    if (!toolName || !RECORDED.has(toolName)) return null;

    const input = asRecord(payload?.tool_input);

    // Spawning a sub-agent IS orchestration. Putting it on the worker lane
    // would render a fan-out as one agent doing everything itself.
    if (toolName === 'Task') {
      return {
        lane: 'orchestrator',
        kind: 'dispatch',
        tool: toolName,
        text: describe(toolName, input),
      };
    }

    const editing = toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit';
    return {
      lane: 'worker',
      kind: editing ? 'diff' : 'tool',
      tool: toolName,
      text: describe(toolName, input),
    };
  } catch {
    return null;
  }
}
