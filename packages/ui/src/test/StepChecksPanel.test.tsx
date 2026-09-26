/**
 * @vitest-environment jsdom
 *
 * CGLAB-382 (S6-T2) — the card's step checks on the board: the last verify's
 * results, a go-ahead for a step that waits for one, and an override (with a
 * required reason) on each check that blocks the card.
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StepChecksPanel } from '../components/StepChecksPanel';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    getGates: vi.fn(),
    approveStep: vi.fn(() => Promise.resolve({})),
    overrideCheck: vi.fn(() => Promise.resolve({})),
    getPasskeyStatus: vi.fn(() => Promise.resolve({ enrolled: true, credentials: [{ id: 'cred-1' }] })),
    passkeyChallenge: vi.fn(() => Promise.resolve({ challenge: 'ch-1', allowCredentials: ['cred-1'] })),
    enrollPasskey: vi.fn(() => Promise.resolve({ id: 'cred-1' })),
  },
}));
vi.mock('../webauthn', () => ({
  canSignHere: vi.fn(() => true),
  createPasskey: vi.fn(() => Promise.resolve({ credentialId: 'cred-1' })),
  signAct: vi.fn(() => Promise.resolve({ credentialId: 'cred-1', signature: 's' })),
  handoffUrl: vi.fn(() => 'http://localhost:3000/?item=c1'),
}));
import * as webauthn from '../webauthn';
vi.mock('../SocketContext', () => ({ useSocketEvent: vi.fn() }));
vi.mock('../commandApprovals', () => ({
  argvHash: vi.fn(async () => 'hash-1'),
  approveCommand: vi.fn(() => Promise.resolve({})),
  listCommandApprovals: vi.fn(() => Promise.resolve([])),
}));
import * as commandApprovals from '../commandApprovals';

const result = (id: string, extra: Record<string, unknown> = {}) => ({
  id, step: 'WORK', source: 'flow', severity: 'block', params: {}, outcome: 'pass', detail: 'ok', blocking: false, ...extra,
});
const gates = (extra: Record<string, unknown> = {}) => ({
  step: 'WORK', approvalRequired: false, passkeyRequired: false, approvals: [], overrides: {}, lastChecks: null, ...extra,
});

function show(g: ReturnType<typeof gates>, projectId?: string) {
  vi.mocked(api.getGates).mockResolvedValue(g as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StepChecksPanel itemId="c1" projectId={projectId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(webauthn.canSignHere).mockReturnValue(true); });
afterEach(() => cleanup());

describe('StepChecksPanel', () => {
  it('shows nothing for a step with no checks run and no go-ahead to give', async () => {
    const { container } = show(gates());
    await waitFor(() => expect(api.getGates).toHaveBeenCalledWith('c1'));
    expect(container.textContent).toBe('');
  });

  it("lists the last verify's results with their detail", async () => {
    show(gates({ lastChecks: { step: 'WORK', at: 'now', blocked: false, results: [result('suite-green', { detail: '12 tests, exit code 0' })] } }));
    expect(await screen.findByText(/suite-green/)).toBeTruthy();
    expect(screen.getByText(/12 tests, exit code 0/)).toBeTruthy();
  });

  it('asks for a go-ahead and records it with the note', async () => {
    show(gates({ step: 'PLAN', approvalRequired: true }));
    const note = await screen.findByLabelText(/note/i);
    fireEvent.change(note, { target: { value: 'looks right' } });
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(api.approveStep).toHaveBeenCalledWith('c1', { step: 'PLAN', note: 'looks right' }));
  });

  it('shows a given go-ahead instead of the button', async () => {
    show(gates({ step: 'PLAN', approvalRequired: true, approvals: [{ by: 'board', at: '2026-09-24T10:00:00Z', note: 'go' }] }));
    expect(await screen.findByText(/approved/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('overrides a blocking check only with a reason', async () => {
    show(gates({ lastChecks: { step: 'WORK', at: 'now', blocked: true, results: [result('jira-key-valid', { outcome: 'fail', blocking: true, detail: 'no JIRA key' })] } }));
    fireEvent.click(await screen.findByRole('button', { name: /override jira-key-valid/i }));
    const confirm = screen.getByRole('button', { name: /pass this check/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'spike card, no issue' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(api.overrideCheck).toHaveBeenCalledWith('c1', { step: 'WORK', checkId: 'jira-key-valid', reason: 'spike card, no issue' }));
  });

  it('offers no override on a check that does not block', async () => {
    show(gates({ lastChecks: { step: 'WORK', at: 'now', blocked: false, results: [result('suite-green'), result('new-tests-born-green', { outcome: 'fail', severity: 'warn' })] } }));
    await screen.findByText(/suite-green/);
    expect(screen.queryByRole('button', { name: /override/i })).toBeNull();
  });

  it('shows an override already given, with its reason', async () => {
    show(gates({
      lastChecks: { step: 'WORK', at: 'now', blocked: true, results: [result('jira-key-valid', { outcome: 'fail', blocking: true })] },
      overrides: { 'jira-key-valid': { id: 'o1', by: 'board', at: 'now', reason: 'spike card, no issue' } },
    }));
    expect(await screen.findByText(/spike card, no issue/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /override jira-key-valid/i })).toBeNull();
  });

  it('lets the go-ahead stand for the human-approval check: no second row, no override of it', async () => {
    show(gates({
      step: 'PLAN', approvalRequired: true, approvals: [{ by: 'board', at: '2026-09-24T10:00:00Z' }],
      lastChecks: { step: 'PLAN', at: 'now', blocked: true, results: [result('human-approval', { outcome: 'fail', blocking: true, detail: 'waiting for a person' }), result('on-card-branch')] },
    }));
    await screen.findByText(/on-card-branch/);
    expect(screen.queryByText(/waiting for a person/)).toBeNull();
    expect(screen.queryByRole('button', { name: /override human-approval/i })).toBeNull();
  });

  it('lists blocking checks first', async () => {
    show(gates({ lastChecks: { step: 'WORK', at: 'now', blocked: true, results: [result('suite-green'), result('jira-key-valid', { outcome: 'fail', blocking: true })] } }));
    await screen.findByText(/suite-green/);
    const text = screen.getByTestId('step-checks').textContent ?? '';
    expect(text.indexOf('jira-key-valid')).toBeLessThan(text.indexOf('suite-green'));
  });

  it("shows the server's refusal", async () => {
    vi.mocked(api.approveStep).mockRejectedValueOnce({ response: { data: { error: 'The card is on WORK, not PLAN' } } });
    show(gates({ step: 'PLAN', approvalRequired: true }));
    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    expect(await screen.findByText(/The card is on WORK, not PLAN/)).toBeTruthy();
  });
});

describe('StepChecksPanel: a step that asks for a passkey (CGLAB-383)', () => {
  it('signs the go-ahead for this card, step and note, and sends the assertion', async () => {
    show(gates({ step: 'PLAN', approvalRequired: true, passkeyRequired: true }));
    fireEvent.change(await screen.findByLabelText(/note/i), { target: { value: 'ok' } });
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(api.approveStep).toHaveBeenCalledWith('c1', { step: 'PLAN', note: 'ok', assertion: { credentialId: 'cred-1', signature: 's' } }));
    expect(api.passkeyChallenge).toHaveBeenCalledWith({ purpose: 'approval', itemId: 'c1', step: 'PLAN', note: 'ok' });
    expect(webauthn.signAct).toHaveBeenCalledWith('ch-1', ['cred-1']);
  });

  it('signs an override for this check and reason', async () => {
    show(gates({ passkeyRequired: true, lastChecks: { step: 'WORK', at: 'now', blocked: true, results: [result('jira-key-valid', { outcome: 'fail', blocking: true })] } }));
    fireEvent.click(await screen.findByRole('button', { name: /override jira-key-valid/i }));
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'spike' } });
    fireEvent.click(screen.getByRole('button', { name: /pass this check/i }));
    await waitFor(() => expect(api.overrideCheck).toHaveBeenCalledWith('c1', { step: 'WORK', checkId: 'jira-key-valid', reason: 'spike', assertion: { credentialId: 'cred-1', signature: 's' } }));
    expect(api.passkeyChallenge).toHaveBeenCalledWith({ purpose: 'override', itemId: 'c1', step: 'WORK', checkId: 'jira-key-valid', reason: 'spike' });
  });

  it('offers to enroll a passkey when none is, and enrolls it', async () => {
    vi.mocked(api.getPasskeyStatus).mockResolvedValue({ enrolled: false, credentials: [] } as never);
    show(gates({ step: 'PLAN', approvalRequired: true, passkeyRequired: true }));
    fireEvent.click(await screen.findByRole('button', { name: /enroll a passkey/i }));
    await waitFor(() => expect(api.enrollPasskey).toHaveBeenCalledWith({ credentialId: 'cred-1' }));
    expect(api.passkeyChallenge).toHaveBeenCalledWith({ purpose: 'enroll' });
    expect(screen.queryByRole('button', { name: /^approve/i })).toBeNull();
  });

  it('where this page cannot sign (the desktop app on 127.0.0.1), hands the act off to the browser', async () => {
    vi.mocked(webauthn.canSignHere).mockReturnValue(false);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    show(gates({ step: 'PLAN', approvalRequired: true, passkeyRequired: true }));
    fireEvent.click(await screen.findByRole('button', { name: /approve in the browser/i }));
    expect(open).toHaveBeenCalledWith('http://localhost:3000/?item=c1', '_blank');
    expect(api.approveStep).not.toHaveBeenCalled();
    // A note typed here would be lost in the hand-off: it is written where the act is signed.
    expect(screen.queryByLabelText(/note/i)).toBeNull();
  });

  it('a step that does not ask for a passkey never prompts for one', async () => {
    show(gates({ step: 'PLAN', approvalRequired: true, passkeyRequired: false }));
    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    await waitFor(() => expect(api.approveStep).toHaveBeenCalledWith('c1', { step: 'PLAN' }));
    expect(webauthn.signAct).not.toHaveBeenCalled();
  });

  it('marks a signed approval as signed', async () => {
    show(gates({ step: 'PLAN', approvalRequired: true, passkeyRequired: true, approvals: [{ by: 'board', at: '2026-09-24T10:00:00Z', authority: 'passkey' }] }));
    expect(await screen.findByText(/signed with a passkey/i)).toBeTruthy();
  });

  // efcacdeb (C4): custom checks on the board.
  it('labels an agent check as agent-reported', async () => {
    show(gates({ lastChecks: { step: 'WORK', at: 'x', blocked: false, results: [result('agent-check:docs', { agentReported: true, detail: 'agent-reported: README updated' })] } }));
    const li = (await screen.findByText('agent-check:docs')).closest('li')!;
    expect(li.textContent).toMatch(/agent-reported/);
  });

  it('shows a command waiting for approval and approves it, signed with a passkey', async () => {
    const argv = ['npm', 'run', 'lint'];
    show(gates({ lastChecks: { step: 'WORK', at: 'x', blocked: true, results: [result('command-check:lint', {
      outcome: 'fail', blocking: true, params: { name: 'lint', argv: JSON.stringify(argv), approval: 'person' },
      detail: `waiting for a person to approve the command ${JSON.stringify(argv)} on the board (signed with a passkey).`,
    })] } }), 'p1');
    const button = await screen.findByRole('button', { name: /approve this command/i });
    expect(screen.getByText('npm run lint')).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(commandApprovals.approveCommand).toHaveBeenCalledWith('p1', argv, { credentialId: 'cred-1', signature: 's' }));
    expect(api.passkeyChallenge).toHaveBeenCalledWith({ purpose: 'command', itemId: 'p1', checkId: 'hash-1' });
  });

  it('offers no command approval for a command check that is simply failing', async () => {
    show(gates({ lastChecks: { step: 'WORK', at: 'x', blocked: true, results: [result('command-check:lint', {
      outcome: 'fail', blocking: true, params: { name: 'lint', argv: '["npm","run","lint"]', approval: 'none' }, detail: '["npm","run","lint"] exited 1: 2 problems',
    })] } }), 'p1');
    await screen.findByText('command-check:lint');
    expect(screen.queryByRole('button', { name: /approve this command/i })).toBeNull();
  });

  // 83e4e956: once a person approved the command, say so until the next verify runs it.
  it('shows a command approved since the last verify as approved, with no button', async () => {
    const argv = ['npm', 'run', 'lint'];
    vi.mocked(commandApprovals.listCommandApprovals).mockResolvedValue([{ argv, at: '2026-09-25T00:17:38Z', authority: 'passkey' }] as never);
    show(gates({ lastChecks: { step: 'WORK', at: 'x', blocked: true, results: [result('command-check:lint', {
      outcome: 'fail', blocking: true, params: { name: 'lint', argv: JSON.stringify(argv), approval: 'person' },
      detail: 'waiting for a person to approve the command npm run lint on the board (signed with a passkey).',
    })] } }), 'p1');
    expect(await screen.findByText(/Approved with a passkey.*runs on the next verify/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve this command/i })).toBeNull();
    expect(commandApprovals.listCommandApprovals).toHaveBeenCalledWith('p1');
  });
});
