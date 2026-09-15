/**
 * @vitest-environment jsdom
 *
 * Clicking a person out of a hub-scoped board keeps the scope (BUG b0167566).
 *
 * Org rows linked to /users/<key> carrying no filter state, and UserDetail
 * passed no childHubs to anything. So a board scoped to one child hub handed
 * you a person page aggregating them across the whole federation, with nothing
 * saying the scope had been dropped — the same "two panels disagree" defect
 * CGLAB-184 fixed one level up.
 */
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UserDetailPage } from '../pages/UserDetail';
import { api } from '../api';
import { OrgPage } from '../pages/Org';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const ALPHA = '9f1c7e2a-0000-4000-8000-000000000001';
const BETA = '9f1c7e2a-0000-4000-8000-000000000002';

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/child-hubs')) {
      return { data: { childHubs: [{ id: ALPHA, name: 'alpha', detached: false, events: 9 }], hasLocal: true } };
    }
    if (url.startsWith('/v1/event-types')) return { data: { types: ['item.closed'] } };
    if (url.startsWith('/v1/projects')) return { data: { projects: ['acme/api'] } };
    if (url.startsWith('/v1/item-types')) return { data: { itemTypes: ['TASK'], counts: { TASK: 1 } } };
    if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: [] } };
    if (url.startsWith('/v1/users')) {
      return { data: [{ user_key: 'alice@acme.com', last_seen: '2026-08-14T00:00:00Z', events_count: 3 }] };
    }
    if (url.startsWith('/v1/timeline')) return { data: { events: [] } };
    if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
    return { data: {} };
  });
  try { window.localStorage.clear(); } catch { /* blocked */ }
});
afterEach(() => { cleanup(); get.mockReset(); });

const renderAt = (entry: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes><Route path="/users/:userKey" element={<UserDetailPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const sent = (prefix: string, value: string) =>
  get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith(prefix))
    .some(u => new URLSearchParams(u.split('?')[1] ?? '').get('childHubId') === value);

describe('UserDetail honours a child hub arriving in the link', () => {
  for (const [label, endpoint] of [
    ['the metrics tiles', '/v1/metrics'],
    ['the activity timeline', '/v1/histogram'],
    ['the event list', '/v1/timeline'],
    ['the item-type chip counts', '/v1/item-types'],
  ] as Array<[string, string]>) {
    it(`scopes ${label}`, async () => {
      renderAt(`/users/alice%40acme.com?childHubId=${ALPHA}`);
      await waitFor(() => expect(sent(endpoint, ALPHA)).toBe(true));
    });
  }

  it('is reachable: the Org user link carries the scope it was filtered by', async () => {
    // The other half of the fix — UserDetail can honour a hub only if the link
    // that got you there names one. Asserted on the rendered href, not on the
    // source text.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/org?childHubId=${ALPHA}`]}>
          <OrgPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const link = await screen.findByRole('link', { name: /alice@acme\.com/i });
    expect(link.getAttribute('href')).toContain(`childHubId=${ALPHA}`);
  });

  it('scopes the chip universes, so no chip offers another hub\'s data', async () => {
    renderAt(`/users/alice%40acme.com?childHubId=${ALPHA}`);
    await waitFor(() => expect(sent('/v1/event-types', ALPHA)).toBe(true));
    await waitFor(() => expect(sent('/v1/projects', ALPHA)).toBe(true));
  });

  it('keeps the scope in the timeline CACHE key, not only the request', async () => {
    // Two hubs sharing one cache entry means this page paints the other hub's
    // events until a refetch lands — or forever, if that refetch errors.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const mount = (hub: string) => render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/users/alice%40acme.com?childHubId=${hub}`]}>
          <Routes><Route path="/users/:userKey" element={<UserDetailPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    mount(ALPHA);
    await waitFor(() => expect(sent('/v1/timeline', ALPHA)).toBe(true));
    cleanup();
    mount(BETA);
    await waitFor(() => expect(sent('/v1/timeline', BETA)).toBe(true));
    const keys = qc.getQueryCache().getAll()
      .filter(q => Array.isArray(q.queryKey) && q.queryKey[0] === 'timeline');
    expect(keys.length).toBeGreaterThan(1);
  });

  it('carries the scope back to the org board', async () => {
    renderAt(`/users/alice%40acme.com?childHubId=${ALPHA}`);
    const back = await screen.findByRole('link', { name: /back to org/i });
    expect(back.getAttribute('href')).toContain(`childHubId=${ALPHA}`);
  });

  it('sends nothing when the link carries no hub, so a standalone hub is unchanged', async () => {
    renderAt('/users/alice%40acme.com');
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(0));
    const all = get.mock.calls.map(c => String(c[0]));
    for (const u of all) {
      expect(new URLSearchParams(u.split('?')[1] ?? '').has('childHubId')).toBe(false);
    }
  });
});

// ── Findings from the adversarial review of this card ────────────────────────

describe('the page SAYS which hub it is showing', () => {
  // The card's own framing is "nothing saying the scope was dropped". Scoping
  // the data without naming the scope is the same defect wearing the other
  // face, and it contradicts the invariant this feature wrote down twice in
  // hooks/useChildHubs.ts: a filter must never be applied invisibly.
  it('names the hub the link scoped it to', async () => {
    renderAt(`/users/alice%40acme.com?childHubId=${ALPHA}`);
    // The hub's NAME, not its uuid — the same label the Org facet shows.
    expect(await screen.findByText('alpha')).toBeInTheDocument();
  });

  it('shows the raw id when the hub is unknown, rather than nothing', async () => {
    // A detached or mistyped id matches no rows, so every tile reads zero and
    // the event list says "no events match the current filters" — pointing at
    // a Filters panel that shows no filter explaining it. The reader concludes
    // the person did nothing.
    const GONE = '9f1c7e2a-0000-4000-8000-00000000dead';
    renderAt(`/users/alice%40acme.com?childHubId=${GONE}`);
    expect(await screen.findByText(GONE)).toBeInTheDocument();
  });

  it('says nothing at all when the link carries no hub', async () => {
    renderAt('/users/alice%40acme.com');
    await screen.findByText('alice@acme.com');
    expect(screen.queryByText('alpha')).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing/i)).not.toBeInTheDocument();
  });
});

describe('the click-through itself', () => {
  it('carries the scope from a filtered Org board into the person page', async () => {
    // Org and UserDetail were only ever rendered in separate routers, so a
    // route-level regression — a <Link> swapped for navigate('/users/'+k),
    // which drops the search — passed both halves while the journey broke.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/?childHubId=${ALPHA}`]}>
          <Routes>
            <Route path="/" element={<OrgPage />} />
            <Route path="/users/:userKey" element={<UserDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('link', { name: /alice@acme\.com/i }));
    await screen.findByText('alice@acme.com');
    await waitFor(() => expect(sent('/v1/timeline', ALPHA)).toBe(true));
  });
});
