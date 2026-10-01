/**
 * @vitest-environment jsdom
 *
 * One PageHeader and one StatTile across the dashboards (story 69b9702e).
 *
 * Org used to keep its period in the page body and PR overview in its header;
 * PR overview drew its KPI and volume tiles with two local components while Org
 * used StatTile. Both pages now open with the same PageHeader, the period lives
 * in its toolbar on both, and every headline number is a StatTile.
 */
import { render, screen, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PageHeader, PeriodControl, StatTile } from '../components/ui';
import { OrgPage } from '../pages/Org';
import { PrOverviewPage } from '../pages/PrOverview';
import { api } from '../api';
import { fmtAverage } from '../prOverview';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const overview = {
  period: { from: '2026-08-10T00:00:00.000Z', to: '2026-08-22T23:59:59.999Z' },
  buckets: ['xs', 's', 'm', 'l', 'xl'],
  totals: { prs: 2, sizePoints: 8, developers: 1, medianBucket: 'xs' },
  resized: { count: 0, grew: 0, shrank: 0 },
  byDay: [{
    day: '2026-08-13',
    sizes: { xs: 1, s: 0, m: 0, l: 1, xl: 0 },
    total: 2,
    devBySize: { xs: [{ user_key: 'alice@acme.com', count: 1 }], s: [], m: [], l: [{ user_key: 'alice@acme.com', count: 1 }], xl: [] },
  }],
  byDeveloper: [{ user_key: 'alice@acme.com', prs: 2, sizePoints: 8, sizes: { xs: 1, s: 0, m: 0, l: 1, xl: 0 }, daily: { '2026-08-13': 2 } }],
  byModel: [],
  previous: { prs: 1, sizePoints: 4 },
};

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/prs/overview')) return { data: overview };
    if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
    if (url.startsWith('/v1/event-types')) return { data: { types: ['item.closed'] } };
    if (url.startsWith('/v1/projects')) return { data: { projects: ['acme/api'] } };
    if (url.startsWith('/v1/item-types')) return { data: { itemTypes: ['TASK'], counts: {} } };
    if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: [] } };
    if (url.startsWith('/v1/users')) return { data: [] };
    if (url.startsWith('/v1/timeline')) return { data: { events: [] } };
    if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
    return { data: {} };
  });
});
afterEach(() => { cleanup(); });

const renderPage = (page: React.ReactElement, entry = '/') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>{page}</MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('PageHeader', () => {
  it('renders the eyebrow, a level-1 title, the subtitle and the toolbar inside one header', () => {
    render(
      <PageHeader eyebrow="Dashboard" title="Organization rollup" subtitle="Fleet-wide activity." toolbar={<button>7d</button>} />,
    );
    const header = document.querySelector('[data-page-header]') as HTMLElement;
    expect(header).not.toBeNull();
    const h = within(header);
    expect(h.getByText('Dashboard')).toBeInTheDocument();
    expect(h.getByRole('heading', { level: 1, name: 'Organization rollup' })).toBeInTheDocument();
    expect(h.getByText('Fleet-wide activity.')).toBeInTheDocument();
    expect(header.querySelector('[data-page-toolbar]')).toContainElement(h.getByRole('button', { name: '7d' }));
  });

  it('renders no toolbar slot when none is given', () => {
    render(<PageHeader eyebrow="E" title="T" />);
    expect(document.querySelector('[data-page-toolbar]')).toBeNull();
  });
});

describe('StatTile footer and size', () => {
  it('shows a hint under the value', () => {
    render(<StatTile label="Weighted size" value={2751} hint="size points" />);
    const tile = screen.getByText('Weighted size').closest('[data-stat-tile]') as HTMLElement;
    expect(within(tile).getByText('size points')).toBeInTheDocument();
  });

  it('renders a numeric 0 hint as text, and no hint row for an empty one', () => {
    render(<><StatTile label="zero" value={1} hint={0} /><StatTile label="none" value={1} hint="" /></>);
    const zero = screen.getByText('zero').closest('[data-stat-tile]') as HTMLElement;
    expect(zero.querySelector('[data-stat-hint]')).toHaveTextContent('0');
    const none = screen.getByText('none').closest('[data-stat-tile]') as HTMLElement;
    expect(none.querySelector('[data-stat-hint]')).toBeNull();
  });

  it('marks itself as a stat tile and takes a compact size', () => {
    render(<><StatTile label="big" value={1} /><StatTile label="small" value={2} size="sm" /></>);
    const big = screen.getByText('big').closest('[data-stat-tile]') as HTMLElement;
    const small = screen.getByText('small').closest('[data-stat-tile]') as HTMLElement;
    expect(big).toHaveAttribute('data-size', 'md');
    expect(small).toHaveAttribute('data-size', 'sm');
  });
});

