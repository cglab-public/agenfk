/**
 * Finding the proposal inside what a terminal printed.
 *
 * The agent answers in a pty, so what comes back is not JSON — it is JSON
 * wrapped in whatever the agent says around it, carrying ANSI colour, cursor
 * moves and the prompt that follows. The screen has to pick the answer out of
 * that without asking the person to do it by eye.
 *
 * Deliberately NOT a parser of terminal semantics: no cursor emulation, no
 * scrollback model. It strips the escapes, finds balanced braces, and takes
 * the LAST complete object that parses and looks like a proposal — last,
 * because an agent often thinks aloud first and may print a sketch before the
 * real answer.
 */

/** CSI and OSC sequences, reduced to nothing. */
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(raw: string): string {
  return raw.replace(ANSI, '');
}

/** Does this look like the thing we asked for, rather than any JSON at all? */
function isProposal(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tree = value as Record<string, unknown>;
  return Array.isArray(tree.items) && typeof tree.objective === 'string';
}

/**
 * The last balanced `{...}` in the text that parses AND looks like a proposal.
 *
 * Brace counting rather than a regex, and quote-aware, because a title
 * containing `}` would otherwise end the object early — and titles are written
 * by people about code.
 */
export function extractProposal(output: string): unknown | null {
  const text = stripAnsi(output);
  let found: unknown | null = null;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            if (isProposal(parsed)) found = parsed;
          } catch { /* not this one */ }
          break;
        }
      }
    }
  }
  return found;
}
