/**
 * @vitest-environment jsdom
 *
 * GH-389 / #385: a card's AI usage, where you look at the card - the USAGE tab
 * beside Changed and Staged, and the card's own Usage tab. Not on the board:
 * token figures were taken off the cards on purpose (#9, #14).
 *
 * Laid out to be read at a glance (redesign after the end-to-end run): a
 * summary of cost, tokens and turns; the token mix as one stacked bar with a
 * legend; then where the tokens went - by sub-card on a parent, by step, by
 * model - each row with a bar in proportion to the largest.
 */
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UsageView } from '../components/UsageView';
import { WorktreePanel } from '../components/WorktreePanel';
import { api } from '../api';
import { guardTokens } from './helpers/tokenGuard';

vi.mock('../api', () => ({ api: { getItem: vi.fn(), getTokenEvents: vi.fn(), listItems: vi.fn(), getGitStatus: vi.fn(), getFileDiff: vi.fn(), getPriceTable: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listItems).mockResolvedValue([] as never);
  vi.mocked(api.getTokenEvents).mockResolvedValue([] as never);
  vi.mocked(api.getPriceTable).mockResolvedValue(null as never);
});
afterEach(cleanup);
guardTokens();

const totals = (o: Record<string, number> = {}) => ({ turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, unpricedTurns: 0, ...o });
const row = (step: string, to: string, t: Record<string, number>, byModel: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  step, to, enteredAt: '2026-11-19T09:00:00.000Z', leftAt: '2026-11-19T10:00:00.050Z', complete: true, byModel, total: totals(t), ...extra,
});
const piModel = (t: Record<string, number>) => ({ client: 'pi', model: 'qwen3.8', ...totals(t) });
const work = { turns: 3, input: 1200, cacheRead: 34000, cacheWrite: 500, output: 800, costUsd: 0.75 };
const card = {
  id: 'i1', status: 'REVIEW', createdAt: '2026-11-19T08:00:00.000Z',
  history: [{ toStatus: 'REVIEW', timestamp: '2026-11-19T10:00:00.000Z' }],
  usageByStep: [row('TODO', 'IN_PROGRESS', {}), row('IN_PROGRESS', 'REVIEW', work, [piModel(work)])],
};

const wrap = (ui: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};
const section = (name: string) => screen.getByRole('region', { name });