describe('PeriodControl', () => {
  const RANGES = [{ key: '7d', label: '7d' }, { key: '30d', label: '30d' }] as const;

  it('is a group named by its visible caption, once', () => {
    render(<PeriodControl ranges={RANGES} active="7d" onPick={() => {}} />);
    const group = screen.getByRole('group', { name: 'Period' });
    // Named by the caption it shows, not a second aria-label read twice.
    expect(group).not.toHaveAttribute('aria-label');
    expect(group).toHaveAttribute('aria-labelledby');
    expect(group.className).toMatch(/\bflex-wrap\b/);
  });

  it('presses the active preset and reports a pick', () => {
    const onPick = vi.fn();
    render(<PeriodControl ranges={RANGES} active="7d" onPick={onPick} />);
    expect(screen.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'false');
    screen.getByRole('button', { name: '30d' }).click();
    expect(onPick).toHaveBeenCalledWith('30d');
  });

  it('presses nothing when no preset is active (a custom range)', () => {
    render(<PeriodControl ranges={RANGES} active={null} onPick={() => {}} />);
    expect(screen.queryByRole('button', { pressed: true })).toBeNull();
  });

  it('disables the presets, keeps the explanation and renders the extra controls', () => {
    render(
      <PeriodControl ranges={RANGES} active="7d" onPick={() => {}} disabled title="superseded">
        <input aria-label="From date" />
      </PeriodControl>,
    );
    const group = screen.getByRole('group', { name: 'Period' });
    expect(group).toHaveAttribute('title', 'superseded');
    for (const b of within(group).getAllByRole('button')) expect(b).toBeDisabled();
    expect(within(group).getByLabelText('From date')).toBeInTheDocument();
  });
});

describe('both dashboards share the header and keep the period in its toolbar', () => {
  it('Org', () => {
    renderPage(<OrgPage />);
    const header = document.querySelector('[data-page-header]') as HTMLElement;
    expect(header).not.toBeNull();
    expect(within(header).getByRole('heading', { level: 1, name: 'Organization rollup' })).toBeInTheDocument();
    const toolbar = header.querySelector('[data-page-toolbar]') as HTMLElement;
    expect(within(toolbar).getByRole('group', { name: 'Period' })).toBeInTheDocument();
  });

  it('PR overview', () => {
    renderPage(<PrOverviewPage />, '/prs');
    const header = document.querySelector('[data-page-header]') as HTMLElement;
    expect(header).not.toBeNull();
    expect(within(header).getByRole('heading', { level: 1, name: 'PR Overview' })).toBeInTheDocument();
    const toolbar = header.querySelector('[data-page-toolbar]') as HTMLElement;
    const period = within(toolbar).getByRole('group', { name: 'Period' });
    expect(within(period).getByLabelText('From date')).toBeInTheDocument();
  });

  it('PR overview: a PR search disables the period and says why', async () => {
    renderPage(<PrOverviewPage />, '/prs?pr=12');
    const toolbar = document.querySelector('[data-page-toolbar]') as HTMLElement;
    const period = within(toolbar).getByRole('group', { name: 'Period' });
    expect(period.getAttribute('title')).toMatch(/PR search supersedes the date range/);
    for (const b of within(period).getAllByRole('button')) expect(b).toBeDisabled();
    expect(within(period).getByLabelText('From date')).toBeDisabled();
  });
});

describe('PR overview draws every headline number with StatTile', () => {
  it('KPI tiles, with the PR delta as a StatTile delta', async () => {
    renderPage(<PrOverviewPage />, '/prs');
    const label = await screen.findByText('Total PRs');
    const tile = label.closest('[data-stat-tile]') as HTMLElement;
    expect(tile).not.toBeNull();
    // 2 vs 1 previous: +100%.
    const delta = within(tile).getByTestId('stat-delta');
    expect(delta).toHaveTextContent('100%');
    // More PRs is the good direction.
    expect(delta.className).toMatch(/text-status-ok-text/);
    const oneDecimal = (2).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    expect(screen.getByText(`${oneDecimal} PRs / dev`)).toBeInTheDocument();
    expect(screen.getByText('across 2 PRs')).toBeInTheDocument();
    const median = screen.getByText('Median size').closest('[data-stat-tile]') as HTMLElement;
    expect(within(median).getByText('XS')).toBeInTheDocument();
    for (const name of ['Weighted size', 'Active developers', 'Median size']) {
      expect(screen.getByText(name).closest('[data-stat-tile]')).not.toBeNull();
    }
  });

  it('volume stats are compact StatTiles', async () => {
    renderPage(<PrOverviewPage />, '/prs');
    await screen.findByText('Total PRs');
    for (const label of [/^Total$/, /^Average \//, /^Max/]) {
      const tile = screen.getByText(label).closest('[data-stat-tile]') as HTMLElement;
      expect(tile).not.toBeNull();
      expect(tile).toHaveAttribute('data-size', 'sm');
    }
  });
});

describe('fmtAverage', () => {
  it('keeps integers bare and shows exactly one decimal otherwise, grouped', () => {
    const one = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    expect(fmtAverage(2)).toBe('2');
    expect(fmtAverage(2.04)).toBe(one(2.04));
    // One decimal even when it is zero: "2.0"/"2,0", never a bare "2".
    expect(fmtAverage(2.04)).toMatch(/^2[.,]0$/);
    expect(fmtAverage(2.96)).toMatch(/^3[.,]0$/);
    expect(fmtAverage(1234.5)).toBe((1234.5).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
    expect(fmtAverage(12345)).toBe((12345).toLocaleString());
  });
});
