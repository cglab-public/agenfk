/**
 * @vitest-environment jsdom
 *
 * GH-389 / #385: a card's AI usage, where you look at the card - the USAGE tab
 * beside Changed and Staged, and the card's own Usage tab. Not on the board:
 * token figures were taken off the cards on purpose (#9, #14).
 */
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UsageView } from '../components/UsageView';
import { WorktreePanel } from '../components/WorktreePanel';
import { api } from '../api';
import { guardTokens } from './helpers/tokenGuard';

vi.mock('../api', () => ({ api: { getItem: vi.fn(), getTokenEvents: vi.fn(), getGitStatus: vi.fn(), getFileDiff: vi.fn() } }));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);
guardTokens();

const totals = (o: Record<string, number> = {}) => ({ turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, unpricedTurns: 0, ...o });
const card = {
  id: 'i1', status: 'REVIEW', createdAt: '2026-11-19T08:00:00.000Z',
  history: [{ toStatus: 'REVIEW', timestamp: '2026-11-19T10:00:00.000Z' }],
  usageByStep: [{
    step: 'IN_PROGRESS', to: 'REVIEW', enteredAt: 'a', leftAt: 'b', complete: true,
    byModel: [{ client: 'pi', model: 'qwen3.8', ...totals({ turns: 3, input: 1200, cacheRead: 34000, cacheWrite: 500, output: 800, costUsd: 0.75 }) }],
    total: totals({ turns: 3, input: 1200, cacheRead: 34000, cacheWrite: 500, output: 800, costUsd: 0.75 }),
  }],
};

const wrap = (ui: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};

describe('UsageView', () => {
  it('shows the cost, each token kind and the steps', async () => {
    vi.mocked(api.getItem).mockResolvedValue(card as never);
    vi.mocked(api.getTokenEvents).mockResolvedValue([] as never);
    wrap(<UsageView itemId="i1" />);

    expect(await screen.findByText('$0.75')).toBeDefined();
    for (const label of [/^input$/i, /^cache read$/i, /^cache write$/i, /^output$/i]) expect(screen.getByText(label)).toBeDefined();
    expect(screen.getByText('34,000')).toBeDefined();
    expect(screen.getByRole('cell', { name: 'IN_PROGRESS' })).toBeDefined();
    expect(screen.getByText(/qwen3\.8/)).toBeDefined();
  });

  it('counts the current step live, from the turns ingested since the card entered it', async () => {
    vi.mocked(api.getItem).mockResolvedValue(card as never);
    vi.mocked(api.getTokenEvents).mockResolvedValue([
      { id: 'e', ts: '2026-11-19T10:30:00.000Z', client: 'pi', sessionId: 's', model: 'qwen3.8', input: 5, cachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0, total: 6, costUsd: 0.25 },
    ] as never);
    wrap(<UsageView itemId="i1" />);

    expect(await screen.findByText(/REVIEW \(now\)/)).toBeDefined();
    await waitFor(() => expect(api.getTokenEvents).toHaveBeenCalledWith({ itemId: 'i1', since: '2026-11-19T10:00:00.000Z' }));
    expect(await screen.findByText('$1.00')).toBeDefined();
  });

  it('says plainly when nothing was measured, and which harnesses are', async () => {
    vi.mocked(api.getItem).mockResolvedValue({ ...card, usageByStep: [] } as never);
    vi.mocked(api.getTokenEvents).mockResolvedValue([] as never);
    wrap(<UsageView itemId="i1" />);
    expect(await screen.findByText(/no usage recorded/i)).toBeDefined();
    expect(screen.getByText(/Claude Code, Codex and pi/)).toBeDefined();
  });

  it('marks an estimate as an estimate', async () => {
    const unpriced = { ...card, usageByStep: [{ ...card.usageByStep[0], byModel: [{ client: 'claude-code', model: 'claude-opus-5-5', ...totals({ turns: 1, unpricedTurns: 1, input: 1_000_000 }) }], total: totals({ turns: 1, unpricedTurns: 1, input: 1_000_000 }) }] };
    vi.mocked(api.getItem).mockResolvedValue(unpriced as never);
    vi.mocked(api.getTokenEvents).mockResolvedValue([] as never);
    wrap(<UsageView itemId="i1" prices={{ prices: [{ id: 'claude-opus-5-5', input: 10, output: 50 }] }} />);
    expect(await screen.findByText(/≈ \$10\.00/)).toBeDefined();
    expect(screen.getByText(/estimate/i)).toBeDefined();
  });
});

describe('the USAGE tab beside Changed and Staged (#385)', () => {
  it('is a third tab of the worktree panel, labelled with the card total', async () => {
    vi.mocked(api.getGitStatus).mockResolvedValue({ changed: 0, staged: 0, files: [] } as never);
    vi.mocked(api.getItem).mockResolvedValue(card as never);
    vi.mocked(api.getTokenEvents).mockResolvedValue([] as never);
    wrap(<WorktreePanel itemId="i1" />);

    // 1,200 + 34,000 + 500 + 800 tokens
    const tab = await screen.findByRole('tab', { name: 'Usage (37k)' });
    fireEvent.click(tab);
    expect(await screen.findByText('$0.75')).toBeDefined();
  });
});
