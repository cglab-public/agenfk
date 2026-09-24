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
  },
}));
vi.mock('../SocketContext', () => ({ useSocketEvent: vi.fn() }));

const result = (id: string, extra: Record<string, unknown> = {}) => ({
  id, step: 'WORK', source: 'flow', severity: 'block', params: {}, outcome: 'pass', detail: 'ok', blocking: false, ...extra,
});
const gates = (extra: Record<string, unknown> = {}) => ({
  step: 'WORK', approvalRequired: false, approvals: [], overrides: {}, lastChecks: null, ...extra,
});

function show(g: ReturnType<typeof gates>) {
  vi.mocked(api.getGates).mockResolvedValue(g as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StepChecksPanel itemId="c1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
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