describe('UsageView', () => {
  it('sums it up first: cost marked reported, total tokens, turns', async () => {
    vi.mocked(api.getItem).mockResolvedValue(card as never);
    wrap(<UsageView itemId="i1" />);

    const summary = await screen.findByRole('region', { name: 'Usage summary' });
    expect(within(summary).getByText('$0.75')).toBeDefined();
    expect(within(summary).getByText(/^reported$/i)).toBeDefined();
    expect(within(summary).getByText('36,500')).toBeDefined(); // 1,200 + 34,000 + 500 + 800
    expect(within(summary).getByText(/^tokens$/i)).toBeDefined();
    expect(within(summary).getByText('3')).toBeDefined();
  });

  it('shows the token mix: each kind with its count and share, largest first', async () => {
    vi.mocked(api.getItem).mockResolvedValue(card as never);
    wrap(<UsageView itemId="i1" />);

    const mix = await screen.findByRole('region', { name: 'Token mix' });
    const items = within(mix).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      expect.stringMatching(/Cache read.*34,000.*93%/),
      expect.stringMatching(/Input.*1,200.*3%/),
      expect.stringMatching(/Output.*800.*2%/),
      expect.stringMatching(/Cache write.*500.*1%/),
    ]);
  });

  it('lists the steps that used tokens, and folds the ones that did not into one line', async () => {
    vi.mocked(api.getItem).mockResolvedValue(card as never);
    wrap(<UsageView itemId="i1" />);

    const steps = await screen.findByRole('region', { name: 'Usage by step' });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringMatching(/IN_PROGRESS.*36,500.*3 turns/)]);
    expect(within(steps).getByText(/1 step with no usage: TODO/)).toBeDefined();
  });

  it('lists each model with its harness, tokens and turns', async () => {
    vi.mocked(api.getItem).mockResolvedValue(card as never);
    wrap(<UsageView itemId="i1" />);

    const models = await screen.findByRole('list', { name: 'Models' });
    expect(within(models).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringMatching(/qwen3\.8.*pi.*36,500.*3 turns/)]);
  });

  it('counts the current step live, from the turns ingested since the card entered it', async () => {
    vi.mocked(api.getItem).mockResolvedValue(card as never);
    vi.mocked(api.getTokenEvents).mockResolvedValue([
      { id: 'e', ts: '2026-11-19T10:30:00.000Z', client: 'pi', sessionId: 's', model: 'qwen3.8', input: 5, cachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0, total: 6, costUsd: 0.25 },
    ] as never);
    wrap(<UsageView itemId="i1" />);

    const steps = await screen.findByRole('region', { name: 'Usage by step' });
    await waitFor(() => expect(within(steps).getByText(/^now$/i)).toBeDefined());
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringMatching(/IN_PROGRESS/),
      expect.stringMatching(/REVIEW.*now.*6.*1 turn/),
    ]);
    // Where the recorded IN_PROGRESS row ended, so no turn is counted in both.
    expect(api.getTokenEvents).toHaveBeenCalledWith({ itemId: 'i1', since: '2026-11-19T10:00:00.050Z' });
    expect(within(section('Usage summary')).getByText('$1.00')).toBeDefined();
  });

  it('on a parent, shows where the tokens went by sub-card', async () => {
    const closed = { byModel: [], total: totals({ turns: 6, input: 1077, cacheRead: 22300, cacheWrite: 200, output: 218 }), byStep: [], cards: 3, atStatus: 'DONE' };
    vi.mocked(api.getItem).mockResolvedValue({ id: 'story', status: 'DONE', createdAt: 'x', usageByStep: [row('TODO', 'REVIEW', {}), row('REVIEW', 'DONE', {})], cardUsage: closed } as never);
    vi.mocked(api.listItems).mockResolvedValue([
      { id: 'a', title: 'Task by Claude', status: 'DONE', cardUsage: { byModel: [], total: totals({ turns: 3, input: 117, cacheRead: 2200, cacheWrite: 200, output: 58 }), byStep: [], cards: 1, atStatus: 'DONE' } },
      { id: 'b', title: 'Task by pi', status: 'DONE', cardUsage: { byModel: [], total: totals({ turns: 3, input: 960, cacheRead: 20100, output: 160, costUsd: 0.025 }), byStep: [], cards: 1, atStatus: 'DONE' } },
    ] as never);
    wrap(<UsageView itemId="story" />);

    const subs = await screen.findByRole('region', { name: 'Usage by sub-card' });
    await waitFor(() => expect(within(subs).getAllByRole('listitem')).toHaveLength(2));
    expect(within(subs).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringMatching(/Task by pi.*21,220.*3 turns/), // the larger first
      expect.stringMatching(/Task by Claude.*2,575.*3 turns/),
    ]);
    // Archived sub-cards included: the parent's total still counts them.
    expect(api.listItems).toHaveBeenCalledWith({ parentId: 'story', includeArchived: true });
    // The parent's own steps had no sessions: folded, not shown as rows of zeros.
    expect(within(section('Usage by step')).queryAllByRole('listitem')).toEqual([]);
    expect(within(section('Usage summary')).getByText(/2 sub-cards/)).toBeDefined();
  });

  it('a reopened sub-card shows its recorded steps, not the stale total of its earlier close', async () => {
    const closed = { byModel: [], total: totals({ turns: 3, input: 42 }), byStep: [], cards: 2, atStatus: 'DONE' };
    vi.mocked(api.getItem).mockResolvedValue({ id: 'story', status: 'DONE', createdAt: 'x', usageByStep: [], cardUsage: closed } as never);
    vi.mocked(api.listItems).mockResolvedValue([
      { id: 'a', title: 'Reopened task', status: 'WORK',
        usageByStep: [row('WORK', 'DONE', { turns: 2, input: 40 }), row('DONE', 'WORK', { turns: 1, input: 2 })],
        cardUsage: { byModel: [], total: totals({ turns: 99, input: 99999 }), byStep: [], cards: 1, atStatus: 'DONE' } },
    ] as never);
    wrap(<UsageView itemId="story" />);
    const subs = await screen.findByRole('region', { name: 'Usage by sub-card' });
    expect(within(subs).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringMatching(/Reopened task.*42.*3 turns/)]);
  });

  it('says plainly when nothing was measured, and which harnesses are', async () => {
    vi.mocked(api.getItem).mockResolvedValue({ ...card, usageByStep: [] } as never);
    wrap(<UsageView itemId="i1" />);
    expect(await screen.findByText(/no usage recorded/i)).toBeDefined();
    expect(screen.getByText(/Claude Code, Codex and pi/)).toBeDefined();
  });

  it('says when the totals may be missing turns, and marks the step', async () => {
    vi.mocked(api.getItem).mockResolvedValue({ ...card, usageByStep: [card.usageByStep[0], { ...card.usageByStep[1], complete: false }] } as never);
    wrap(<UsageView itemId="i1" />);
    expect(await screen.findByRole('status')).toBeDefined();
    expect(screen.getByText(/incomplete: some session logs could not be read in time/i)).toBeDefined();
    expect(within(section('Usage by step')).getAllByRole('listitem')[0].textContent).toMatch(/IN_PROGRESS.*incomplete/);
  });

  it('with nothing recorded, still says when that may be because logs could not be read', async () => {
    vi.mocked(api.getItem).mockResolvedValue({ ...card, usageByStep: [row('IN_PROGRESS', 'REVIEW', {}, [], { complete: false })] } as never);
    wrap(<UsageView itemId="i1" />);
    expect(await screen.findByText(/no usage recorded/i)).toBeDefined();
    expect(screen.getByText(/incomplete: some session logs could not be read in time/i)).toBeDefined();
  });

  it('marks an estimate as an estimate', async () => {
    const t = { turns: 1, unpricedTurns: 1, input: 1_000_000 };
    const unpriced = { ...card, usageByStep: [row('IN_PROGRESS', 'REVIEW', t, [{ client: 'claude-code', model: 'claude-opus-5-5', ...totals(t) }])] };
    vi.mocked(api.getItem).mockResolvedValue(unpriced as never);
    wrap(<UsageView itemId="i1" prices={{ prices: [{ id: 'claude-opus-5-5', input: 10, output: 50 }] }} />);
    const summary = await screen.findByRole('region', { name: 'Usage summary' });
    expect(within(summary).getByText('≈ $10.00')).toBeDefined();
    expect(within(summary).getByText(/^estimated$/i)).toBeDefined();
    expect(within(summary).getByText(/Estimated for claude-opus-5-5 from public per-token prices — its logs record tokens, not cost\./)).toBeDefined();
  });

  it('names a model it could not price instead of counting it as free', async () => {
    const t = { turns: 1, unpricedTurns: 1, input: 50 };
    vi.mocked(api.getItem).mockResolvedValue({ ...card, usageByStep: [row('IN_PROGRESS', 'REVIEW', t, [{ client: 'codex', model: 'mystery-1', ...totals(t) }])] } as never);
    wrap(<UsageView itemId="i1" />);
    const summary = await screen.findByRole('region', { name: 'Usage summary' });
    expect(within(summary).getByText(/not priced: mystery-1/i)).toBeDefined();
  });
});

