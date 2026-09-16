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
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
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

function mockApi(facet: typeof FEDERATED | 'fail') {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/child-hubs')) {
      if (facet === 'fail') throw new Error('boom');
      return { data: facet };
    }
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

describe('every view on the page honours the selection', () => {
  it('Org: the activity timeline is filtered, not just the tiles above it', async () => {
    // The card names the timeline explicitly. Tiles narrowed to one hub above a
    // timeline plotting the whole federation is worse than no filter: the two
    // disagree and nothing says which is which.
    mockApi(FEDERATED);
    renderPage(OrgPage, '/org');
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(sentChildHub('/v1/histogram', ALPHA)).toBe(true));
  });

  it('Org: the item-type chip counts are filtered', async () => {
    mockApi(FEDERATED);
    renderPage(OrgPage, '/org');
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(sentChildHub('/v1/item-types', ALPHA)).toBe(true));
  });

  it('Org: the project list offers only the selected hub\'s repos', async () => {
    mockApi(FEDERATED);
    renderPage(OrgPage, '/org');
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(sentChildHub('/v1/projects', ALPHA)).toBe(true));
  });

  it('Org: the event-type chips come from the selected hub', async () => {
    mockApi(FEDERATED);
    renderPage(OrgPage, '/org');
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(sentChildHub('/v1/event-types', ALPHA)).toBe(true));
  });

  it('PR Overview: the project facet offers only the selected hub\'s repos', async () => {
    // Same argument the commit makes for the model and developer lists: a facet
    // offering names from hubs the board is not showing is a dead end.
    mockApi(FEDERATED);
    renderPage(PrOverviewPage, '/prs');
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(sentChildHub('/v1/projects', ALPHA)).toBe(true));
  });

  it('PR Overview: a PR-number search stays scoped to the selected hub', async () => {
    // #57 exists in every repo AND on every hub; dropping the hub here would
    // answer one search with two unrelated PRs that merely share a number.
    mockApi(FEDERATED);
    renderPage(PrOverviewPage, `/prs?childHubId=${ALPHA}&pr=57`);
    await waitFor(() => {
      const searched = callsTo('/v1/prs/overview')
        .filter(u => new URLSearchParams(u.split('?')[1] ?? '').get('pr') === '57');
      expect(searched.length).toBeGreaterThan(0);
      expect(searched.every(u => new URLSearchParams(u.split('?')[1] ?? '').get('childHubId') === ALPHA)).toBe(true);
    });
  });
});

describe('the facet cannot hide a filter that is still applied', () => {
  it('stays visible when /v1/child-hubs fails but a selection is live', async () => {
    // Otherwise a transient 500 on a secondary endpoint leaves the board showing
    // one hub's data with no control to clear it and nothing saying it is filtered.
    mockApi('fail');
    renderPage(PrOverviewPage, `/prs?childHubId=${ALPHA}`);
    expect(await screen.findByText(/Child hub/i)).toBeInTheDocument();
  });

  it('still hides the facet when the request fails and nothing is selected', async () => {
    // The standalone guarantee must survive the error path too: a hub with no
    // children must not grow a facet just because a request failed.
    mockApi('fail');
    renderPage(PrOverviewPage, '/prs');
    await screen.findByText(/Project \(git remote\)/i);
    expect(screen.queryByText(/Child hub/i)).not.toBeInTheDocument();
  });

  it('asks the server to keep the selected hub listed', async () => {
    // The server re-adds a hub named in ?childHubId= even when it has no events
    // in the window. Not sending it makes that branch dead and renders the chip
    // as a raw UUID.
    mockApi(FEDERATED);
    renderPage(PrOverviewPage, `/prs?childHubId=${ALPHA}`);
    await waitFor(() => expect(sentChildHub('/v1/child-hubs', ALPHA)).toBe(true));
  });
});

describe('the collapsed filter bar tells the truth', () => {
  it('counts the child hub among the active filters', async () => {
    // FilterAccordion's contract: a facet that is live but uncounted is how a
    // collapsed bar starts lying about what is filtering the numbers.
    mockApi(FEDERATED);
    renderPage(PrOverviewPage, `/prs?childHubId=${ALPHA}&filters=0`);
    expect(await screen.findByText(/1 active/i)).toBeInTheDocument();
  });

  it('names it in the collapsed summary, not just in the count', async () => {
    // The summary chip, which reads "1 child hub" — distinct from the facet's
    // own "Child hub" label, which is still in the DOM while collapsed.
    mockApi(FEDERATED);
    renderPage(PrOverviewPage, `/prs?childHubId=${ALPHA}&filters=0`);
    expect(await screen.findByText(/1 child hub$/i)).toBeInTheDocument();
  });
});

