/**
 * @vitest-environment jsdom
 *
 * Story 6b898739: every non-empty heatmap cell was its own tab stop (hundreds
 * at 90 days × 20 developers) and its tooltip opened on mouse hover only. The
 * heatmap is now an ARIA grid with ONE tab stop: the arrow keys move between
 * cells, Home/End along a row, Ctrl+Home/End to the corners, Enter or Space
 * opens a day's PRs, and focusing a cell shows the same tooltip as hovering.
 */
import React from 'react';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrOverviewPage } from '../pages/PrOverview';
import { cellTooltip } from '../prPerDay';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const sizes = (o: Partial<Record<'xs' | 's' | 'm' | 'l' | 'xl', number>>) => ({ xs: 0, s: 0, m: 0, l: 0, xl: 0, ...o });
const noDevs = { xs: [], s: [], m: [], l: [], xl: [] };
const pr = (user_key: string, day: string, n: number) => ({
  repo: 'acme/api', prNumber: n, url: `https://github.com/acme/api/pull/${n}`, user_key,
  model: 'claude-opus-5', harness: 'claude-code', openedAt: `${day}T12:00:00Z`, day, points: 2, bucket: 'xs',
});
// Midday to midday, so 08-12 and 08-13 fall inside the axis in any test zone.
const overview = {
  period: { from: '2026-08-10T12:00:00.000Z', to: '2026-08-14T12:00:00.000Z' },
  buckets: ['xs', 's', 'm', 'l', 'xl'],
  totals: { prs: 3, sizePoints: 6, developers: 2, medianBucket: 'xs' },
  resized: { count: 0, grew: 0, shrank: 0 },
  byDay: [
    { day: '2026-08-12', sizes: sizes({ xs: 2 }), total: 2, devBySize: { ...noDevs, xs: [{ user_key: 'alice@acme.com', count: 2 }] } },
    { day: '2026-08-13', sizes: sizes({ xs: 1 }), total: 1, devBySize: { ...noDevs, xs: [{ user_key: 'bob@acme.com', count: 1 }] } },
  ],
  byDeveloper: [
    { user_key: 'alice@acme.com', prs: 2, sizePoints: 4, sizes: sizes({ xs: 2 }), daily: { '2026-08-12': 2 } },
    { user_key: 'bob@acme.com', prs: 1, sizePoints: 2, sizes: sizes({ xs: 1 }), daily: { '2026-08-13': 1 } },
  ],
  byModel: [{ model: 'claude-opus-5', harnesses: ['claude-code'], prs: 3, sizePoints: 6, sizes: sizes({ xs: 3 }) }],
  prs: [pr('alice@acme.com', '2026-08-12', 1), pr('alice@acme.com', '2026-08-12', 2), pr('bob@acme.com', '2026-08-13', 3)],
  previous: null,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'));
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/projects')) return { data: { projects: ['acme/api'] } };
    if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
    if (url.startsWith('/v1/people')) return { data: { names: {} } };
    return { data: overview };
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); get.mockReset(); });

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/prs']}><PrOverviewPage /></MemoryRouter></QueryClientProvider>);
  return screen.findByRole('grid', { name: /PRs per developer, per day/i });
}
/** The grid's tab stops: everything a Tab can land on inside it. */
const stops = (grid: HTMLElement) => Array.from(grid.querySelectorAll<HTMLElement>('[tabindex]')).filter(el => el.tabIndex >= 0);
const focused = () => document.activeElement as HTMLElement;
const nameOf = (el: Element) => el.getAttribute('aria-label') ?? '';
const press = (key: string, opts: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(focused(), { key, ...opts });

describe('the heatmap is a grid', () => {
  it('has a row per developer, named by a row header, with a cell per day', async () => {
    const grid = await mount();
    const days = screen.getAllByTestId('heatmap-day').length;
    const rows = within(grid).getAllByRole('row').filter(r => within(r).queryAllByRole('gridcell').length > 0);
    expect(rows.map(r => within(r).getByRole('rowheader').textContent)).toEqual([
      expect.stringContaining('alice@acme.com'), expect.stringContaining('bob@acme.com'),
    ]);
    for (const r of rows) expect(within(r).getAllByRole('gridcell')).toHaveLength(days);
  });

  it('names the empty days too', async () => {
    const grid = await mount();
    expect(within(grid).getAllByLabelText(/^No PRs by alice@acme\.com on 2026-08-\d\d$/).length).toBeGreaterThan(0);
  });
});

describe('one tab stop', () => {
  it('is the only element in the heatmap a Tab lands on, starting at the first day with PRs', async () => {
    const grid = await mount();
    expect(stops(grid)).toHaveLength(1);
    expect(nameOf(stops(grid)[0])).toBe('2 PRs by alice@acme.com on 2026-08-12 — open list');
  });

  it('follows the cell the arrows move to', async () => {
    const grid = await mount();
    stops(grid)[0].focus();
    press('ArrowRight');
    expect(nameOf(focused())).toBe('No PRs by alice@acme.com on 2026-08-13');
    expect(stops(grid)).toEqual([focused()]);
    press('ArrowDown');
    expect(nameOf(focused())).toBe('1 PR by bob@acme.com on 2026-08-13 — open list');
    press('ArrowLeft');
    expect(nameOf(focused())).toBe('No PRs by bob@acme.com on 2026-08-12');
    press('ArrowUp');
    expect(nameOf(focused())).toBe('2 PRs by alice@acme.com on 2026-08-12 — open list');
    expect(stops(grid)).toEqual([focused()]);
  });
});

describe('moving along rows and to the corners', () => {
  it('goes to a row\'s ends with Home and End, and to the grid\'s with Ctrl', async () => {
    const grid = await mount();
    const days = screen.getAllByTestId('heatmap-day').length;
    stops(grid)[0].focus();
    press('Home');
    const first = nameOf(focused());
    expect(first).toMatch(/by alice@acme\.com on/);
    press('End');
    expect(nameOf(focused())).toMatch(/by alice@acme\.com on/);
    expect(nameOf(focused())).not.toBe(first);
    press('Home', { ctrlKey: true });
    expect(nameOf(focused())).toBe(first);
    press('End', { ctrlKey: true });
    expect(nameOf(focused())).toMatch(/by bob@acme\.com on/);
    // The last cell of the last row: a step right or down goes nowhere.
    const corner = focused();
    press('ArrowRight');
    press('ArrowDown');
    expect(focused()).toBe(corner);
    expect(within(grid).getAllByRole('gridcell')).toHaveLength(days * 2);
  });

  it('stops at the first cell', async () => {
    const grid = await mount();
    stops(grid)[0].focus();
    press('Home', { ctrlKey: true });
    const origin = focused();
    press('ArrowLeft');
    press('ArrowUp');
    expect(focused()).toBe(origin);
  });
});

describe('opening a day', () => {
  it('opens the PR list with Enter on a day with PRs', async () => {
    const grid = await mount();
    stops(grid)[0].focus();
    press('ArrowRight');
    press('ArrowDown');
    press('Enter');
    expect(await screen.findByRole('dialog', { name: 'PRs by bob@acme.com on 2026-08-13' })).toBeInTheDocument();
  });

  it('opens it with Space too, and does nothing on an empty day', async () => {
    const grid = await mount();
    stops(grid)[0].focus();
    press('ArrowRight');
    press('Enter');
    press(' ');
    expect(screen.queryByRole('dialog')).toBeNull();
    press('ArrowLeft');
    press(' ');
    expect(await screen.findByRole('dialog', { name: 'PRs by alice@acme.com on 2026-08-12' })).toBeInTheDocument();
  });
});

describe('the tooltip', () => {
  it('opens on focus as it does on hover, follows the arrows and closes on blur', async () => {
    const grid = await mount();
    stops(grid)[0].focus();
    expect(await screen.findByText(cellTooltip('alice@acme.com', '2026-08-12', 2))).toBeInTheDocument();
    press('ArrowDown');
    expect(await screen.findByText(cellTooltip('bob@acme.com', '2026-08-12', 0))).toBeInTheDocument();
    fireEvent.blur(focused());
    await waitFor(() => expect(screen.queryByText(cellTooltip('bob@acme.com', '2026-08-12', 0))).toBeNull());
  });
});

// Epic review 115b658d.
describe('the focus tooltip, after review', () => {
  it('closes on Escape and keeps the focus where it was', async () => {
    const grid = await mount();
    stops(grid)[0].focus();
    const text = cellTooltip('alice@acme.com', '2026-08-12', 2);
    expect(await screen.findByText(text)).toBeInTheDocument();
    const cell = focused();
    press('Escape');
    expect(screen.queryByText(text)).toBeNull();
    expect(focused()).toBe(cell);
  });

  it('is measured after focus has scrolled the cell into view', async () => {
    const grid = await mount();
    let left = 100;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ left, top: 300, width: 20, height: 20, right: left + 20, bottom: 320, x: left, y: 300, toJSON: () => ({}) }) as DOMRect,
    );
    try {
      stops(grid)[0].focus();
      // The browser scrolls the focused cell into view after the focus event.
      left = 500;
      const tip = await screen.findByText(cellTooltip('alice@acme.com', '2026-08-12', 2));
      expect(parseFloat(tip.style.left)).toBe(510);
    } finally {
      spy.mockRestore();
    }
  });

  it('closes when the heatmap scrolls under it', async () => {
    const grid = await mount();
    stops(grid)[0].focus();
    const text = cellTooltip('alice@acme.com', '2026-08-12', 2);
    expect(await screen.findByText(text)).toBeInTheDocument();
    fireEvent.scroll(grid.closest('.overflow-x-auto')!);
    expect(screen.queryByText(text)).toBeNull();
  });

  it('does not open when the focus came from a click, as it does after the PR list closes', async () => {
    const grid = await mount();
    const target = stops(grid)[0];
    fireEvent.pointerDown(target);
    target.focus();
    await new Promise(r => setTimeout(r, 50));
    expect(screen.queryByText(cellTooltip('alice@acme.com', '2026-08-12', 2))).toBeNull();
  });
});