describe('cost priced when the turns were used (GH-397)', () => {
  const opusRow = (t: Record<string, number>) => ({ client: 'claude-code', model: 'claude-opus-5-5', ...totals(t) });

  it('adds the estimate stored with the turns to the reported cost, marked estimated, with no price table at all', async () => {
    const t = { turns: 2, input: 1_000_000, estimatedCostUsd: 2.5 };
    const p = { turns: 1, input: 10, costUsd: 0.5 };
    vi.mocked(api.getItem).mockResolvedValue({ ...card, usageByStep: [row('IN_PROGRESS', 'REVIEW', { turns: 3, input: 1_000_010, costUsd: 0.5, estimatedCostUsd: 2.5 }, [opusRow(t), piModel(p)])] } as never);
    wrap(<UsageView itemId="i1" />);
    const summary = await screen.findByRole('region', { name: 'Usage summary' });
    expect(within(summary).getByText('≈ $3.00')).toBeDefined();
    expect(within(summary).getByText(/^estimated$/i)).toBeDefined();
    expect(within(summary).getByText(/priced when the turns were used/i)).toBeDefined();
    expect(within(summary).queryByText(/today's prices/i)).toBeNull();
    expect(within(summary).queryByText(/not priced/i)).toBeNull();
  });

  it('a closed card shows its close total with the stored estimate', async () => {
    const t = { turns: 2, input: 100, estimatedCostUsd: 1.25 };
    vi.mocked(api.getItem).mockResolvedValue({ ...card, status: 'DONE', cardUsage: { atStatus: 'DONE', cards: 1, complete: true, byStep: [], total: totals(t), byModel: [opusRow(t)] } } as never);
    wrap(<UsageView itemId="i1" />);
    expect(within(await screen.findByRole('region', { name: 'Usage summary' })).getByText('≈ $1.25')).toBeDefined();
  });

  it('counts the stored estimate of the live turns of the current step', async () => {
    vi.mocked(api.getItem).mockResolvedValue(card as never);
    vi.mocked(api.getTokenEvents).mockResolvedValue([
      { id: 'e', ts: '2026-11-19T10:30:00.000Z', client: 'claude-code', sessionId: 's', model: 'claude-opus-5-5', input: 5, cachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0, total: 6, estimatedCostUsd: 0.25 },
    ] as never);
    wrap(<UsageView itemId="i1" />);
    const summary = await screen.findByRole('region', { name: 'Usage summary' });
    // $0.75 reported in IN_PROGRESS + $0.25 estimated when the live turn was used.
    await waitFor(() => expect(within(summary).getByText('≈ $1.00')).toBeDefined());
  });

  it("prices older turns with neither cost from the local server's price table, said to be at today's prices", async () => {
    vi.mocked(api.getPriceTable).mockResolvedValue({ prices: [{ id: 'claude-opus-5-5', input: 10, output: 50 }], fetchedAt: new Date().toISOString() } as never);
    const t = { turns: 1, unpricedTurns: 1, input: 1_000_000 };
    vi.mocked(api.getItem).mockResolvedValue({ ...card, usageByStep: [row('IN_PROGRESS', 'REVIEW', t, [opusRow(t)])] } as never);
    wrap(<UsageView itemId="i1" />);
    const summary = await screen.findByRole('region', { name: 'Usage summary' });
    await waitFor(() => expect(within(summary).getByText('≈ $10.00')).toBeDefined());
    expect(within(summary).getByText(/\$10\.00 of it at today's prices/i)).toBeDefined();
  });

  it("a price table the server could not refresh for days is named by its date, not as today's (review finding)", async () => {
    vi.mocked(api.getPriceTable).mockResolvedValue({ prices: [{ id: 'claude-opus-5-5', input: 10, output: 50 }], fetchedAt: '2026-01-05T08:00:00.000Z' } as never);
    const t = { turns: 1, unpricedTurns: 1, input: 1_000_000 };
    vi.mocked(api.getItem).mockResolvedValue({ ...card, usageByStep: [row('IN_PROGRESS', 'REVIEW', t, [opusRow(t)])] } as never);
    wrap(<UsageView itemId="i1" />);
    const summary = await screen.findByRole('region', { name: 'Usage summary' });
    await waitFor(() => expect(within(summary).getByText(/\$10\.00 of it at prices of 2026-01-05/)).toBeDefined());
    expect(within(summary).queryByText(/today's prices/i)).toBeNull();
  });

  it('the worktree panel prices the same usage the same way as the card modal', async () => {
    vi.mocked(api.getGitStatus).mockResolvedValue({ changed: 0, staged: 0, files: [] } as never);
    const t = { turns: 2, input: 1_000_000, estimatedCostUsd: 2.5 };
    vi.mocked(api.getItem).mockResolvedValue({ ...card, usageByStep: [row('IN_PROGRESS', 'REVIEW', t, [opusRow(t)])] } as never);
    wrap(<WorktreePanel itemId="i1" />);
    fireEvent.click(await screen.findByRole('tab', { name: /^Usage/ }));
    expect(within(await screen.findByRole('region', { name: 'Usage summary' })).getByText('≈ $2.50')).toBeDefined();
  });
});

describe('the USAGE tab beside Changed and Staged (#385)', () => {
  it('is a third tab of the worktree panel, labelled with the card total', async () => {
    vi.mocked(api.getGitStatus).mockResolvedValue({ changed: 0, staged: 0, files: [] } as never);
    vi.mocked(api.getItem).mockResolvedValue(card as never);
    wrap(<WorktreePanel itemId="i1" />);

    // 1,200 + 34,000 + 500 + 800 tokens
    const tab = await screen.findByRole('tab', { name: 'Usage (37k)' });
    fireEvent.click(tab);
    expect(within(await screen.findByRole('region', { name: 'Usage summary' })).getByText('$0.75')).toBeDefined();
  });
});