describe('contract details', () => {
  it("offers no 'This hub' option when the hub has no rows of its own", async () => {
    // A pure relay parent: everything it shows came from a child.
    mockApi({ ...FEDERATED, hasLocal: false });
    renderPage(PrOverviewPage, '/prs');
    await screen.findByText('alpha');
    expect(screen.queryByText(/This hub/i)).not.toBeInTheDocument();
  });

  it('keeps the names on screen while a selection change is in flight', async () => {
    // The selection is part of the query key, so every toggle is a COLD fetch.
    // Without placeholderData the response is undefined until it lands and the
    // picker loses its labels — chips falling back to raw UUIDs — which is the
    // exact symptom this facet was changed to stop showing.
    let gate: (() => void) | null = null;
    let facetCalls = 0;
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/child-hubs')) {
        facetCalls += 1;
        // Answer the first request; hold every later one open.
        if (facetCalls > 1) await new Promise<void>(r => { gate = r; });
        return { data: FEDERATED };
      }
      if (url.startsWith('/v1/projects')) return { data: { projects: ['acme/api'] } };
      if (url.startsWith('/v1/prs/overview')) return { data: OVERVIEW };
      return { data: {} };
    });
    renderPage(PrOverviewPage, '/prs');
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(facetCalls).toBeGreaterThan(1));

    // Mid-flight: still named, still a facet.
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.queryByText(ALPHA)).not.toBeInTheDocument();
    expect(screen.getByText(/Child hub/i)).toBeInTheDocument();
    gate?.();
  });

  it('does not unmount the facet while clearing the last selection', async () => {
    // Same cause, worse symptom: clearing from a shared link refetches under a
    // key never fetched before, so both the hub list AND the selection are
    // momentarily empty — and the whole control disappears and comes back.
    let gate: (() => void) | null = null;
    let facetCalls = 0;
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/child-hubs')) {
        facetCalls += 1;
        if (facetCalls > 1) await new Promise<void>(r => { gate = r; });
        return { data: FEDERATED };
      }
      if (url.startsWith('/v1/projects')) return { data: { projects: ['acme/api'] } };
      if (url.startsWith('/v1/prs/overview')) return { data: OVERVIEW };
      return { data: {} };
    });
    renderPage(PrOverviewPage, `/prs?childHubId=${ALPHA}`);
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(facetCalls).toBeGreaterThan(1));
    expect(screen.getByText(/Child hub/i)).toBeInTheDocument();
    gate?.();
  });

  it('says when a hub has been detached, rather than listing it as live', async () => {
    // A detached hub keeps its events, so it keeps its place in the picker —
    // but offering it indistinguishably from a live one invites the reader to
    // think data is still arriving from it.
    mockApi({
      childHubs: [
        { id: ALPHA, name: 'alpha', detached: true, events: 12 },
        { id: BETA, name: 'beta', detached: false, events: 3 },
      ],
      hasLocal: true,
    });
    renderPage(PrOverviewPage, '/prs');
    expect(await screen.findByText(/alpha \(detached\)/i)).toBeInTheDocument();
    expect(screen.getByText(/^beta$/)).toBeInTheDocument();
  });

  it('keeps a selected hub visible and clearable even when the server omits it', async () => {
    // A link naming a hub the response does not mention — removed since, or the
    // request failed. The filter is applied, so the control to undo it has to
    // be there.
    mockApi({ childHubs: [{ id: BETA, name: 'beta', detached: false, events: 3 }], hasLocal: true });
    renderPage(PrOverviewPage, `/prs?childHubId=${ALPHA}`);
    await screen.findByText(/Child hub/i);
    expect(screen.getByText(ALPHA)).toBeInTheDocument();
    fireEvent.click(screen.getByText(ALPHA));
    await waitFor(() => expect(urlNow().has('childHubId')).toBe(false));
  });

  it('shows the facet on a standalone hub only when a link put a filter on it', async () => {
    // The acceptance criterion is "no facet on a hub with no children" — but an
    // APPLIED filter outranks it, or the filter is invisible and permanent.
    mockApi(STANDALONE);
    renderPage(PrOverviewPage, `/prs?childHubId=${ALPHA}`);
    expect(await screen.findByText(/Child hub/i)).toBeInTheDocument();
  });

  it('clears childHubId out of the URL when the selection is cleared', async () => {
    mockApi(FEDERATED);
    renderPage(OrgPage, `/org?childHubId=${ALPHA}`);
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(urlNow().has('childHubId')).toBe(false));
  });

  it('does not persist the Org selection to localStorage', async () => {
    // The deliberate divergence from Org's other facets. If it also wrote to
    // storage, a stale selection would outlive the link it came from.
    mockApi(FEDERATED);
    renderPage(OrgPage, '/org');
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(urlNow().get('childHubId')).toBe(ALPHA));
    const stored = Object.keys(window.localStorage)
      .filter(k => (window.localStorage.getItem(k) ?? '').includes(ALPHA));
    expect(stored).toEqual([]);
  });
});
