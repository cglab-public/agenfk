/**
 * @vitest-environment jsdom
 *
 * The three dashboards before their data arrives, and when it does not. They
 * used to render zeros while loading ("0 reporting", "0 shown", tiles at 0),
 * and a failed query looked exactly like an empty fleet.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgPage } from '../pages/Org';
import { UserDetailPage } from '../pages/UserDetail';
import { PrOverviewPage } from '../pages/PrOverview';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const NEVER = () => new Promise(() => {});
const FAIL = () => Promise.reject({ response: { data: { error: 'Database unavailable' } } });

const OVERVIEW = {
  period: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z' },
  buckets: ['xs', 's', 'm', 'l', 'xl'],
  totals: { prs: 0, sizePoints: 0, developers: 0, medianBucket: null },
  resized: { count: 0, grew: 0, shrank: 0 },
  byDay: [], byDeveloper: [], byModel: [], prs: [], previous: null,
};

/** Every endpoint answers normally unless `over` says otherwise for its prefix. */
const serve = (over: Record<string, () => Promise<unknown>> = {}) => {
  get.mockImplementation((url: string) => {
    const hit = Object.keys(over).find(p => url.startsWith(p));
    if (hit) return over[hit]().then(data => ({ data }));
    if (url.startsWith('/v1/event-types')) return Promise.resolve({ data: { types: ['item.closed'] } });
    if (url.startsWith('/v1/projects')) return Promise.resolve({ data: { projects: [] } });
    if (url.startsWith('/v1/item-types')) return Promise.resolve({ data: { itemTypes: [], counts: {} } });
    if (url.startsWith('/v1/metrics')) return Promise.resolve({ data: { bucket: 'day', series: [] } });
    if (url.startsWith('/v1/users')) return Promise.resolve({ data: [] });
    if (url.startsWith('/v1/timeline')) return Promise.resolve({ data: { events: [] } });
    if (url.startsWith('/v1/histogram')) return Promise.resolve({ data: { bucket: 'day', buckets: [] } });
    if (url.startsWith('/v1/prs/overview')) return Promise.resolve({ data: OVERVIEW });
    return Promise.resolve({ data: {} });
  });
};

const renderAt = (entry: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/" element={<OrgPage />} />
          <Route path="/prs" element={<PrOverviewPage />} />
          <Route path="/users/:userKey" element={<UserDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const calls = (prefix: string) => get.mock.calls.filter(c => String(c[0]).startsWith(prefix)).length;

beforeEach(() => { get.mockReset(); try { window.localStorage.clear(); } catch { /* blocked */ } });
afterEach(() => { cleanup(); });

describe('Org rollup', () => {
  it('shows the tiles as loading, not as zeros', async () => {
    serve({ '/v1/metrics': NEVER });
    renderAt('/');
    expect(await screen.findByRole('status', { name: 'Loading activity totals' })).toBeInTheDocument();
    expect(screen.queryByText('Items closed')).not.toBeInTheDocument();
  });

  it('says the totals failed and retries them', async () => {
    serve({ '/v1/metrics': FAIL });
    renderAt('/');
    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    const before = calls('/v1/metrics');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls('/v1/metrics')).toBeGreaterThan(before));
  });

  it('does not claim "0 reporting" before the users have loaded', async () => {
    serve({ '/v1/users': NEVER });
    renderAt('/');
    expect(await screen.findByRole('status', { name: 'Loading users' })).toBeInTheDocument();
    expect(screen.queryByText(/reporting/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No users match/)).not.toBeInTheDocument();
  });

  it('tells a failed users query apart from an empty one', async () => {
    serve({ '/v1/users': FAIL });
    renderAt('/');
    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/No users match/)).not.toBeInTheDocument();
  });

  it('still says so when no users match', async () => {
    serve();
    renderAt('/');
    expect(await screen.findByText(/No users match the current filters/)).toBeInTheDocument();
    // The default selection (item.closed) scopes the count, and the label says so.
    expect(screen.getByText('0 with matching events')).toBeInTheDocument();
  });
});

describe('Activity timeline (Org and user page)', () => {
  it('does not claim "0 events" before the histogram has loaded', async () => {
    serve({ '/v1/histogram': NEVER });
    renderAt('/');
    expect(await screen.findByRole('status', { name: 'Loading activity timeline' })).toBeInTheDocument();
    expect(screen.queryByText(/\b0 events\b/)).not.toBeInTheDocument();
  });

  it('says the histogram failed instead of drawing an empty chart', async () => {
    serve({ '/v1/histogram': FAIL });
    renderAt('/users/alice%40acme.com');
    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/\b0 events\b/)).not.toBeInTheDocument();
  });

  it('shows the count once the histogram answers', async () => {
    serve();
    renderAt('/');
    expect(await screen.findByText(/0 events · last 30 days/)).toBeInTheDocument();
  });
});

describe('User page', () => {
  it('does not claim "0 shown" before the events have loaded', async () => {
    serve({ '/v1/timeline': NEVER });
    renderAt('/users/alice%40acme.com');
    expect(await screen.findByRole('status', { name: 'Loading events' })).toBeInTheDocument();
    expect(screen.queryByText(/0 shown/)).not.toBeInTheDocument();
  });

  it('says the events failed and retries them', async () => {
    serve({ '/v1/timeline': FAIL });
    renderAt('/users/alice%40acme.com');
    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/No events match/)).not.toBeInTheDocument();
    const before = calls('/v1/timeline');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls('/v1/timeline')).toBeGreaterThan(before));
  });

  it('shows the tiles as loading, not as zeros', async () => {
    serve({ '/v1/metrics': NEVER });
    renderAt('/users/alice%40acme.com');
    expect(await screen.findByRole('status', { name: 'Loading activity totals' })).toBeInTheDocument();
    expect(screen.queryByText('Items closed')).not.toBeInTheDocument();
  });
});

describe('PR overview', () => {
  it("shows the hub's reason and a Retry when the overview fails", async () => {
    serve({ '/v1/prs/overview': FAIL });
    renderAt('/prs');
    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable');
    const before = calls('/v1/prs/overview');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls('/v1/prs/overview')).toBeGreaterThan(before));
  });
});
