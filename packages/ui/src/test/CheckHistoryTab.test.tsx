/**
 * @vitest-environment jsdom
 *
 * 5ee2c3b1 — the card's Checks tab: the history of its verifies, approvals
 * and overrides, newest first, each with its date and every check's status.
 */
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CheckHistoryTab } from '../components/CheckHistoryTab';
import { api } from '../api';

vi.mock('../api', () => ({ api: { getCheckHistory: vi.fn() } }));
vi.mock('../SocketContext', () => ({ useSocketEvent: vi.fn() }));

const AT = '2026-09-24T21:05:00.000Z';
function show(history: unknown[]) {
  vi.mocked(api.getCheckHistory).mockResolvedValue(history as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><CheckHistoryTab itemId="c1" /></QueryClientProvider>);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('CheckHistoryTab', () => {
  it('says so when no check has run on the card yet', async () => {
    show([]);
    expect(await screen.findByText(/No checks have run on this card yet/i)).toBeDefined();
  });

  it('shows a refused verify: its step, date, and each check with its status and detail', async () => {
    show([{ kind: 'verify', step: 'DISCOVERY', at: AT, blocked: true, results: [
      { id: 'human-approval', outcome: 'fail', blocking: true, severity: 'block', detail: 'waiting for a person' },
      { id: 'jira-key-valid', outcome: 'pass', blocking: false, severity: 'block', detail: 'ABC-12' },
      { id: 'new-tests-born-green', outcome: 'fail', blocking: false, severity: 'warn', detail: 'already passing' },
    ] }]);
    const entry = await screen.findByTestId('check-history-entry');
    expect(within(entry).getByText(/DISCOVERY/)).toBeDefined();
    expect(within(entry).getByText(/Refused/i)).toBeDefined();
    expect(within(entry).getByText(new Date(AT).toLocaleString())).toBeDefined();
    const approval = within(entry).getByText('human-approval').closest('li')!;
    expect(within(approval).getByText(/blocked/i)).toBeDefined();
    expect(within(approval).getByText('waiting for a person')).toBeDefined();
    expect(within(within(entry).getByText('jira-key-valid').closest('li')!).getByText(/passed/i)).toBeDefined();
    expect(within(within(entry).getByText('new-tests-born-green').closest('li')!).getByText(/warning/i)).toBeDefined();
  });

  it('shows a passed verify as passed', async () => {
    show([{ kind: 'verify', step: 'WORK', at: AT, blocked: false, results: [{ id: 'suite-green', outcome: 'pass', blocking: false, severity: 'block', detail: '3 tests' }] }]);
    const entry = await screen.findByTestId('check-history-entry');
    expect(within(entry).getByText('Passed')).toBeDefined();
  });

  it('shows an approval with who gave it, when, and whether it was signed', async () => {
    show([
      { kind: 'approval', step: 'DISCOVERY', at: AT, by: 'board', authority: 'passkey', note: 'scope agreed' },
      { kind: 'approval', step: 'DISCOVERY', at: AT, by: 'board', authority: 'unverified' },
    ]);
    const [signed, plain] = await screen.findAllByTestId('check-history-entry');
    expect(within(signed).getByText(/Approved DISCOVERY/)).toBeDefined();
    expect(within(signed).getByText(/signed with a passkey/i)).toBeDefined();
    expect(within(signed).getByText(/scope agreed/)).toBeDefined();
    expect(within(plain).queryByText(/signed with a passkey/i)).toBeNull();
    expect(within(plain).getByText(/on the board/i)).toBeDefined();
  });

  it('shows an override with the check it passed and the reason', async () => {
    show([{ kind: 'override', step: 'WORK', at: AT, by: 'board', authority: 'unverified', check: 'jira-key-valid', reason: 'spike, no ticket' }]);
    const entry = await screen.findByTestId('check-history-entry');
    expect(within(entry).getByText(/Overrode jira-key-valid on WORK/)).toBeDefined();
    expect(within(entry).getByText(/spike, no ticket/)).toBeDefined();
  });

  it('keeps the order the server gives: newest first', async () => {
    show([
      { kind: 'verify', step: 'NEXT', at: '2026-09-24T22:00:00.000Z', blocked: false, results: [] },
      { kind: 'verify', step: 'WORK', at: '2026-09-24T21:00:00.000Z', blocked: true, results: [] },
    ]);
    const entries = await screen.findAllByTestId('check-history-entry');
    expect(entries.map(e => e.textContent)).toEqual([expect.stringMatching(/NEXT/), expect.stringMatching(/WORK/)]);
    await waitFor(() => expect(api.getCheckHistory).toHaveBeenCalledWith('c1'));
  });

  it('labels an agent check as agent-reported', async () => {
    show([{ kind: 'verify', step: 'WORK', at: AT, blocked: false, results: [{ id: 'agent-check:docs', outcome: 'pass', blocking: false, severity: 'block', detail: 'agent-reported: README updated', agentReported: true }] }]);
    const li = (await screen.findByText('agent-check:docs')).closest('li')!;
    expect(li.textContent).toMatch(/passed, agent-reported/);
  });
});
