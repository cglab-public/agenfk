/**
 * @vitest-environment jsdom
 *
 * Story 4e45bf2f: every sparkline scaled to its own peak, so a row with one
 * PR a day drew the same mountain as a row with twenty, and rows could not be
 * compared. A table's sparklines now share one scale, the peak over all its
 * rows. And the Weighted size tile gets the change-vs-previous badge the API
 * always sent (previous.sizePoints) but the page never showed.
 */
import React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sparkline } from '../components/Sparkline';
import { PrOverviewPage } from '../pages/PrOverview';
import { OrgPage } from '../pages/Org';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
afterEach(() => { cleanup(); get.mockReset(); vi.useRealTimers(); });

/** The y of the highest point a sparkline draws (smaller is higher). */
function topY(svg: Element): number {
  const line = svg.querySelector('polyline');
  if (line) return Math.min(...line.getAttribute('points')!.split(' ').map(p => Number(p.split(',')[1])));
  return Number(svg.querySelector('circle')!.getAttribute('cy'));
}
/** The y a sparkline draws for the point at `index`. */
const yAt = (svg: Element, index: number) =>
  Number(svg.querySelector('polyline')!.getAttribute('points')!.split(' ')[index].split(',')[1]);

describe('Sparkline on a shared scale', () => {
  it('draws the same value at the same height whatever each line\'s own peak', () => {
    const axis = ['a', 'b'];
    const { container } = render(<>
      <Sparkline daily={{ a: 2, b: 4 }} axis={axis} max={4} />
      <Sparkline daily={{ a: 2, b: 1 }} axis={axis} max={4} />
    </>);
    const [high, low] = Array.from(container.querySelectorAll('svg'));
    expect(yAt(low, 0)).toBe(yAt(high, 0));
    // Only the line that reaches the shared peak touches the top.
    expect(topY(high)).toBeLessThan(topY(low));
  });

  it('scales to its own peak when given none, as before', () => {
    const { container } = render(<Sparkline daily={{ a: 1, b: 2 }} axis={['a', 'b']} />);
    expect(topY(container.querySelector('svg')!)).toBe(2);
  });

  it('never draws above the top when a value exceeds the shared peak', () => {
    const { container } = render(<Sparkline daily={{ a: 9 }} axis={['a', 'b']} max={3} />);
    expect(topY(container.querySelector('svg')!)).toBeGreaterThanOrEqual(2);
  });
});

const sizes = (o: Record<string, number>) => ({ xs: 0, s: 0, m: 0, l: 0, xl: 0, ...o });
const noDevs = { xs: [], s: [], m: [], l: [], xl: [] };
function overview(previous: { prs: number; sizePoints: number } | null) {
  return {
    period: { from: '2026-08-10T12:00:00.000Z', to: '2026-08-14T12:00:00.000Z' },
    buckets: ['xs', 's', 'm', 'l', 'xl'],
    totals: { prs: 5, sizePoints: 6, developers: 2, medianBucket: 'xs' },
    resized: { count: 0, grew: 0, shrank: 0 },
    byDay: [
      { day: '2026-08-12', sizes: sizes({ xs: 4 }), total: 4, devBySize: { ...noDevs, xs: [{ user_key: 'alice@acme.com', count: 4 }] } },
      { day: '2026-08-13', sizes: sizes({ xs: 1 }), total: 1, devBySize: { ...noDevs, xs: [{ user_key: 'bob@acme.com', count: 1 }] } },
    ],
    byDeveloper: [
      { user_key: 'alice@acme.com', prs: 4, sizePoints: 4, sizes: sizes({ xs: 4 }), daily: { '2026-08-12': 4 } },
      { user_key: 'bob@acme.com', prs: 1, sizePoints: 2, sizes: sizes({ xs: 1 }), daily: { '2026-08-13': 1 } },
    ],
    byModel: [],
    prs: [],
    previous,
  };
}
async function mountPrs(previous: { prs: number; sizePoints: number } | null) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'));
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
    if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
    if (url.startsWith('/v1/people')) return { data: { names: {} } };
    return { data: overview(previous) };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/prs']}><PrOverviewPage /></MemoryRouter></QueryClientProvider>);
  await screen.findByText('Weighted size');
}

describe('PR Overview: By developer trends', () => {
  it('share one scale, so one PR a day sits below four', async () => {
    await mountPrs(null);
    const table = screen.getByRole('table', { name: 'By developer' });
    const trend = (who: RegExp) => within(within(table).getByRole('row', { name: who })).getAllByRole('cell').at(-1)!.querySelector('svg')!;
    expect(topY(trend(/alice@acme\.com/))).toBe(2);
    // 1 of a shared 4: a quarter of the way up the 20px drawing height.
    expect(topY(trend(/bob@acme\.com/))).toBe(17);
  });
});

describe('PR Overview: Weighted size', () => {
  it('shows its change against the previous period, as Total PRs does', async () => {
    await mountPrs({ prs: 4, sizePoints: 4 });
    const tile = screen.getByText('Weighted size').closest('[data-stat-tile]') as HTMLElement;
    expect(within(tile).getByTestId('stat-delta')).toHaveTextContent(/▲\s*50%/);
  });

  it('shows none without a previous period', async () => {
    await mountPrs(null);
    const tile = screen.getByText('Weighted size').closest('[data-stat-tile]') as HTMLElement;
    expect(within(tile).queryByTestId('stat-delta')).toBeNull();
  });
});

describe('Org: Users closures', () => {
  it('share one scale across the people listed', async () => {
    const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    const users = [
      { user_key: 'bob@acme.com', last_seen: new Date().toISOString(), events_count: 3, items_closed: 2, validate_passes: 0, validate_fails: 0, prs_opened: 0, closed_daily: { [day(3)]: 1, [day(2)]: 1 } },
      { user_key: 'alice@acme.com', last_seen: new Date().toISOString(), events_count: 4, items_closed: 4, validate_passes: 0, validate_fails: 0, prs_opened: 0, closed_daily: { [day(4)]: 4 } },
    ];
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/users')) return { data: users };
      if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: [] } };
      if (url.startsWith('/v1/event-types')) return { data: { types: [] } };
      if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
      if (url.startsWith('/v1/item-types')) return { data: { itemTypes: [], counts: {} } };
      if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
      return { data: {} };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/']}><OrgPage /></MemoryRouter></QueryClientProvider>);
    const table = await screen.findByRole('table', { name: 'Users' });
    const line = (who: RegExp) => within(within(table).getByRole('row', { name: who })).getByRole('img', { name: /^Closures:/ });
    expect(topY(line(/alice@acme\.com/))).toBe(2);
    expect(topY(line(/bob@acme\.com/))).toBe(17);
  });
});
