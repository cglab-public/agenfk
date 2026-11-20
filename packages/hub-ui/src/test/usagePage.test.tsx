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

  describe('tokens split by type (GH-391 follow-up)', () => {
    // Each type a different size, so a figure in the wrong column shows.
    const claude = { client: 'claude-code', model: 'claude-opus-5-5', ...zero, turns: 3, input: 1_000, cacheRead: 900_000, cacheWrite: 50_000, output: 20_000, reasoning: 7_777, unpricedTurns: 3 };
    const pi = { client: 'pi', model: 'qwen3.8:27b', ...zero, turns: 1, input: 30_000, cacheRead: 100_000, output: 5_000, costUsd: 0.5 };
    const SPLIT = {
      ...OVERVIEW,
      total: sum(claude, pi),
      byInstallation: [
        { installation_id: 'inst-a', label: 'Alice <alice@acme.com>', cards: 2, total: claude, byModel: [claude] },
        { installation_id: 'inst-b', label: 'Bob <bob@acme.com>', cards: 1, total: pi, byModel: [pi] },
      ],
      byUser: [
        { user_key: 'alice@acme.com', cards: 2, total: claude, byModel: [claude] },
        { user_key: 'bob@acme.com', cards: 1, total: pi, byModel: [pi] },
      ],
      byModel: [claude, pi],
      byPr: [
        { repo: 'acme/api', pr_number: 42, item_id: 's1', item_type: 'STORY', item_title: 'Usage overview', opened_at: '2026-11-19T10:00:00.000Z', closed_at: '2026-11-19T09:00:00.000Z',
          usage: { byModel: [pi], total: pi, byStep: [], cards: 4 } },
        { repo: 'acme/web', pr_number: 7, item_id: 's2', item_type: 'TASK', item_title: 'Still open', opened_at: '2026-11-18T10:00:00.000Z', closed_at: null, usage: null },
      ],
      byDay: [
        { day: '2026-11-18', cards: 1, total: pi, byModel: [pi] },
        { day: '2026-11-19', cards: 2, total: claude, byModel: [claude] },
      ],
    };
    beforeEach(() => { overview = SPLIT; });
    const TYPES = ['Input', 'Cache read', 'Cache write', 'Output'];
    const cellsOf = (row: HTMLElement) => within(row).getAllByRole('cell').map(c => c.textContent);
    const headerIndex = (table: HTMLElement, name: string) =>
      within(table).getAllByRole('columnheader').findIndex(h => h.textContent?.trim() === name);
    const rowFor = (table: HTMLElement, text: string) =>
      within(table).getAllByRole('row').find(r => r.textContent?.includes(text))!;
    const valueIn = (table: HTMLElement, rowText: string, column: string) =>
      cellsOf(rowFor(table, rowText))[headerIndex(table, column)];

    it('the headline keeps the total and lists the four types under it', async () => {
      renderAt('/usage');
      const totals = await screen.findByRole('region', { name: /totals/i });
      // 31k input + 1M cache read + 50k cache write + 25k output.
      expect(await within(totals).findByText('1.1M')).toBeInTheDocument();
      expect(within(totals).getByText(/input 31k · cache read 1M · cache write 50k · output 25k/i)).toBeInTheDocument();
    });

    it.each([
      [/by installation/i, 'Alice', 'Bob'],
      [/by person/i, 'alice@acme.com', 'Bob Builder'],
      [/by harness/i, 'claude-opus-5-5', 'qwen3.8:27b'],
    ])('the %s table keeps the Tokens total and puts each type in its own column', async (name, a, b) => {
      renderAt('/usage');
      await screen.findByText('1.1M');
      const t = within(section(name)).getByRole('table');
      for (const col of ['Tokens', ...TYPES]) expect(headerIndex(t, col)).toBeGreaterThan(-1);
      expect(valueIn(t, a, 'Tokens')).toBe('971k');
      expect(valueIn(t, a, 'Input')).toBe('1k');
      expect(valueIn(t, a, 'Cache read')).toBe('900k');
      expect(valueIn(t, a, 'Cache write')).toBe('50k');
      expect(valueIn(t, a, 'Output')).toBe('20k');
      expect(valueIn(t, b, 'Input')).toBe('30k');
      expect(valueIn(t, b, 'Cache read')).toBe('100k');
      expect(valueIn(t, b, 'Cache write')).toBe('0');
      expect(valueIn(t, b, 'Output')).toBe('5k');
    });

    it('sorts by a type column, by that type and not by the total', async () => {
      renderAt('/usage');
      await screen.findByText('1.1M');
      const t = within(section(/by person/i)).getByRole('table');
      const firstRow = () => within(t).getAllByRole('row')[1].textContent;
      fireEvent.click(within(within(t).getAllByRole('columnheader')[headerIndex(t, 'Input')]).getByRole('button'));
      // Bob has the larger input (30k against 1k), though Alice has the larger total.
      expect(firstRow()).toContain('Bob Builder');
      fireEvent.click(within(within(t).getAllByRole('columnheader')[headerIndex(t, 'Cache read')]).getByRole('button'));
      expect(firstRow()).toContain('alice@acme.com');
    });

    it('a PR row splits its card usage by type, and an open card shows no figures', async () => {
      renderAt('/usage');
      await screen.findByText('1.1M');
      const t = within(section(/by pr/i)).getByRole('table');
      expect(valueIn(t, 'acme/api#42', 'Input')).toBe('30k');
      expect(valueIn(t, 'acme/api#42', 'Cache read')).toBe('100k');
      expect(valueIn(t, 'acme/api#42', 'Output')).toBe('5k');
      expect(valueIn(t, 'acme/web#7', 'Tokens')).toBe('not closed yet');
      expect(valueIn(t, 'acme/web#7', 'Cache read')).toBe('');
    });

    it('does not show reasoning tokens', async () => {
      renderAt('/usage');
      await screen.findByText('1.1M');
      expect(screen.queryByText(/reasoning/i)).not.toBeInTheDocument();
      expect(screen.queryByText('8k')).not.toBeInTheDocument();
    });

    it('stacks each day of the tokens chart by type, with a legend and every type in the bar\'s name', async () => {
      renderAt('/usage');
      await screen.findByText('1.1M');
      const chart = section(/tokens per day/i);
      const legend = within(chart).getByRole('list', { name: /legend/i });
      expect(within(legend).getAllByRole('listitem').map(li => li.textContent)).toEqual(TYPES);
      const bar = within(chart).getByRole('option', { name: /2026-11-19: 971k tokens/ });
      expect(bar).toHaveAccessibleName(/input 1k.*cache read 900k.*cache write 50k.*output 20k/i);
      const heights = Object.fromEntries([...bar.querySelectorAll<HTMLElement>('[data-series]')]
        .map(s => [s.dataset.series!, parseFloat(s.style.height)]));
      expect(Object.keys(heights)).toEqual(TYPES);
      // Each part is its share of the day: cache read is 900 of 971 parts.
      // The parts fill the bar exactly, each its share of the day.
      expect(Object.values(heights).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
      expect(heights['Input']).toBeCloseTo(100 * 1 / 971, 6);
      expect(heights['Cache read']).toBeCloseTo(100 * 900 / 971, 6);
      expect(heights['Cache write']).toBeCloseTo(100 * 50 / 971, 6);
      expect(heights['Output']).toBeCloseTo(100 * 20 / 971, 6);
      // The tooltip lists the types too.
      fireEvent.mouseEnter(bar);
      const tip = within(chart).getByTestId('bar-tooltip');
      for (const type of TYPES) expect(within(tip).getByText(new RegExp(type, 'i'))).toBeInTheDocument();
    });

    it('hovering a segment names that segment in the tooltip: its type, tokens and share of the day', async () => {
      renderAt('/usage');
      await screen.findByText('1.1M');
      const chart = section(/tokens per day/i);
      const bar = within(chart).getByRole('option', { name: /2026-11-19: 971k tokens/ });
      const segment = (type: string) => bar.querySelector<HTMLElement>(`[data-series="${type}"]`)!;
      const tip = () => within(chart).getByTestId('bar-tooltip');
      fireEvent.mouseEnter(segment('Output'));
      // 20k of 971k is 2%.
      expect(within(tip()).getByText(/output/i).closest('[data-active="true"]')).toHaveTextContent(/output.*20k.*2%/i);
      expect(tip().querySelectorAll('[data-active="true"]')).toHaveLength(1);
      fireEvent.mouseEnter(segment('Cache read'));
      expect(within(tip()).getByText(/cache read/i).closest('[data-active="true"]')).toHaveTextContent(/cache read.*900k.*93%/i);
      expect(tip().querySelectorAll('[data-active="true"]')).toHaveLength(1);
      // On the bar but off every segment, no line is singled out.
      fireEvent.mouseEnter(bar);
      expect(tip().querySelectorAll('[data-active="true"]')).toHaveLength(0);
      expect(within(tip()).getByText(/971k tokens/)).toBeInTheDocument();
    });

    it('the keyboard leaves no part singled out: moving, Escape and leaving the chart all clear it', async () => {
      renderAt('/usage');
      await screen.findByText('1.1M');
      const chart = section(/tokens per day/i);
      const list = within(chart).getByRole('listbox');
      const bar = within(chart).getByRole('option', { name: /2026-11-19: 971k tokens/ });
      const active = () => within(chart).queryByTestId('bar-tooltip')?.querySelectorAll('[data-active="true"]').length ?? 0;
      const hoverOutput = () => fireEvent.mouseEnter(bar.querySelector('[data-series="Output"]')!);
      hoverOutput();
      expect(active()).toBe(1);
      list.focus();
      fireEvent.keyDown(list, { key: 'ArrowLeft' });
      expect(within(chart).getByTestId('bar-tooltip')).toBeInTheDocument();
      expect(active()).toBe(0);
      fireEvent.keyDown(list, { key: 'ArrowRight' });
      expect(active()).toBe(0);
      // Escape and blur close the tooltip; reopening it on the same bar with a
      // click (which picks only the day) shows no part singled out.
      hoverOutput();
      fireEvent.keyDown(list, { key: 'Escape' });
      expect(within(chart).queryByTestId('bar-tooltip')).not.toBeInTheDocument();
      fireEvent.click(bar);
      expect(active()).toBe(0);
      hoverOutput();
      fireEvent.blur(list);
      expect(within(chart).queryByTestId('bar-tooltip')).not.toBeInTheDocument();
      fireEvent.click(bar);
      expect(active()).toBe(0);
    });

    it.each(['Tokens', 'Input', 'Cache read', 'Cost'])('a PR with no usage yet sorts last by %s, in both directions', async (column) => {
      renderAt('/usage');
      await screen.findByText('1.1M');
      const t = within(section(/by pr/i)).getByRole('table');
      const click = () => fireEvent.click(within(within(t).getAllByRole('columnheader')[headerIndex(t, column)]).getByRole('button'));
      const lastRow = () => within(t).getAllByRole('row').at(-1)!.textContent;
      click();
      expect(lastRow()).toContain('acme/web#7');
      click();
      expect(lastRow()).toContain('acme/web#7');
    });

    it('the cost chart stays one series, with no legend', async () => {
      renderAt('/usage');
      await screen.findByText('1.1M');
      expect(within(section(/cost per day/i)).queryByRole('list', { name: /legend/i })).not.toBeInTheDocument();
    });
  });

  describe('usage on no card (GH-394)', () => {
    /** 300k Claude input tokens on no card: $3.00 at the test table's rate. */
    const free = { client: 'claude-code', model: 'claude-opus-5-5', ...zero, turns: 1, input: 300_000, unpricedTurns: 1 };
    const NOCARD = {
      ...OVERVIEW,
      total: sum(opus, qwen, free),
      noCard: {
        total: free,
        byModel: [free],
        byDay: [{ day: '2026-11-19', total: free, byModel: [free] }],
        byInstallation: [{ installation_id: 'inst-c', label: null, total: free, byModel: [free] }],
        byUser: [{ user_key: 'carol@acme.com', total: free, byModel: [free] }],
      },
    };
    beforeEach(() => { overview = NOCARD; });
    const rowsOf = (name: RegExp) => within(within(section(name)).getByRole('table')).getAllByRole('row').slice(1);

    it('the headline totals include it, and say how much of them is not on a card', async () => {
      renderAt('/usage');
      const totals = await screen.findByRole('region', { name: /totals/i });
      // 1.2M on cards + 300k on none; $10.50 + $3.00.
      expect(within(totals).getByText('1.5M')).toBeInTheDocument();
      expect(within(totals).getByText('$13.50')).toBeInTheDocument();
      expect(within(totals).getByText(/of which 300k not on a card/i)).toBeInTheDocument();
      expect(within(totals).getByText(/of which \$3\.00 not on a card/i)).toBeInTheDocument();
    });

    it('counts a person whose only usage is on no card', async () => {
      renderAt('/usage');
      const totals = await screen.findByRole('region', { name: /totals/i });
      const tile = within(totals).getByText(/^People$/).closest('[data-stat-tile]')!;
      // The value (3 people: alice, bob and carol), then its hint.
      expect(tile.textContent).toBe('People33 installations');
    });

    it.each([/by installation/i, /by person/i, /by harness/i])('the %s table has a "Not on a card" row, after the others whatever the sort', async (name) => {
      renderAt('/usage');
      await screen.findByText('$13.50');
      const last = () => rowsOf(name).at(-1)!;
      expect(last()).toHaveTextContent(/not on a card/i);
      expect(last()).toHaveTextContent('300k');
      expect(last()).toHaveTextContent('$3.00');
      const t = within(section(name)).getByRole('table');
      const tokensHeader = within(t).getAllByRole('columnheader').find(h => h.textContent?.trim() === 'Tokens')!;
      fireEvent.click(within(tokensHeader).getByRole('button'));
      expect(last()).toHaveTextContent(/not on a card/i);
      fireEvent.click(within(tokensHeader).getByRole('button'));
      expect(last()).toHaveTextContent(/not on a card/i);
    });

    it('no "Not on a card" row, and no such part in the charts, when there is none', async () => {
      overview = OVERVIEW;
      renderAt('/usage');
      await screen.findByText('$10.50');
      expect(screen.queryByText(/not on a card/i)).not.toBeInTheDocument();
    });

    it('the tokens chart stacks it as its own hatched part on top of the four types, named in the legend and the bar', async () => {
      renderAt('/usage?range=7d');
      await screen.findByText('$13.50');
      const chart = section(/tokens per day/i);
      const legend = within(chart).getByRole('list', { name: /legend/i });
      expect(within(legend).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Input', 'Cache read', 'Cache write', 'Output', 'Not on a card']);
      // 1M input on cards + 300k on none.
      const bar = within(chart).getByRole('option', { name: /2026-11-19: 1\.3M tokens/ });
      expect(bar).toHaveAccessibleName(/input 1M.*not on a card 300k/i);
      const parts = [...bar.querySelectorAll<HTMLElement>('[data-series]')];
      expect(parts.map(p => p.dataset.series)).toEqual(['Input', 'Cache read', 'Cache write', 'Output', 'Not on a card']);
      const hatched = parts.at(-1)!;
      expect(hatched.dataset.pattern).toBe('hatched');
      // Striped in its colour, outlined so its edge shows: not a solid fill.
      expect(hatched.style.boxShadow).toContain('var(--text-tertiary)');
      expect(parts[0].style.boxShadow).toBe('');
      expect(parseFloat(hatched.style.height)).toBeCloseTo(100 * 300 / 1300, 6);
      expect(parseFloat(parts[0].style.height)).toBeCloseTo(100 * 1000 / 1300, 6);
      // The legend swatch is hatched as well, so the key matches the bar.
      expect(within(legend).getByText('Not on a card').parentElement!.querySelector('[data-pattern="hatched"]')).not.toBeNull();
    });

    it("the tokens tooltip splits the day's no-card part by type too", async () => {
      renderAt('/usage?range=7d');
      await screen.findByText('$13.50');
      const chart = section(/tokens per day/i);
      fireEvent.mouseEnter(within(chart).getByRole('option', { name: /2026-11-19: 1\.3M tokens/ }));
      expect(within(chart).getByTestId('bar-tooltip')).toHaveTextContent(/not on a card: input 300k · cache read 0 · cache write 0 · output 0/i);
    });

    it('the cost chart splits each day into on a card and not on a card', async () => {
      renderAt('/usage?range=7d');
      await screen.findByText('$13.50');
      const chart = section(/cost per day/i);
      const legend = within(chart).getByRole('list', { name: /legend/i });
      expect(within(legend).getAllByRole('listitem').map(li => li.textContent)).toEqual(['On a card', 'Not on a card']);
      const bar = within(chart).getByRole('option', { name: /2026-11-19: \$13\.00/ });
      expect(bar).toHaveAccessibleName(/on a card \$10\.00.*not on a card \$3\.00/i);
    });

    it('a day with usage on no card only is still drawn', async () => {
      overview = { ...NOCARD, byDay: [] };
      renderAt('/usage?range=7d');
      await screen.findByText('$13.50');
      expect(within(section(/tokens per day/i)).getByRole('option', { name: /2026-11-19: 300k tokens/ })).toBeInTheDocument();
    });

    it('says how usage on no card reaches the hub', async () => {
      renderAt('/usage');
      await screen.findByText('$13.50');
      expect(screen.getByText(/usage on no card arrives as each installation's daily total/i)).toBeInTheDocument();
    });
  });

  it('is reachable from the dashboard nav', async () => {
    renderAt('/');
    expect(await screen.findByRole('link', { name: /^usage$/i })).toHaveAttribute('href', '/usage');
  });
});