describe('keys the grid owns', () => {
  it('keeps Space on an empty day from scrolling the page', async () => {
    const grid = await mount();
    stops(grid)[0].focus();
    press('ArrowRight');
    expect(fireEvent.keyDown(focused(), { key: ' ' })).toBe(false);
  });

  it('leaves Alt+Arrow to the browser', async () => {
    const grid = await mount();
    stops(grid)[0].focus();
    const cell = focused();
    expect(fireEvent.keyDown(cell, { key: 'ArrowLeft', altKey: true })).toBe(true);
    expect(focused()).toBe(cell);
  });
});

describe('a new answer', () => {
  it('puts the tab stop back on its first day with PRs', async () => {
    const grid = await mount();
    stops(grid)[0].focus();
    press('End');
    // The stop is on alice's row (row 0), last day.
    expect(nameOf(stops(grid)[0])).toMatch(/by alice@acme\.com/);
    // The next answer lists bob first: row 0 is now someone else.
    const reordered = { ...overview, byDeveloper: [...overview.byDeveloper].reverse() };
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: ['acme/api'] } };
      if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
      if (url.startsWith('/v1/people')) return { data: { names: {} } };
      return { data: reordered };
    });
    fireEvent.click(screen.getByRole('button', { name: '90d' }));
    await waitFor(() => expect(nameOf(stops(grid)[0])).toBe('1 PR by bob@acme.com on 2026-08-13 — open list'));
  });
});
