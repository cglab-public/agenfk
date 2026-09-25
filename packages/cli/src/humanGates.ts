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
  /** How the act was authorised: signed with a passkey, or the board's word (CGLAB-383). */
  authority?: 'passkey' | 'unverified';
  /** On a manual-advance: the step the board moved the card to. */
  to?: string;
  by: string;
  at: string;
  note?: string;
  check?: string;
  reason?: string;
}

/** One table cell: no pipe or newline may break the row. */
// Backslashes first: a reason ending in `\` would otherwise turn the escaped
// pipe after it back into a column separator.
const cell = (s: unknown) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

export function formatHumanGates(events: readonly GateEvent[]): string {
  if (!events.length) return '';
  // What a reviewer must look at first: checks a person passed, then steps the board skipped, then approvals.
  const rank = { override: 0, 'manual-advance': 1, approval: 2 } as const;
  const sorted = [...events].sort((a, b) => (rank[a.kind] - rank[b.kind]) || a.at.localeCompare(b.at));
  const rows = sorted.map(e => {
    const gate = e.kind === 'override' ? `🔓 overrode \`${cell(e.check)}\``
      : e.kind === 'manual-advance' ? `⏭ moved to ${cell(e.to)} on the board` : '✅ approved';
    const why = e.kind === 'override' ? e.reason : e.kind === 'manual-advance' ? 'dragged forward: verify and the step checks were skipped' : e.note;
    const signed = e.kind === 'manual-advance' ? '—' : e.authority === 'passkey' ? '🔐 passkey' : 'unverified';
    return `| ${cell(e.title)} | ${cell(e.step)} | ${gate} | ${cell(why) || '—'} | ${signed} | ${cell(e.at)} |`;
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
    '| Card | Step | Gate | Reason / note | Signed | When |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** One custom check a card passed a step with (C3b), as the server lists it. */
export interface CustomCheckRow {
  itemId: string;
  title: string;
  step: string;
  check: string;
  /** 'command': the server ran it. 'agent': the coding agent reported it. */
  kind: 'command' | 'agent';
  outcome: string;
  at: string;
  note?: string;
  detail?: string;
  /** A command check: did the server actually run it? */
  ran?: boolean;
  /** An agent check: did the agent actually report it? */
  reported?: boolean;
  /** Who let a command that asks for a person run, as recorded when it ran. */
  approval?: { by: string; at: string; authority?: string };
  /** A person passed it on the board instead. */
  overridden?: { by: string; reason: string };
}

/**
 * The custom checks of a card tree, for the PR body (C3b). What a reviewer
 * needs is WHOSE word each result is: the server's, having run the command, or
 * the agent's, taken as given.
 */
export function formatCustomChecks(rows: readonly CustomCheckRow[]): string {
  if (!rows.length) return '';
  const agent = rows.filter(r => r.kind === 'agent' && r.reported).length;
  const lines = [...rows].sort((a, b) => a.at.localeCompare(b.at)).map(r => {
    // Whose word the result is, from what the check did - never from the kind alone.
    const how = r.overridden ? `🔓 overridden by ${cell(r.overridden.by)}: ${cell(r.overridden.reason)}`
      : r.kind === 'command'
        ? (r.ran ? `server ran it${r.approval ? `; approved by ${cell(r.approval.by)}${r.approval.authority === 'passkey' ? ' 🔐' : ''}` : ''}` : `not run: ${cell(r.detail ?? '')}`)
        : (r.reported ? 'agent-reported (not checked by the server)' : 'not reported by the agent');
    const outcome = r.outcome === 'pass' ? '✅ pass' : `❌ ${cell(r.outcome)}`;
    return `| ${cell(r.title)} | ${cell(r.step)} | \`${cell(r.check)}\` | ${outcome} | ${how} | ${cell(r.note ?? '') || '—'} |`;
  });
  return [
    '## Custom checks',
    '',
    agent ? `${agent} result${agent === 1 ? ' was' : 's were'} reported by the coding agent and taken on its word.` : 'Every result below was checked by the server.',
    '',
    '| Card | Step | Check | Outcome | How | Note |',
    '| --- | --- | --- | --- | --- | --- |',
    ...lines,
  ].join('\n');
}

/** The PR body: what was given, then the human gates and custom checks when there are any. */
export function buildPrBody(body: string, events: readonly GateEvent[], customChecks: readonly CustomCheckRow[] = []): string {
  const extra = [formatHumanGates(events), formatCustomChecks(customChecks)].filter(Boolean).join('\n\n');
  if (!extra) return body;
  return body.trim() ? `${body}\n\n${extra}` : extra;
}
