/**
 * Agent ids turned into names a person reads.
 *
 * One map, because there were already two places rendering agent names and a
 * third was about to appear. The tab strip, the sessions rail and the picker
 * all answer the same question, and when they disagreed the rail showed
 * `claude-code` while the picker beside it showed `Claude Code`.
 *
 * Presentation only. The ids are the contract with the main process; these
 * strings are never sent anywhere, and an unknown id falls back to itself
 * rather than to a guess — a name we invented would be worse than the raw id,
 * because it would look authoritative.
 */
const LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  pi: 'Pi',
  shell: 'Shell',
};

export function agentLabel(agentId: string): string {
  return LABELS[agentId] ?? agentId;
}

export const AGENT_LABELS = LABELS;
