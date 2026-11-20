/**
 * @vitest-environment jsdom
 *
 * GH-389 follow-up: the hub's /usage page, over GET /v1/usage/overview. Tokens
 * and cost across the org, by installation, by person, by harness/model and by
 * PR. Cost is what pi reported plus, for Claude/Codex, an estimate from the
 * shared price table, always labelled as an estimate. What the hub cannot see
 * (a card's current step, steps whose logs were late) is said, not hidden.
 */
import { render, screen, cleanup, within, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UsagePage } from '../pages/Usage';
import { Layout } from '../components/Layout';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';
import { fromIsoForRange } from '../components/timelineAxis';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const zero = { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, unpricedTurns: 0 };
/** Claude: 1M input tokens, nothing priced -> $10 at the test table's rate. */
const opus = { client: 'claude-code', model: 'claude-opus-5-5', ...zero, turns: 2, input: 1_000_000, unpricedTurns: 2 };
/** pi: priced its own turns at $0.50. */
const qwen = { client: 'pi', model: 'qwen3.8:27b', ...zero, turns: 1, input: 200_000, costUsd: 0.5 };
const sum = (...ms: any[]) => ms.reduce((t, m) => {
  const out: any = { ...t };
  for (const k of Object.keys(zero)) out[k] = t[k] + m[k];
  return out;
}, { ...zero });

const OVERVIEW = {
  total: sum(opus, qwen),
  cards: 3,
  steps: 5,
  unmeasuredSteps: 0,
  incompleteSteps: 0,
  recoveredAtClose: { ...zero },
  byInstallation: [
    { installation_id: 'inst-a', label: 'Alice <alice@acme.com>', cards: 2, total: opus, byModel: [opus] },
    { installation_id: 'inst-b-unnamed', label: null, cards: 1, total: qwen, byModel: [qwen] },
  ],
  byUser: [
    { user_key: 'alice@acme.com', cards: 2, total: opus, byModel: [opus] },
    { user_key: 'bob@acme.com', cards: 1, total: qwen, byModel: [qwen] },
  ],
  byModel: [opus, qwen],
  byPr: [
    { repo: 'acme/api', pr_number: 42, item_id: 's1', item_type: 'STORY', item_title: 'Usage overview', opened_at: '2026-11-19T10:00:00.000Z', closed_at: '2026-11-19T09:00:00.000Z',
      usage: { byModel: [qwen], total: qwen, byStep: [], cards: 4 } },
    { repo: 'acme/web', pr_number: 7, item_id: 's2', item_type: 'TASK', item_title: 'Still open', opened_at: '2026-11-18T10:00:00.000Z', closed_at: null, usage: null },
  ],
  byDay: [
    { day: '2026-11-18', cards: 1, total: qwen, byModel: [qwen] },
    { day: '2026-11-19', cards: 2, total: opus, byModel: [opus] },
  ],
  truncated: false,
  prsTruncated: false,
};
const EMPTY = { ...OVERVIEW, total: { ...zero }, cards: 0, steps: 0, byInstallation: [], byUser: [], byModel: [], byPr: [], byDay: [] };
const PRICES = { prices: [{ id: 'claude-opus-5-5', input: 10, output: 50, input_cached: 1 }] };

let overview: any = OVERVIEW;
let pricesOk = true;
beforeEach(() => {
  overview = OVERVIEW;
  pricesOk = true;
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/usage/overview')) return { data: overview };
    if (url.startsWith('/v1/projects')) return { data: { projects: ['git@x:web.git', 'git@x:api.git'] } };
    if (url.startsWith('/v1/item-types')) return { data: { itemTypes: ['TASK'], counts: {} } };
    if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
    if (url.startsWith('/v1/people/names')) return { data: { names: { 'bob@acme.com': 'Bob Builder' } } };
    if (url.startsWith('/auth/me')) return { data: { userId: 'admin@x', email: 'admin@x' } };
    if (url.startsWith('/healthz')) return { data: { ok: true, version: 'test' } };
    return { data: {} };
  });
  vi.stubGlobal('fetch', vi.fn(async () => (pricesOk
    ? { ok: true, json: async () => PRICES }
    : { ok: false, status: 503, json: async () => ({}) })));
  try { window.localStorage.clear(); } catch { /* blocked */ }
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderAt = (entry: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/usage" element={<Layout><UsagePage /></Layout>} />
            <Route path="/" element={<Layout><div data-testid="home" /></Layout>} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
};
const overviewCalls = () => get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/v1/usage/overview'));
const section = (name: RegExp) => screen.getByRole('region', { name });

