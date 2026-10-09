/**
 * @vitest-environment jsdom
 *
 * The dashboards open on data, not on filters. Org used to spend ~550px of the
 * first screen on facet chips and PR overview's accordion started open, so no
 * chart was visible without scrolling. The filters now start collapsed behind
 * one summary line that says what is applied; the period (and PR overview's
 * PR search) stay in an always-visible toolbar.
 */
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgPage } from '../pages/Org';
import { UserDetailPage } from '../pages/UserDetail';
import { PrOverviewPage } from '../pages/PrOverview';
import { describeFilters } from '../filterSummary';
import { fmtDate } from '../dates';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const OVERVIEW = {
  period: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z' },
  buckets: ['xs', 's', 'm', 'l', 'xl'],
  totals: { prs: 0, sizePoints: 0, developers: 0, medianBucket: null },
  resized: { count: 0, grew: 0, shrank: 0 },
  byDay: [], byDeveloper: [], byModel: [], prs: [], previous: null,
};

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/event-types')) return { data: { types: ['item.closed', 'item.created'] } };
    if (url.startsWith('/v1/projects')) return { data: { projects: ['acme/api', 'acme/web'] } };
    if (url.startsWith('/v1/item-types')) return { data: { itemTypes: ['TASK'], counts: {} } };
    if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: [] } };
    if (url.startsWith('/v1/users')) return { data: [] };
    if (url.startsWith('/v1/timeline')) return { data: { events: [] } };
    if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
    if (url.startsWith('/v1/prs/overview')) return { data: OVERVIEW };
    return { data: {} };
  });
  try { window.localStorage.clear(); } catch { /* blocked */ }
});
afterEach(() => { cleanup(); });

let current = new URLSearchParams();
let go: (to: string) => void = () => {};
function Where() {
  current = new URLSearchParams(useLocation().search);
  const navigate = useNavigate();
  go = to => navigate(to);
  return null;
}

