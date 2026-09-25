/**
 * c857900e — when a verify waits only for a person's approval, the CLI opens
 * the board and waits for it, then re-verifies, so the agent carries on with
 * no message in the chat. The pure parts: which refusals to wait on, when
 * waiting is allowed, and the bounded wait itself.
 */
import { describe, it, expect } from 'vitest';
import { onlyApprovalBlocks, waitAllowed, waitForApproval, alreadySatisfied } from '../approvalWait';

const check = (id: string, blocking: boolean) => ({ id, blocking });

describe('onlyApprovalBlocks', () => {
  it('is true when a person\'s approval is the only thing holding the card', () => {
    expect(onlyApprovalBlocks([check('human-approval', true), check('jira-key-valid', false)])).toBe(true);
  });
  it('is false when another check blocks too: waiting would never let the card go', () => {
    expect(onlyApprovalBlocks([check('human-approval', true), check('suite-green', true)])).toBe(false);
  });
  it('is false when nothing blocks, or nothing was reported', () => {
    expect(onlyApprovalBlocks([check('human-approval', false)])).toBe(false);
    expect(onlyApprovalBlocks(undefined)).toBe(false);
  });
});

describe('waitAllowed', () => {
  it('waits by default, TTY or not: an agent\'s shell has none', () => {
    expect(waitAllowed({}, { wait: true })).toBe(true);
  });
  it('does not wait with --no-wait, in CI, or with AGENFK_NO_BROWSER=1', () => {
    expect(waitAllowed({}, { wait: false })).toBe(false);
    expect(waitAllowed({ CI: 'true' }, { wait: true })).toBe(false);
    expect(waitAllowed({ AGENFK_NO_BROWSER: '1' }, { wait: true })).toBe(false);
  });
});

describe('waitForApproval', () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
  const gates = (approvals: number, step = 'DISCOVERY') => ({ step, approvals: Array.from({ length: approvals }, (_, i) => ({ at: `t${i}` })) });

  it('returns approved once an approval newer than the refusal lands', async () => {
    const c = clock();
    const seq = [gates(1), gates(1), gates(2)];
    let polls = 0;
    const r = await waitForApproval({ step: 'DISCOVERY', approvalsBefore: 1, poll: async () => seq[Math.min(polls++, 2)], intervalMs: 3000, deadlineMs: 60_000, ...c });
    expect(r).toBe('approved');
    expect(polls).toBe(3);
  });

  it('returns moved when the card has left the step some other way: nothing is left to wait for (C3b review)', async () => {
    const c = clock();
    const r = await waitForApproval({ step: 'DISCOVERY', approvalsBefore: 0, poll: async () => gates(0, 'CREATE_UNIT_TESTS'), intervalMs: 3000, deadlineMs: 60_000, ...c });
    expect(r).toBe('moved');
  });

  it('gives up at the deadline', async () => {
    const c = clock();
    let polls = 0;
    const r = await waitForApproval({ step: 'DISCOVERY', approvalsBefore: 0, poll: async () => { polls++; return gates(0); }, intervalMs: 3000, deadlineMs: 9_000, ...c });
    expect(r).toBe('timeout');
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(polls).toBeLessThanOrEqual(4);
  });

  it('keeps waiting through a failed poll: a blip is not an answer', async () => {
    const c = clock();
    let polls = 0;
    const r = await waitForApproval({ step: 'DISCOVERY', approvalsBefore: 0, poll: async () => { if (polls++ === 0) throw new Error('ECONNRESET'); return gates(1); }, intervalMs: 3000, deadlineMs: 60_000, ...c });
    expect(r).toBe('approved');
  });
});

/**
 * C3b: a command check waiting for a person's command approval is a person's
 * approval too. A verify blocked only by those (and/or the step's approval)
 * opens the board and waits, the same way.
 */
describe('waiting on a command approval (C3b)', () => {
  const waitingCommand = { id: 'command-check:lint', blocking: true, detail: 'waiting for a person to approve the command', meta: { waiting: { kind: 'command-approval', hash: 'h-lint', command: 'npm run lint' } } };
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

  it('onlyApprovalBlocks: a command waiting for a person counts as waiting for a person', () => {
    expect(onlyApprovalBlocks([waitingCommand])).toBe(true);
    expect(onlyApprovalBlocks([waitingCommand, check('human-approval', true)])).toBe(true);
  });

  it('onlyApprovalBlocks: a command check that FAILED is not waiting for anyone, whatever its words say', () => {
    const { meta: _m, ...failed } = waitingCommand;
    expect(onlyApprovalBlocks([{ ...failed, detail: 'waiting for a person to approve the command' }])).toBe(false);
  });

  it('waitForApproval: the approval of the command it waits on ends the wait', async () => {
    let n = 0;
    const poll = async () => ({ step: 'WORK', approvals: [], commandApprovals: n++ < 2 ? [] : [{ hash: 'h-lint', at: '2026-09-25T10:00:00Z' }] });
    const r = await waitForApproval({ step: 'WORK', approvalsBefore: 0, commandsWaitedOn: [{ hash: 'h-lint', approvedAt: null }], poll, intervalMs: 10, deadlineMs: 1000, ...clock() });
    expect(r).toBe('approved');
  });

  it('waitForApproval: approving an UNRELATED command in the same project does not end it', async () => {
    const poll = async () => ({ step: 'WORK', approvals: [], commandApprovals: [{ hash: 'h-other', at: '2026-09-25T10:00:00Z' }] });
    const r = await waitForApproval({ step: 'WORK', approvalsBefore: 0, commandsWaitedOn: [{ hash: 'h-lint', approvedAt: null }], poll, intervalMs: 10, deadlineMs: 100, ...clock() });
    expect(r).toBe('timeout');
  });

  it('alreadySatisfied: an approval that landed while the refused verify ran is caught at once', () => {
    const stepAndCommand = [check('human-approval', true), waitingCommand];
    // The person approved both while the command checks were running.
    expect(alreadySatisfied(stepAndCommand, { step: 'WORK', approvals: [{}], commandApprovals: [{ hash: 'h-lint', at: 't' }] })).toBe(true);
    // Only one of the two: still waiting.
    expect(alreadySatisfied(stepAndCommand, { step: 'WORK', approvals: [{}], commandApprovals: [] })).toBe(false);
    expect(alreadySatisfied(stepAndCommand, null)).toBe(false);
  });
});
