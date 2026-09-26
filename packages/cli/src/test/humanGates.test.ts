/**
 * @file CGLAB-382 (S6-T3) — the PR body carries the human gates: every
 * approval and override on the card and its descendants, with who, when, the
 * step, the check and the reason, so a reviewer sees what a person let through.
 */
import { describe, it, expect } from 'vitest';
import { buildPrBody, formatHumanGates, formatCustomChecks, type GateEvent, type CustomCheckRow } from '../humanGates';

const override: GateEvent = { itemId: 'c1', title: 'Fix the picker', step: 'WORK', kind: 'override', check: 'jira-key-valid', reason: 'spike card, no issue', by: 'board', at: '2026-09-24T10:00:00.000Z' };
const approval: GateEvent = { itemId: 'c2', title: 'Plan it', step: 'DISCOVERY', kind: 'approval', note: 'go', by: 'board', at: '2026-09-24T09:00:00.000Z' };

describe('formatHumanGates', () => {
  it('is empty when no person approved or overrode anything', () => {
    expect(formatHumanGates([])).toBe('');
  });

  it('names each override: card, step, check and the reason', () => {
    const md = formatHumanGates([override]);
    expect(md).toMatch(/## Human gates/);
    expect(md).toMatch(/Fix the picker/);
    expect(md).toMatch(/WORK/);
    expect(md).toMatch(/jira-key-valid/);
    expect(md).toMatch(/spike card, no issue/);
  });

  it('escapes a backslash, so a reason ending in one cannot unescape the column pipe (CodeQL)', () => {
    const md = formatHumanGates([{ ...override, reason: 'path C:\\ | next' }]);
    const row = md.split('\n').find(l => l.includes('Fix the picker'))!;
    expect(row).toContain('path C:\\\\ \\| next');
    // The row still has exactly its own column separators: every other pipe is escaped.
    expect(row.replace(/\\\\/g, '').replace(/\\\|/g, '').split('|').length).toBe(md.split('\n').find(l => /^\|/.test(l))!.split('|').length);
  });

  it('lists approvals too, with their note', () => {
    const md = formatHumanGates([approval, override]);
    expect(md).toMatch(/DISCOVERY/);
    expect(md).toMatch(/approved/i);
    expect(md).toMatch(/go/);
  });

  it('lists overrides before approvals: they are what a reviewer must look at', () => {
    const md = formatHumanGates([approval, override]);
    expect(md.indexOf('jira-key-valid')).toBeLessThan(md.indexOf('DISCOVERY'));
  });

  it('keeps a reason from breaking the markdown table', () => {
    const md = formatHumanGates([{ ...override, reason: 'a | b\nc' }]);
    const row = md.split('\n').find(l => l.includes('jira-key-valid'))!;
    expect(row.split(/(?<!\\)\|/).length).toBe(8);
    expect(md).toMatch(/a \\\| b c/);
  });
});

describe('board moves on the PR (CGLAB-382 review)', () => {
  it('lists a forward drag on the board, which skipped the step checks', () => {
    const md = formatHumanGates([{ itemId: 'c3', title: 'Dragged', step: 'PLAN', kind: 'manual-advance', to: 'WORK', by: 'board', at: '2026-09-24T11:00:00.000Z' }]);
    expect(md).toMatch(/Dragged/);
    expect(md).toMatch(/PLAN/);
    expect(md).toMatch(/WORK/);
    expect(md).toMatch(/skipp/i);
  });
});

describe('authority on the PR (CGLAB-383)', () => {
  it('says which acts were signed with a passkey and which were not', () => {
    const md = formatHumanGates([{ ...override, authority: 'passkey' }, { ...approval, authority: 'unverified' }]);
    const rows = md.split('\n');
    expect(rows.find(r => r.includes('jira-key-valid'))).toMatch(/passkey/);
    expect(rows.find(r => r.includes('DISCOVERY'))).toMatch(/unverified/);
  });

  it('treats an act from before authority was recorded as unverified', () => {
    expect(formatHumanGates([override]).split('\n').find(r => r.includes('jira-key-valid'))).toMatch(/unverified/);
  });
});

describe('buildPrBody', () => {
  it('appends the human gates to the body given', () => {
    expect(buildPrBody('Body text', [override])).toMatch(/^Body text\n\n## Human gates/);
  });

  it('leaves the body alone when there are none', () => {
    expect(buildPrBody('Body text', [])).toBe('Body text');
  });

  it('works with an empty body', () => {
    expect(buildPrBody('', [override])).toMatch(/^## Human gates/);
  });
});

/**
 * C3b: custom checks on the PR. A reviewer must see which results the server
 * checked itself and which it took on the agent's word, and who let a command
 * run.
 */
describe('formatCustomChecks (C3b)', () => {
  const cmd: CustomCheckRow = { itemId: 'c1', title: 'Add mul', step: 'WORK', check: 'lint', kind: 'command', outcome: 'pass', ran: true, at: '2026-09-25T10:00:00.000Z', approval: { by: 'board', at: '2026-09-25T09:59:00.000Z', authority: 'passkey' } };
  const said: CustomCheckRow = { itemId: 'c1', title: 'Add mul', step: 'WORK', check: 'docs', kind: 'agent', outcome: 'pass', reported: true, note: 'README | has it', at: '2026-09-25T10:00:00.000Z' };

  it('is empty with no custom checks', () => {
    expect(formatCustomChecks([])).toBe('');
  });

  it('labels each result: run by the server, or reported by the agent', () => {
    const md = formatCustomChecks([cmd, said]);
    expect(md).toMatch(/## Custom checks/);
    const lint = md.split('\n').find(l => l.includes('`lint`'))!;
    const docs = md.split('\n').find(l => l.includes('`docs`'))!;
    expect(lint).toMatch(/server ran it/i);
    expect(lint).toMatch(/🔐/);
    expect(docs).toMatch(/agent-reported/i);
    expect(docs).toContain('README \\| has it');
  });

  // 3ffc9651: a pass another card's run gave this one says so, naming that card - not "not run", not "ran it" for this card.
  it('a shared command-check pass names the card whose run it was', () => {
    const md = formatCustomChecks([{ ...cmd, ran: false, approval: undefined, reusedFrom: { itemId: 'abcdef1234567890', at: '2026-09-25T09:00:00.000Z' }, detail: 'reused: lint exited 0 in the run of card abcdef12' }]);
    const lint = md.split('\n').find(l => l.includes('`lint`'))!;
    expect(lint).toMatch(/server ran it for \[abcdef12\] at this same tree state; shared/);
    expect(lint).not.toMatch(/not run/);
  });

  it('never says the server ran a command that did not run, or that the agent reported what it did not (C3b review)', () => {
    const md = formatCustomChecks([
      { ...cmd, check: 'waiting', ran: false, outcome: 'overridden', overridden: { by: 'board', reason: 'no linter on CI' }, detail: 'waiting for a person to approve the command' },
      { ...cmd, check: 'registry', ran: false, outcome: 'fail', approval: undefined, detail: 'not run: registry flow' },
      { ...said, check: 'silent', reported: false, note: undefined, outcome: 'fail' },
    ]);
    const row = (name: string) => md.split('\n').find(l => l.includes('`' + name + '`'))!;
    expect(row('waiting')).toMatch(/overridden by board: no linter on CI/);
    expect(row('waiting')).not.toMatch(/server ran it/);
    expect(row('registry')).toMatch(/not run/);
    expect(row('registry')).not.toMatch(/server ran it/);
    expect(row('silent')).toMatch(/not reported/);
    expect(md).not.toMatch(/reported by the coding agent and taken on its word/);
  });

  it('goes on the PR after the body and the human gates', () => {
    const body = buildPrBody('Summary', [], [cmd]);
    expect(body.startsWith('Summary')).toBe(true);
    expect(body).toMatch(/## Custom checks/);
  });

  it('leaves the body alone when there is nothing to add', () => {
    expect(buildPrBody('Summary', [], [])).toBe('Summary');
  });
});
