/**
 * CGLAB-382 — the human gates of a card tree, for the PR body: each approval a
 * person gave on the board, and each check they passed with a reason. A
 * reviewer needs to see what a person let through, so overrides come first.
 */
export interface GateEvent {
  itemId: string;
  title: string;
  step: string;
  kind: 'approval' | 'override';
  by: string;
  at: string;
  note?: string;
  check?: string;
  reason?: string;
}

/** One table cell: no pipe or newline may break the row. */
const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

export function formatHumanGates(events: readonly GateEvent[]): string {
  if (!events.length) return '';
  const sorted = [...events].sort((a, b) => (a.kind === b.kind ? a.at.localeCompare(b.at) : a.kind === 'override' ? -1 : 1));
  const rows = sorted.map(e => {
    const gate = e.kind === 'override' ? `🔓 overrode \`${cell(e.check)}\`` : '✅ approved';
    const why = e.kind === 'override' ? e.reason : e.note;
    return `| ${cell(e.title)} | ${cell(e.step)} | ${gate} | ${cell(why) || '—'} | ${cell(e.at)} |`;
  });
  const overrides = events.filter(e => e.kind === 'override').length;
  return [
    '## Human gates',
    '',
    overrides
      ? `A person passed ${overrides} blocked check${overrides === 1 ? '' : 's'} on the board. Review ${overrides === 1 ? 'it' : 'them'} with the reason given.`
      : 'Approvals a person gave on the board.',
    '',
    '| Card | Step | Gate | Reason / note | When |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** The PR body: what was given, then the human gates when there are any. */
export function buildPrBody(body: string, events: readonly GateEvent[]): string {
  const gates = formatHumanGates(events);
  if (!gates) return body;
  return body.trim() ? `${body}\n\n${gates}` : gates;
}
