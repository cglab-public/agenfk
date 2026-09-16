/**
 * @vitest-environment jsdom
 *
 * URL-persisted facets must follow the URL, not just seed from it (BUG 02388ec7).
 *
 * useToggleSet seeded its Set from a useState lazy initializer, which runs once.
 * Every URL-persisted facet was therefore frozen at mount: React Router pops the
 * URL on Back without remounting the page, so the address bar said one thing
 * while the chips and every query still held the mount-time value — and the next
 * toggle wrote state-derived values back over the popped URL, silently undoing
 * the Back.
 *
 * The subtle half is not "sync from the URL" but "do not fight the write-back".
 * A naive sync resets state the instant a toggle makes it differ from the URL,
 * because the page writes the URL in an effect that has not run yet — undoing
 * the toggle. So the tests below pin BOTH directions.
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
const sentHub = (value: string | null) =>
  get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/v1/prs/overview'))
    .some(u => new URLSearchParams(u.split('?')[1] ?? '').get('childHubId') === value);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'));
  get.mockReset();
  try { window.localStorage.clear(); } catch { /* blocked */ }
});
afterEach(() => { cleanup(); vi.useRealTimers(); get.mockReset(); });

describe('a facet follows the URL it is persisted in', () => {
  it('re-queries when Back pops to an earlier selection', async () => {
    renderAt([`/prs?childHubId=${ALPHA}`, `/prs?childHubId=${BETA}`], 1);
    await waitFor(() => expect(sentHub(BETA)).toBe(true));

    fireEvent.click(screen.getByText('go-back'));
    await waitFor(() => expect(url().get('childHubId')).toBe(ALPHA));
    // The view has to follow, or the address bar is describing something else.
    await waitFor(() => expect(sentHub(ALPHA)).toBe(true));
  });

  it('does NOT undo a toggle while the URL write is still catching up', async () => {
    // The regression a naive sync introduces: state changes first, the page
    // writes the URL in a later effect, and a sync that fires on "state differs
    // from URL" resets the selection the user just made.
    renderAt(['/prs'], 0);
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(url().get('childHubId')).toBe(ALPHA));
    // Still selected a beat later — not reverted by the sync.
    await waitFor(() => expect(sentHub(ALPHA)).toBe(true));
    expect(url().get('childHubId')).toBe(ALPHA);
  });

  it('does not touch a storage-backed facet on another page', async () => {
    // PrOverview's facets are all URL-seeded, so this page cannot exercise the
    // storage path at all — that contract lives in useToggleSetRestore.test.tsx,
    // where a real storage-backed facet is rendered. Kept here only to say so:
    // an earlier version of this test pretended to cover it and was green
    // throughout the mount-clobber regression.
    renderAt(['/prs'], 0);
    await screen.findByText(/Child hub/i);
    expect(url().has('childHubId')).toBe(false);
  });
});
