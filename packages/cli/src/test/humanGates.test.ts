/**
 * @file CGLAB-382 (S6-T3) — the PR body carries the human gates: every
 * approval and override on the card and its descendants, with who, when, the
 * step, the check and the reason, so a reviewer sees what a person let through.
 */
import { describe, it, expect } from 'vitest';
import { buildPrBody, formatHumanGates, type GateEvent } from '../humanGates';

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
    expect(row.split(/(?<!\\)\|/).length).toBe(7);
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
