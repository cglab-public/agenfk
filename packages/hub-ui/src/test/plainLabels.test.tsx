/**
 * @vitest-environment jsdom
 *
 * Plain-language labels (story ece10295). Event types read as words under a
 * few headings, with the raw id kept on hover; the two check tiles become one
 * pass rate; size points say what they are and link to how they are derived;
 * the heatmap's contribution pills are legible.
 */
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { eventTypeLabel, groupEventTypes } from '../eventTypes';
import { EventTypeChips } from '../components/EventTypeChips';
import { MetricsTilesRow } from '../components/MetricsTilesRow';
import { TimelineBar } from '../components/TimelineBar';
import { fmtBucketKey } from '../components/timelineAxis';
import { describeFilters } from '../filterSummary';
import { OrgPage } from '../pages/Org';
import { PrOverviewPage } from '../pages/PrOverview';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
afterEach(() => { cleanup(); get.mockReset(); });

const mount = (el: React.ReactElement, entry = '/') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={[entry]}>{el}</MemoryRouter></QueryClientProvider>,
  );
};

describe('event type catalogue', () => {
  it('names known types in words and leaves unknown ones as they are', () => {
    expect(eventTypeLabel('item.closed')).toBe('Item closed');
    expect(eventTypeLabel('validate.passed')).toBe('Check passed');
    expect(eventTypeLabel('step.transitioned')).toBe('Step changed');
    expect(eventTypeLabel('passkey.enrolled')).toBe('Passkey enrolled');
    expect(eventTypeLabel('pr.opened')).toBe('PR opened');
    expect(eventTypeLabel('acme.custom')).toBe('acme.custom');
  });

  it('groups types under fixed headings in a fixed order, unknown ones last', () => {
    expect(groupEventTypes(['acme.custom', 'session.started', 'validate.passed', 'item.closed', 'passkey.enrolled', 'item.created']))
      .toEqual([
        { group: 'Work items', types: ['item.created', 'item.closed'] },
        { group: 'Checks', types: ['validate.passed'] },
        { group: 'Sessions', types: ['session.started'] },
        { group: 'Security', types: ['passkey.enrolled'] },
        { group: 'Other', types: ['acme.custom'] },
      ]);
  });

  it('leaves out headings with nothing under them', () => {
    expect(groupEventTypes(['item.closed']).map(g => g.group)).toEqual(['Work items']);
    expect(groupEventTypes([])).toEqual([]);
  });
});