const renderAt = (entry: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Where />
        <Routes>
          <Route path="/" element={<OrgPage />} />
          <Route path="/prs" element={<PrOverviewPage />} />
          <Route path="/users/:userKey" element={<UserDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('describeFilters', () => {
  it('reads the defaults as one line', () => {
    expect(describeFilters({ range: '30d', types: ['item.closed'], projects: [] })).toBe('30 days · Item closed · all projects');
  });

  it('names a few values and counts many', () => {
    expect(describeFilters({
      range: '7d',
      types: ['item.closed', 'item.created', 'item.updated'],
      projects: ['acme/api'],
      itemTypes: ['TASK', 'BUG'],
      childHubs: 2,
    })).toBe('7 days · 3 event types · acme/api · TASK, BUG · 2 child hubs');
  });

  it('reads an empty event-type selection as every type, which is what it filters', () => {
    expect(describeFilters({ range: 'today', types: [], projects: ['a', 'b'] })).toBe('today · all event types · 2 projects');
  });

  it('prefers a custom date range over the preset, in the one date format', () => {
    // Local days, written the way every other date in the hub is (story 12753604).
    const day = (v: string) => fmtDate(new Date(`${v}T00:00:00`));
    expect(describeFilters({ range: '30d', from: '2026-09-01', to: '2026-09-10', types: ['item.closed'], projects: [] }))
      .toBe(`${day('2026-09-01')} → ${day('2026-09-10')} · Item closed · all projects`);
    expect(describeFilters({ range: '30d', from: '2026-09-01', types: [] }))
      .toBe(`${day('2026-09-01')} → … · all event types`);
    // Not something a link can break: an invalid date is echoed, not "Invalid Date".
    expect(describeFilters({ range: '30d', from: 'garbage', types: [] })).toBe('garbage → … · all event types');
  });

  it('reads a custom date as a LOCAL day even west of UTC', () => {
    const saved = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      // A UTC parse would make this Aug 31 in Los Angeles. Compared in the
      // runner's own locale, which writes the day first or the month first.
      const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
      const sep1 = new Date(2026, 8, 1).toLocaleDateString(undefined, opts);
      const aug31 = new Date(2026, 7, 31).toLocaleDateString(undefined, opts);
      const line = describeFilters({ range: '30d', from: '2026-09-01', types: [] });
      expect(line).toBe(`${sep1} → … · all event types`);
      expect(line).not.toContain(aug31);
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
  });
});

describe('Org rollup opens on data', () => {
  it('starts collapsed, with the summary and the period in view', async () => {
    renderAt('/');
    const toggle = await screen.findByRole('button', { name: 'Edit filters' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('30 days · Item closed · all projects')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30d', pressed: true })).toBeInTheDocument();
    // The chips are behind the fold, not merely scrolled away.
    expect(screen.queryByRole('button', { name: 'Item created' })).not.toBeInTheDocument();
  });

  it('opens on request, and remembers that in the link', async () => {
    renderAt('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit filters' }));
    expect(await screen.findByRole('button', { name: 'Item created' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide filters' })).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(current.get('filters')).toBe('1'));
  });

  it('opens a link that says so already open', async () => {
    renderAt('/?filters=1');
    expect(await screen.findByRole('button', { name: 'Item created' })).toBeInTheDocument();
  });

  it('summarises what the link applies', async () => {
    renderAt('/?range=7d&types=item.closed%2Citem.created&projects=acme%2Fapi');
    expect(await screen.findByText('7 days · Item closed, Item created · acme/api')).toBeInTheDocument();
  });
});

describe('the summary stays readable', () => {
  it('names a project by its short name, as the facet does', async () => {
    renderAt('/?projects=https%3A%2F%2Fgithub.com%2Facme%2Fsome-long-repo.git&itemTypes=TASK');
    expect(await screen.findByText('30 days · Item closed · acme/some-long-repo · TASK')).toBeInTheDocument();
  });
});

describe('user page opens on data', () => {
  it('opens on request, and remembers that in the link', async () => {
    renderAt('/users/alice%40acme.com?childHubId=h1');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit filters' }));
    expect(await screen.findByRole('button', { name: 'Item created' })).toBeInTheDocument();
    await waitFor(() => expect(current.get('filters')).toBe('1'));
    expect(current.get('childHubId')).toBe('h1');
  });

  it('summarises a custom date range', async () => {
    renderAt('/users/alice%40acme.com?from=2026-09-01&to=2026-09-10');
    // In the hub's one date format (story 12753604).
    const day = (v: string) => fmtDate(new Date(`${v}T00:00:00`));
    expect(await screen.findByText(`${day('2026-09-01')} → ${day('2026-09-10')} · Item closed · all projects`)).toBeInTheDocument();
  });

  it('starts collapsed, with the summary and the period in view', async () => {
    renderAt('/users/alice%40acme.com');
    expect(await screen.findByRole('button', { name: 'Edit filters' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('30 days · Item closed · all projects')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30d', pressed: true })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Item created' })).not.toBeInTheDocument();
  });
});

describe('the whole filter header toggles the fold', () => {
  it('Org: clicking the summary line toggles, not just the link', async () => {
    renderAt('/');
    fireEvent.click(await screen.findByText('30 days · Item closed · all projects'));
    expect(await screen.findByRole('button', { name: 'Item created' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('30 days · Item closed · all projects'));
    expect(await screen.findByRole('button', { name: 'Edit filters' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('Org: clicking the active-count badge toggles too', async () => {
    renderAt('/?projects=acme%2Fapi');
    // Scoped to the header: /active/ alone could match body copy.
    fireEvent.click(within(await screen.findByTestId('filter-header')).getByText(/active/));
    expect(await screen.findByRole('button', { name: 'Item created' })).toBeInTheDocument();
  });

  it('a row click toggles exactly once (no double-fire regression)', async () => {
    renderAt('/');
    fireEvent.click(await screen.findByTestId('filter-header'));
    expect(await screen.findByRole('button', { name: 'Hide filters' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('PR overview: clicking the summary line toggles', async () => {
    renderAt('/prs');
    fireEvent.click(await screen.findByText('30 days · all projects'));
    expect(await screen.findByRole('button', { name: 'Hide filters' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByText('30 days · all projects'));
    expect(await screen.findByRole('button', { name: 'Edit filters' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('stays keyboard-accessible: the button activation still toggles', async () => {
    renderAt('/');
    const row = await screen.findByTestId('filter-header');
    // Keyboard users activate the button; the resulting click bubbles to the
    // row, which is where the toggle now lives.
    fireEvent.click(within(row).getByRole('button', { name: 'Edit filters' }));
    expect(await screen.findByRole('button', { name: 'Item created' })).toBeInTheDocument();
  });
});

describe('PR overview opens on data', () => {
  it('starts collapsed, with the period and the PR search in view', async () => {
    renderAt('/prs');
    expect(await screen.findByRole('button', { name: 'Edit filters' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('30 days · all projects')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /PR number/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30d', pressed: true })).toBeInTheDocument();
  });

  it('names a selected project once in the summary', async () => {
    renderAt('/prs?projects=acme%2Fapi');
    expect(await screen.findByText('30 days · acme/api')).toBeInTheDocument();
  });

  it('follows the URL when a navigation drops the open flag', async () => {
    renderAt('/prs?filters=1');
    await screen.findByRole('button', { name: 'Hide filters' });
    act(() => go('/prs'));
    expect(await screen.findByRole('button', { name: 'Edit filters' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('still reads an old collapsed link as collapsed', async () => {
    renderAt('/prs?filters=0');
    expect(await screen.findByRole('button', { name: 'Edit filters' })).toHaveAttribute('aria-expanded', 'false');
  });
});
