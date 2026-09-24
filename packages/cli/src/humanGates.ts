/**
 * CGLAB-382 — the human gates of a card tree, for the PR body: each approval a
 * person gave on the board, and each check they passed with a reason. A
 * reviewer needs to see what a person let through, so overrides come first.
 */
export interface GateEvent {
  itemId: string;
  title: string;
  step: string;
  kind: 'approval' | 'override' | 'manual-advance';
  /** On a manual-advance: the step the board moved the card to. */
  to?: string;
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
  // What a reviewer must look at first: checks a person passed, then steps the board skipped, then approvals.
  const rank = { override: 0, 'manual-advance': 1, approval: 2 } as const;
  const sorted = [...events].sort((a, b) => (rank[a.kind] - rank[b.kind]) || a.at.localeCompare(b.at));
  const rows = sorted.map(e => {
    const gate = e.kind === 'override' ? `🔓 overrode \`${cell(e.check)}\``
      : e.kind === 'manual-advance' ? `⏭ moved to ${cell(e.to)} on the board` : '✅ approved';
    const why = e.kind === 'override' ? e.reason : e.kind === 'manual-advance' ? 'dragged forward: verify and the step checks were skipped' : e.note;
    return `| ${cell(e.title)} | ${cell(e.step)} | ${gate} | ${cell(why) || '—'} | ${cell(e.at)} |`;
  });
  const overrides = events.filter(e => e.kind === 'override').length;
  const skipped = events.filter(e => e.kind === 'manual-advance').length;
  const lead = [
    overrides ? `A person passed ${overrides} blocked check${overrides === 1 ? '' : 's'} on the board.` : '',
    skipped ? `${skipped} step${skipped === 1 ? ' was' : 's were'} skipped by a drag on the board, without verify.` : '',
  ].filter(Boolean).join(' ');
  return [
    '## Human gates',
    '',
    lead ? `${lead} Review them with the reason given.` : 'Approvals a person gave on the board.',
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
