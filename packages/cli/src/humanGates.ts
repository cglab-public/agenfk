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
  /** A command check whose pass another card's run at the same tree state gave it (3ffc9651). */
  reusedFrom?: { itemId: string; at: string };
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
        ? (r.reusedFrom ? `server ran it for [${cell(r.reusedFrom.itemId.slice(0, 8))}] at this same tree state; shared${r.approval ? `; approved by ${cell(r.approval.by)}${r.approval.authority === 'passkey' ? ' 🔐' : ''}` : ''}` : r.ran ? `server ran it${r.approval ? `; approved by ${cell(r.approval.by)}${r.approval.authority === 'passkey' ? ' 🔐' : ''}` : ''}` : `not run: ${cell(r.detail ?? '')}`)
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

/** A failing warning a card left a step with, and the agent's answer (CGLAB-420), as the server lists it. */
export interface TreeWarningRow { itemId: string; title: string; step: string; check: string; detail: string; answer?: string }

/**
 * CGLAB-420: the warnings the checks raised in a card tree. A PR reviewer sees
 * what the checks doubted and what the agent said, unanswered ones first.
 */
export function formatTreeWarnings(rows: readonly TreeWarningRow[]): string {
  if (!rows.length) return '';
  const open = rows.filter(r => !r.answer).length;
  const sorted = [...rows].sort((a, b) => Number(!!a.answer) - Number(!!b.answer));
  return [
    '## Warnings the checks raised',
    '',
    open ? `${open} of ${rows.length} ${open === 1 ? 'was' : 'were'} never answered.` : `Each was answered by the coding agent; the answer is its word.`,
    '',
    '| Card | Step | Check | What it found | Answer |',
    '| --- | --- | --- | --- | --- |',
    ...sorted.map(r => `| ${cell(r.title)} | ${cell(r.step)} | \`${cell(r.check)}\` | ${cell(r.detail)} | ${r.answer ? cell(r.answer) : '⚠️ not answered'} |`),
  ].join('\n');
}

/** CGLAB-428: a check a card left a step with switched off by the org's hub, as the server lists it. */
export interface DisabledCheckRow { itemId: string; title: string; step: string; check: string; source: string; at: string }

/**
 * 890be63f: read a card tree's switched-off checks. A 404 is a server from
 * before CGLAB-428, which has no such route and no way to switch a check off:
 * nothing to list and nothing to warn about. Any other failure is reported in
 * `failed` (the status, or the error), so the caller can say the PR will not
 * list them.
 */
export async function readDisabledChecks(get: () => Promise<{ data: unknown }>): Promise<{ rows: DisabledCheckRow[]; failed: string | null }> {
  try {
    const data = (await get()).data;
    return { rows: Array.isArray(data) ? (data as DisabledCheckRow[]) : [], failed: null };
  } catch (e: any) {
    if (e?.response?.status === 404) return { rows: [], failed: null };
    return { rows: [], failed: String(e?.response?.status ?? e?.message ?? e) };
  }
}

/**
 * CGLAB-428: the checks the org's hub switched off on the steps a card tree
 * left. They did not run, so a reviewer must know which safeguards were absent.
 */
export function formatDisabledChecks(rows: readonly DisabledCheckRow[]): string {
  if (!rows.length) return '';
  const from = (source: string) => (source === 'role' ? "the step's role" : source === 'universal' ? 'every step' : 'the flow');
  return [
    "## Checks switched off by the org's hub",
    '',
    `${rows.length} check${rows.length === 1 ? ' was' : 's were'} not run: a hub admin switched ${rows.length === 1 ? 'it' : 'them'} off on the step.`,
    '',
    '| Card | Step | Check | Came from | When |',
    '| --- | --- | --- | --- | --- |',
    ...[...rows].sort((a, b) => a.at.localeCompare(b.at)).map(r => `| ${cell(r.title)} | ${cell(r.step)} | \`${cell(r.check)}\` | ${from(r.source)} | ${cell(r.at)} |`),
  ].join('\n');
}

/** The checks' history of a card tree, for a PR: human gates, custom checks, warnings, checks switched off; empty when there is none. */
export function checkHistory(events: readonly GateEvent[], customChecks: readonly CustomCheckRow[] = [], warnings: readonly TreeWarningRow[] = [], disabled: readonly DisabledCheckRow[] = []): string {
  return [formatHumanGates(events), formatCustomChecks(customChecks), formatTreeWarnings(warnings), formatDisabledChecks(disabled)].filter(Boolean).join('\n\n');
}

/** The PR body: what was given, then the checks' history when there is any. */
export function buildPrBody(body: string, events: readonly GateEvent[], customChecks: readonly CustomCheckRow[] = [], warnings: readonly TreeWarningRow[] = [], disabled: readonly DisabledCheckRow[] = []): string {
  const extra = checkHistory(events, customChecks, warnings, disabled);
  if (!extra) return body;
  return body.trim() ? `${body}\n\n${extra}` : extra;
}

/**
 * CGLAB-420: `agenfk pr-register` follows a PR opened with plain `gh pr
 * create`, whose body carries none of this. The history goes on as a comment,
 * so the PR shows what the checks let through either way; null when there is
 * nothing to say.
 */
export function prRegisterComment(events: readonly GateEvent[], customChecks: readonly CustomCheckRow[] = [], warnings: readonly TreeWarningRow[] = [], disabled: readonly DisabledCheckRow[] = []): string | null {
  const history = checkHistory(events, customChecks, warnings, disabled);
  return history ? `### AgEnFK check history\n\nWhat the workflow checks recorded for this PR's cards.\n\n${history}` : null;
}