describe('UsagePage', () => {
  it('totals tokens and cost, the estimated part labelled as an estimate', async () => {
    renderAt('/usage');
    // $0.50 reported by pi + $10.00 estimated for Claude.
    expect(await screen.findByText('$10.50')).toBeInTheDocument();
    expect(screen.getByText(/\$10\.00 estimated/i)).toBeInTheDocument();
    expect(screen.getByText('1.2M')).toBeInTheDocument(); // 1.2M tokens
  });

  it('breaks usage down by installation, naming it, or showing its id when the hub knows no name', async () => {
    renderAt('/usage');
    await screen.findByText('$10.50');
    const t = section(/by installation/i);
    expect(within(t).getByText('Alice <alice@acme.com>')).toBeInTheDocument();
    expect(within(t).getByText('inst-b-unnamed')).toBeInTheDocument();
    expect(within(t).getByText('$10.00')).toBeInTheDocument();
    expect(within(t).getByText('$0.50')).toBeInTheDocument();
  });

  it('breaks usage down by person, with their name when known', async () => {
    renderAt('/usage');
    await screen.findByText('$10.50');
    const t = section(/by person/i);
    expect(within(t).getByText('alice@acme.com')).toBeInTheDocument();
    expect(within(t).getByText('Bob Builder')).toBeInTheDocument();
  });

  it('breaks usage down by harness and model, marking the estimated cost', async () => {
    renderAt('/usage');
    await screen.findByText('$10.50');
    const t = section(/by harness/i);
    expect(within(t).getByText('claude-opus-5-5')).toBeInTheDocument();
    expect(within(t).getByText('claude-code')).toBeInTheDocument();
    expect(within(t).getByText('qwen3.8:27b')).toBeInTheDocument();
    expect(within(t).getByText('pi')).toBeInTheDocument();
    expect(within(t).getAllByText(/est\./i)).toHaveLength(1);
  });

  it('lists each PR with its anchor card usage, and says when the card is not closed yet', async () => {
    renderAt('/usage');
    await screen.findByText('$10.50');
    const t = section(/by pr/i);
    expect(within(t).getByText('acme/api#42')).toBeInTheDocument();
    expect(within(t).getByText('Usage overview')).toBeInTheDocument();
    expect(within(t).getByText('$0.50')).toBeInTheDocument();
    expect(within(t).getByText('acme/web#7')).toBeInTheDocument();
    expect(within(t).getByText(/not closed yet/i)).toBeInTheDocument();
  });

  it('says what the hub cannot see rather than letting the totals look complete', async () => {
    overview = { ...OVERVIEW, unmeasuredSteps: 2, incompleteSteps: 1, truncated: true, prsTruncated: true };
    renderAt('/usage');
    await screen.findByText('$10.50');
    expect(screen.getByText(/current step is counted when it moves/i)).toBeInTheDocument();
    expect(screen.getByText(/2 step changes came from versions that did not report usage/i)).toBeInTheDocument();
    expect(screen.getByText(/1 step change.*logs could not be read in time/i)).toBeInTheDocument();
    expect(screen.getByText(/too many step changes.*newest/i)).toBeInTheDocument();
    expect(screen.getByText(/only the newest .*PRs/i)).toBeInTheDocument();
  });

  it('without the price table, shows only reported cost and names the models it could not price', async () => {
    pricesOk = false;
    renderAt('/usage');
    await screen.findByText('acme/api#42');
    // $0.50 shows in several tables too; the total is the Totals tile's.
    const totals = section(/totals/i);
    expect(within(totals).getByText('$0.50')).toBeInTheDocument();
    expect(within(totals).getByText(/not priced: claude-opus-5-5/i)).toBeInTheDocument();
    expect(screen.queryByText('$10.50')).not.toBeInTheDocument();
  });

  it('says plainly when nothing was recorded in the window', async () => {
    overview = EMPTY;
    renderAt('/usage');
    expect(await screen.findByText(/no usage was recorded in this window/i)).toBeInTheDocument();
  });

  it('sends the shared filters, and never an event-type filter', async () => {
    renderAt('/usage?projects=git%40x%3Aweb.git&itemTypes=TASK&childHubId=child-1');
    await screen.findByText('$10.50');
    const url = overviewCalls().at(-1)!;
    for (const part of ['projects=git%40x%3Aweb.git', 'itemTypes=TASK', 'childHubId=child-1', 'from=']) expect(url).toContain(part);
    expect(url).not.toContain('types=');
  });

  it('reads top to bottom: filters, totals, the timeline, then the detail tables', async () => {
    renderAt('/usage');
    await screen.findByText('$10.50');
    const order = [
      screen.getByRole('button', { name: /edit filters/i }),
      section(/totals/i),
      section(/cost per day/i),
      section(/tokens per day/i),
      section(/by installation/i),
      section(/by pr/i),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `item ${i}`).toBeTruthy();
    }
  });

  it('charts cost and tokens per day as two charts, each on its own scale, every day of the range shown', async () => {
    renderAt('/usage?range=7d');
    await screen.findByText('$10.50');
    const cost = section(/cost per day/i);
    const tokens = section(/tokens per day/i);
    // Each bar is named with its day and value; cost prices the day's models.
    expect(within(cost).getByRole('option', { name: /2026-11-19: \$10\.00/ })).toBeInTheDocument();
    expect(within(cost).getByRole('option', { name: /2026-11-18: \$0\.50/ })).toBeInTheDocument();
    expect(within(tokens).getByRole('option', { name: /2026-11-19: 1M tokens/ })).toBeInTheDocument();
    expect(within(tokens).getByRole('option', { name: /2026-11-18: 200k tokens/ })).toBeInTheDocument();
    // A day with nothing is a zero bar, not a gap that would hide it.
    expect(within(tokens).getAllByRole('option')).toHaveLength(within(cost).getAllByRole('option').length);
    expect(within(tokens).getAllByRole('option').length).toBeGreaterThanOrEqual(7);
    expect(within(tokens).getAllByRole('option', { name: /: 0 tokens/ }).length).toBeGreaterThan(0);
  });

  it("asks for the days in the viewer's time zone", async () => {
    renderAt('/usage');
    await screen.findByText('$10.50');
    expect(overviewCalls().at(-1)!).toMatch(/[?&]tz=/);
  });

  it('says there are no PRs in the window instead of showing an empty table', async () => {
    overview = { ...OVERVIEW, byPr: [] };
    renderAt('/usage');
    await screen.findByText('$10.50');
    const t = section(/by pr/i);
    expect(within(t).getByText(/no pr was opened or updated in this window/i)).toBeInTheDocument();
    expect(within(t).queryByRole('table')).not.toBeInTheDocument();
  });

  it('the filter summary does not claim an event-type filter the page does not have', async () => {
    renderAt('/usage');
    await screen.findByText('$10.50');
    expect(screen.queryByText(/event types/i)).not.toBeInTheDocument();
  });

  it('a malformed price table does not break the page: reported cost only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ prices: [null, { id: 3 }] }) })));
    renderAt('/usage');
    await screen.findByText('acme/api#42');
    expect(within(section(/totals/i)).getByText('$0.50')).toBeInTheDocument();
  });

  it('a day bar says when its cost is estimated, and names the models it could not price', async () => {
    const mystery = { client: 'codex', model: 'mystery-9', ...zero, turns: 1, input: 10, unpricedTurns: 1 };
    overview = { ...OVERVIEW, byDay: [
      { day: '2026-11-18', cards: 1, total: mystery, byModel: [mystery] },
      { day: '2026-11-19', cards: 2, total: opus, byModel: [opus] },
    ] };
    renderAt('/usage');
    await screen.findByText('$10.50');
    const cost = section(/cost per day/i);
    expect(within(cost).getByRole('option', { name: /2026-11-19: \$10\.00.*estimated/ })).toBeInTheDocument();
    expect(within(cost).getByRole('option', { name: /2026-11-18: \$0\.00.*not priced: mystery-9/ })).toBeInTheDocument();
  });

  it('keeps the warnings when nothing was measured, instead of a bare empty state', async () => {
    overview = { ...EMPTY, unmeasuredSteps: 3 };
    renderAt('/usage');
    expect(await screen.findByText(/3 step changes came from versions that did not report usage/i)).toBeInTheDocument();
  });

  it('walks the bars with the keyboard and shows the value of the bar it is on', async () => {
    renderAt('/usage');
    await screen.findByText('$10.50');
    const list = within(section(/tokens per day/i)).getByRole('listbox');
    list.focus();
    fireEvent.keyDown(list, { key: 'End' });
    const last = within(list).getAllByRole('option').at(-1)!;
    expect(list).toHaveAttribute('aria-activedescendant', last.id);
    expect(last).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    const prev = within(list).getAllByRole('option').at(-2)!;
    expect(list).toHaveAttribute('aria-activedescendant', prev.id);
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(list).not.toHaveAttribute('aria-activedescendant');
  });

  describe('against a fixed clock', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 19, 15, 0, 0)); });
    afterEach(() => { vi.useRealTimers(); });

    it('the day axis is exactly the days of the range in local time, none missing', async () => {
      renderAt('/usage?range=7d');
      await screen.findByText('$10.50');
      const days = within(section(/tokens per day/i)).getAllByRole('option').map(o => o.getAttribute('aria-label')!.slice(0, 10));
      const start = new Date(fromIsoForRange(new Date(), '7d'));
      const expected: string[] = [];
      for (const d = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12); d <= new Date(2026, 10, 19, 23); d.setDate(d.getDate() + 1)) {
        expected.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      }
      expect(expected.at(-1)).toBe('2026-11-19');
      expect(days).toEqual(expected);
    });

    it("'today' asks from today's local midnight, and moves to the new day at midnight", async () => {
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
      vi.setSystemTime(new Date(2026, 10, 19, 23, 59, 0));
      renderAt('/usage?range=today');
      await screen.findByText('$10.50');
      const fromOf = () => new Date(new URL(`http://x${overviewCalls().at(-1)}`).searchParams.get('from')!).getTime();
      expect(fromOf()).toBe(new Date(2026, 10, 19, 0, 0, 0).getTime());
      await act(async () => { vi.advanceTimersByTime(2 * 60 * 1000); });
      await waitFor(() => expect(fromOf()).toBe(new Date(2026, 10, 20, 0, 0, 0).getTime()));
    });

    it('a sub-cent day still draws a bar, on a one-cent axis', async () => {
      const tiny = { client: 'pi', model: 'qwen3.8:27b', ...zero, turns: 1, input: 10, costUsd: 0.003 };
      overview = { ...OVERVIEW, byDay: [{ day: '2026-11-19', cards: 1, total: tiny, byModel: [tiny] }] };
      renderAt('/usage?range=today');
      await screen.findByText('$10.50');
      const bar = within(section(/cost per day/i)).getByRole('option', { name: /2026-11-19: \$0\.0030/ });
      const fill = bar.firstElementChild as HTMLElement;
      expect(fill.style.height).toContain('30%');
      expect(within(section(/cost per day/i)).getByText('$0.01')).toBeInTheDocument();
    });
  });

  it('is reachable from the dashboard nav', async () => {
    renderAt('/');
    expect(await screen.findByRole('link', { name: /^usage$/i })).toHaveAttribute('href', '/usage');
  });
});