describe('EventTypeChips', () => {
  function Harness({ initial = [] as string[] }) {
    const [sel, setSel] = useState(new Set(initial));
    return (
      <EventTypeChips
        options={['item.closed', 'validate.failed', 'acme.custom']}
        selected={sel}
        onToggle={t => setSel(s => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; })}
        onClear={() => setSel(new Set())}
      />
    );
  }

  it('names each heading’s chips as a group, for screen readers', () => {
    render(<Harness />);
    // Multi-word headings too: an id with a space in it names nothing.
    expect(screen.getByRole('group', { name: 'Work items' })).toBeInTheDocument();
    const checks = screen.getByRole('group', { name: 'Checks' });
    expect(within(checks).getByRole('button', { name: 'Check failed' })).toBeInTheDocument();
    expect(within(checks).queryByRole('button', { name: 'Item closed' })).toBeNull();
  });

  it('shows words under headings, with the raw id on hover', () => {
    render(<Harness />);
    const group = screen.getByRole('group', { name: 'Event type' });
    expect(within(group).getByText('Work items')).toBeInTheDocument();
    expect(within(group).getByText('Checks')).toBeInTheDocument();
    expect(within(group).getByText('Other')).toBeInTheDocument();
    const chip = within(group).getByRole('button', { name: 'Item closed' });
    expect(chip).toHaveAttribute('title', 'item.closed');
    expect(within(group).getByRole('button', { name: 'acme.custom' })).toBeInTheDocument();
  });

  it('toggles by the raw id and clears', () => {
    render(<Harness initial={['validate.failed']} />);
    expect(screen.getByRole('button', { name: 'Check failed' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Item closed' }));
    expect(screen.getByRole('button', { name: 'Item closed' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Clear Event type filter (2)' }));
    expect(screen.queryByRole('button', { pressed: true })).toBeNull();
  });
});

describe('the filter summary names event types in words', () => {
  it('reads the defaults with the label', () => {
    expect(describeFilters({ range: '30d', types: ['item.closed'], projects: [] })).toBe('30 days · Item closed · all projects');
  });
});

describe('the check tiles become one pass rate', () => {
  it('shows the rate with the counts under it', () => {
    render(<MetricsTilesRow totals={{ events: 10, closed: 2, passes: 3, fails: 1, prsOpened: 1 }} />);
    const tile = screen.getByText('Check pass rate').closest('[data-stat-tile]') as HTMLElement;
    expect(within(tile).getByText('75%')).toBeInTheDocument();
    expect(within(tile).getByText('3 passed · 1 failed')).toBeInTheDocument();
    expect(screen.queryByText('Checks passed')).toBeNull();
    expect(screen.queryByText('Checks failed')).toBeNull();
  });

  it('never rounds to 100% while something failed, or to 0% while something passed', () => {
    const { rerender } = render(<MetricsTilesRow totals={{ events: 0, closed: 0, passes: 999, fails: 1, prsOpened: 0 }} />);
    expect(screen.getByText('99%')).toBeInTheDocument();
    rerender(<MetricsTilesRow totals={{ events: 0, closed: 0, passes: 1, fails: 300, prsOpened: 0 }} />);
    expect(screen.getByText('1%')).toBeInTheDocument();
    rerender(<MetricsTilesRow totals={{ events: 0, closed: 0, passes: 5, fails: 0, prsOpened: 0 }} />);
    expect(screen.getByText('100%')).toBeInTheDocument();
    rerender(<MetricsTilesRow totals={{ events: 0, closed: 0, passes: 0, fails: 5, prsOpened: 0 }} />);
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('carries no series swatch: it is a rate, not the count of one event type', () => {
    render(<MetricsTilesRow totals={{ events: 1, closed: 0, passes: 1, fails: 1, prsOpened: 0 }} />);
    const tile = screen.getByText('Check pass rate').closest('[data-stat-tile]') as HTMLElement;
    expect(within(tile).queryByTestId('stat-swatch')).toBeNull();
  });

  it('shows a dash, not 0% or NaN, when no checks ran', () => {
    render(<MetricsTilesRow totals={{ events: 0, closed: 0, passes: 0, fails: 0, prsOpened: 0 }} />);
    const tile = screen.getByText('Check pass rate').closest('[data-stat-tile]') as HTMLElement;
    expect(within(tile).getByText('—')).toBeInTheDocument();
    expect(within(tile).getByText('no checks ran')).toBeInTheDocument();
  });
});

describe('Org shows words for event types', () => {
  beforeEach(() => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/event-types')) return { data: { types: ['item.closed', 'validate.failed'] } };
      if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
      if (url.startsWith('/v1/item-types')) return { data: { itemTypes: [], counts: {} } };
      if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: [] } };
      if (url.startsWith('/v1/users')) return { data: [] };
      if (url.startsWith('/v1/timeline')) return { data: { events: [] } };
      if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
      return { data: {} };
    });
  });

  it('in the grouped filter and the collapsed summary', async () => {
    mount(<OrgPage />, '/?filters=1');
    expect(await screen.findByText('30 days · Item closed · all projects')).toBeInTheDocument();
    const chip = await screen.findByRole('button', { name: 'Item closed' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip).toHaveAttribute('title', 'item.closed');
    expect(screen.getByRole('button', { name: 'Check failed' })).toBeInTheDocument();
  });
});

describe('the timeline legend and hover list use words', () => {
  it('labels the legend', async () => {
    const today = fmtBucketKey(new Date(), 'day');
    get.mockImplementation(async () => ({ data: { bucket: 'day', buckets: [{ time: today, total: 2, by_type: { 'item.closed': 2 } }] } }));
    const { container } = mount(<TimelineBar types={['item.closed']} range="7d" />);
    await waitFor(() => expect(container.querySelector('rect[fill^="var(--series"]')).not.toBeNull());
    const legend = container.querySelector('footer') as HTMLElement;
    expect(within(legend).getByText('Item closed')).toHaveAttribute('title', 'item.closed');
    expect(within(legend).queryByText('item.closed')).toBeNull();
  });

  it('labels the hover list', async () => {
    const today = fmtBucketKey(new Date(), 'day');
    get.mockImplementation(async () => ({ data: { bucket: 'day', buckets: [{ time: today, total: 2, by_type: { 'validate.failed': 2 } }] } }));
    const { container } = mount(<TimelineBar types={['validate.failed']} range="7d" />);
    await waitFor(() => expect(container.querySelector('rect[fill^="var(--series"]')).not.toBeNull());
    const hit = [...container.querySelectorAll('rect')].find(r => r.getAttribute('fill') === 'transparent' && r.getAttribute('x') !== null && r.parentElement?.querySelector('rect[fill^="var(--series"]'));
    fireEvent.mouseEnter(hit as Element);
    const row = (await screen.findAllByText('Check failed')).find(el => el.closest('li'));
    expect(row).toHaveAttribute('title', 'validate.failed');
  });
});

describe('PR overview explains size and makes the pills legible', () => {
  const overview = {
    period: { from: '2026-08-10T00:00:00.000Z', to: '2026-08-22T23:59:59.999Z' },
    buckets: ['xs', 's', 'm', 'l', 'xl'],
    totals: { prs: 2, sizePoints: 8, developers: 1, medianBucket: 'xs' },
    resized: { count: 0, grew: 0, shrank: 0 },
    byDay: [],
    byDeveloper: [{ user_key: 'alice@acme.com', prs: 2, sizePoints: 8, sizes: { xs: 1, s: 0, m: 0, l: 1, xl: 0 }, daily: {} }],
    byModel: [],
    previous: null,
  };
  beforeEach(() => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
      if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
      return { data: overview };
    });
  });

  it('links the size points to how size is derived', async () => {
    mount(<PrOverviewPage />, '/prs');
    const tile = (await screen.findByText('Weighted size')).closest('[data-stat-tile]') as HTMLElement;
    const link = within(tile).getByRole('link', { name: /how size is derived/i });
    expect(link).toHaveAttribute('href', '#size-derivation');
    expect(document.getElementById('size-derivation')).toHaveTextContent('How size is derived');
  });

  it('spells out each developer’s share, legibly', async () => {
    mount(<PrOverviewPage />, '/prs');
    const prs = await screen.findByText('100% of PRs');
    const size = screen.getByText('100% of size');
    for (const pill of [prs, size]) expect(pill.className).not.toMatch(/text-\[9px\]/);
    expect(prs).toHaveAttribute('title', expect.stringMatching(/share of all PRs/));
    expect(size).toHaveAttribute('title', expect.stringMatching(/share of all size points/));
  });
});
