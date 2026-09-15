/**
 * @vitest-environment jsdom
 *
 * PR Overview's NON-facet controls must follow the URL too (BUG 8e40e463).
 *
 * 02388ec7 taught the chip facets to follow the query string. The six scalar
 * controls — range, gran, from, to, filters and pr — were left as plain
 * useState seeded once at mount, and they are worse than merely frozen: React
 * Router recreates setSearchParams on every location change, so the page's
 * write-back effect re-runs on a pop and rewrites the WHOLE query string from
 * mount-time state. A Back that changed a facet and the range together kept the
 * facet and silently deleted the range, replacing it with the value the page
 * had been mounted with.
 *
 * Both directions are pinned, as in facetUrlSync.test.tsx: a pop must reach the
 * controls, and the sync must not fight the write-back by undoing a change the
 * user just made.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, useNavigate, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrOverviewPage } from '../pages/PrOverview';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const ALPHA = '9f1c7e2a-0000-4000-8000-000000000001';
const BETA = '9f1c7e2a-0000-4000-8000-000000000002';

const FACET = {
  childHubs: [
    { id: ALPHA, name: 'alpha', detached: false, events: 12 },
    { id: BETA, name: 'beta', detached: false, events: 3 },
  ],
  hasLocal: true,
};

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

function Probe() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  return (
    <>
      <span data-testid="url">{sp.toString()}</span>
      <button onClick={() => nav(-1)}>go-back</button>
    </>
  );
}

const renderAt = (entries: string[], index: number) => {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/child-hubs')) return { data: FACET };
    if (url.startsWith('/v1/projects')) return { data: { projects: ['acme/api'] } };
    return { data: OVERVIEW };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={entries} initialIndex={index}>
        <PrOverviewPage />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const url = () => new URLSearchParams(screen.getByTestId('url').textContent ?? '');
/** The query strings the overview endpoint was actually asked for. */
const overviewQueries = () =>
  get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/v1/prs/overview'))
    .map(u => new URLSearchParams(u.split('?')[1] ?? ''));

beforeEach(() => {
  // The window is clock-relative, so the clock is pinned or the assertions rot.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'));
  get.mockReset();
  try { window.localStorage.clear(); } catch { /* blocked */ }
});
afterEach(() => { cleanup(); vi.useRealTimers(); get.mockReset(); });

describe('Back reaches the scalar controls, not just the chips', () => {
  it('keeps the popped range when a facet changed in the same step', async () => {
    // The measured failure: the hub followed and range=90d was DELETED and
    // replaced with the mount-time 7d.
    renderAt([`/prs?childHubId=${ALPHA}&range=90d`, `/prs?childHubId=${BETA}&range=7d`], 1);
    await waitFor(() => expect(url().get('range')).toBe('7d'));

    fireEvent.click(screen.getByText('go-back'));
    await waitFor(() => expect(url().get('childHubId')).toBe(ALPHA));
    expect(url().get('range')).toBe('90d');
  });

  it('re-queries the popped window, so the charts match the address bar', async () => {
    renderAt(['/prs?range=7d', '/prs?range=90d'], 1);
    await waitFor(() => expect(overviewQueries().length).toBeGreaterThan(0));
    const ninety = overviewQueries().at(-1)!.get('from');

    fireEvent.click(screen.getByText('go-back'));
    await waitFor(() => expect(url().get('range')).toBe('7d'));
    await waitFor(() => {
      const from = overviewQueries().at(-1)!.get('from');
      expect(from).not.toBe(ninety);
    });
  });

  it('keeps a popped granularity', async () => {
    renderAt(['/prs?gran=monthly', '/prs?gran=weekly'], 1);
    await waitFor(() => expect(url().get('gran')).toBe('weekly'));
    fireEvent.click(screen.getByText('go-back'));
    await waitFor(() => expect(url().get('gran')).toBe('monthly'));
  });

  it('keeps a popped explicit date range', async () => {
    renderAt(['/prs?from=2026-01-01&to=2026-01-31', '/prs?from=2026-03-01&to=2026-03-31'], 1);
    await waitFor(() => expect(url().get('from')).toBe('2026-03-01'));
    fireEvent.click(screen.getByText('go-back'));
    await waitFor(() => expect(url().get('from')).toBe('2026-01-01'));
    expect(url().get('to')).toBe('2026-01-31');
  });

  it('keeps a popped collapsed-filters state', async () => {
    renderAt(['/prs?filters=0', '/prs'], 1);
    await waitFor(() => expect(url().has('filters')).toBe(false));
    fireEvent.click(screen.getByText('go-back'));
    await waitFor(() => expect(url().get('filters')).toBe('0'));
  });

  it('keeps a popped PR-number search', async () => {
    renderAt(['/prs?pr=57', '/prs?pr=99'], 1);
    await waitFor(() => expect(url().get('pr')).toBe('99'));
    fireEvent.click(screen.getByText('go-back'));
    await waitFor(() => expect(url().get('pr')).toBe('57'));
  });

  it('does NOT undo a range change while the URL write is still catching up', async () => {
    // The regression a naive sync introduces, the same trap useToggleSet had:
    // state changes first and the page writes the URL in a later effect, so a
    // sync that fires on "state differs from URL" reverts the user's click.
    renderAt(['/prs'], 0);
    fireEvent.click(await screen.findByText('7d'));
    await waitFor(() => expect(url().get('range')).toBe('7d'));
    await new Promise(r => setTimeout(r, 20));
    expect(url().get('range')).toBe('7d');
  });
});
