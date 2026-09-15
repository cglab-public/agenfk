/**
 * @vitest-environment jsdom
 *
 * Child hub filter on the PR Overview and Org pages (CGLAB-184, task 4).
 *
 * The server half already partitions every query by originating hub. This is
 * the half a person can see.
 *
 * The acceptance criterion that is NOT an afterthought: a hub with no children
 * must look exactly as it did before. Federation is opt-in, and the great
 * majority of hubs are standalone — they must not grow a filter that can only
 * ever have one value. So "the facet is absent" gets as many tests as "the
 * facet works".
 *
 * `local` is the reserved id for this hub's own rows; a UUID selects a child;
 * an absent param means every hub. That is the server's contract, and the URL
 * uses the same spelling (?childHubId=) so there is no translation to get wrong.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrOverviewPage } from '../pages/PrOverview';
import { OrgPage } from '../pages/Org';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const ALPHA = '9f1c7e2a-0000-4000-8000-000000000001';
const BETA = '9f1c7e2a-0000-4000-8000-000000000002';

/** A parent hub with two enrolled children that both carry data. */
const FEDERATED = {
  childHubs: [
    { id: ALPHA, name: 'alpha', detached: false, events: 12 },
    { id: BETA, name: 'beta', detached: false, events: 3 },
  ],
  hasLocal: true,
};
/** What every standalone hub in the world returns. */
const STANDALONE = { childHubs: [], hasLocal: true };

const OVERVIEW = {
  period: { from: '2026-08-10T00:00:00.000Z', to: '2026-08-22T23:59:59.999Z' },
  buckets: ['xs', 's', 'm', 'l', 'xl'],
  totals: { prs: 1, sizePoints: 4, developers: 1, medianBucket: 'xs' },
  resized: { count: 0, grew: 0, shrank: 0 },
  byDay: [],
  byDeveloper: [{ user_key: 'alice@acme.com', prs: 1, sizePoints: 4, sizes: { xs: 1, s: 0, m: 0, l: 0, xl: 0 }, daily: {} }],
  byModel: [{ model: 'claude-opus-5', harnesses: [], prs: 1, sizePoints: 4, sizes: { xs: 1, s: 0, m: 0, l: 0, xl: 0 } }],
  prs: [],
  previous: null,
};

function mockApi(facet: typeof FEDERATED) {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/child-hubs')) return { data: facet };
    if (url.startsWith('/v1/projects')) return { data: { projects: ['acme/api'] } };
    if (url.startsWith('/v1/event-types')) return { data: { types: ['item.closed'] } };
    if (url.startsWith('/v1/item-types')) return { data: { itemTypes: ['TASK'], counts: { TASK: 1 } } };
    if (url.startsWith('/v1/users')) return { data: [{ user_key: 'alice@acme.com', last_seen: '2026-08-14T00:00:00Z', events_count: 3 }] };
    if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: [] } };
    if (url.startsWith('/v1/prs/overview')) return { data: OVERVIEW };
    return { data: {} };
  });
}

function UrlProbe() {
  const [sp] = useSearchParams();
  return <span data-testid="url-probe">{sp.toString()}</span>;
}

const renderPage = (Page: React.ComponentType, entry: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Page />
        <UrlProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const urlNow = () => new URLSearchParams(screen.getByTestId('url-probe').textContent ?? '');
const callsTo = (prefix: string) => get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith(prefix));
/** Did any request to `prefix` carry this childHubId value? */
const sentChildHub = (prefix: string, value: string) =>
  callsTo(prefix).some(u => new URLSearchParams(u.split('?')[1] ?? '').get('childHubId') === value);

const FIXTURE_NOW = new Date('2026-08-14T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FIXTURE_NOW);
  get.mockReset();
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
});
afterEach(() => { cleanup(); vi.useRealTimers(); get.mockReset(); });

describe('PR Overview — child hub facet', () => {
  it('is absent entirely on a hub with no children', async () => {
    mockApi(STANDALONE);
    renderPage(PrOverviewPage, '/prs');
    // Wait for the page to settle so this is "never appeared", not "not yet".
    await screen.findByText(/Project \(git remote\)/i);
    expect(screen.queryByText(/Child hub/i)).not.toBeInTheDocument();
  });

  it('offers this hub and each child once there are children', async () => {
    mockApi(FEDERATED);
    renderPage(PrOverviewPage, '/prs');
    const facet = await screen.findByText(/Child hub/i);
    expect(facet).toBeInTheDocument();
    // Named, not raw UUIDs — the id is a machine detail.
    expect(await screen.findByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(screen.getByText(/This hub/i)).toBeInTheDocument();
  });

  it('writes the selection to the URL under the name the server reads', async () => {
    mockApi(FEDERATED);
    renderPage(PrOverviewPage, '/prs');
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(urlNow().get('childHubId')).toBe(ALPHA));
  });

  it('sends the selection to the overview query', async () => {
    mockApi(FEDERATED);
    renderPage(PrOverviewPage, '/prs');
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(sentChildHub('/v1/prs/overview', ALPHA)).toBe(true));
  });

  it('restores a shared link, so the view someone sent is the view you get', async () => {
    mockApi(FEDERATED);
    renderPage(PrOverviewPage, `/prs?childHubId=${BETA}`);
    await waitFor(() => expect(sentChildHub('/v1/prs/overview', BETA)).toBe(true));
  });

  it("selects this hub's own rows with the reserved 'local' id", async () => {
    mockApi(FEDERATED);
    renderPage(PrOverviewPage, '/prs');
    fireEvent.click(await screen.findByText(/This hub/i));
    await waitFor(() => expect(urlNow().get('childHubId')).toBe('local'));
  });

  it('sends nothing at all when no hub is selected — absent means every hub', async () => {
    mockApi(FEDERATED);
    renderPage(PrOverviewPage, '/prs');
    await screen.findByText(/Child hub/i);
    await waitFor(() => expect(callsTo('/v1/prs/overview').length).toBeGreaterThan(0));
    for (const u of callsTo('/v1/prs/overview')) {
      expect(new URLSearchParams(u.split('?')[1] ?? '').has('childHubId')).toBe(false);
    }
  });
});

describe('Org — child hub facet', () => {
  it('is absent entirely on a hub with no children', async () => {
    mockApi(STANDALONE);
    renderPage(OrgPage, '/org');
    await screen.findByText(/Project \(git remote\)/i);
    expect(screen.queryByText(/Child hub/i)).not.toBeInTheDocument();
  });

  it('appears and reaches the metrics query', async () => {
    mockApi(FEDERATED);
    renderPage(OrgPage, '/org');
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(sentChildHub('/v1/metrics', ALPHA)).toBe(true));
  });

  it('reaches the users query too, so the rollup and the people list agree', async () => {
    mockApi(FEDERATED);
    renderPage(OrgPage, '/org');
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(sentChildHub('/v1/users', ALPHA)).toBe(true));
  });

  it('is URL-persisted, unlike its localStorage siblings on this page', async () => {
    // Deliberate divergence from the other Org facets: a federated view is worth
    // sending to someone, and localStorage cannot be shared.
    mockApi(FEDERATED);
    renderPage(OrgPage, '/org');
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(urlNow().get('childHubId')).toBe(ALPHA));
  });

  it('restores a shared link', async () => {
    mockApi(FEDERATED);
    renderPage(OrgPage, `/org?childHubId=${BETA}`);
    await waitFor(() => expect(sentChildHub('/v1/metrics', BETA)).toBe(true));
  });
});
