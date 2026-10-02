/**
 * @vitest-environment jsdom
 *
 * Org and the user page keep their filters in the URL, like PR overview: a
 * shared link or a reload shows the same view. They used to keep facets in
 * localStorage and the period nowhere, so a reload reset the period and a link
 * showed the recipient their own filters. localStorage now only seeds a URL
 * that carries none of the page's filters (a first visit, a bare link).
 */
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgPage } from '../pages/Org';
import { UserDetailPage } from '../pages/UserDetail';
import { api } from '../api';
import { withFiltersOpen } from './filtersOpen';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

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
    return { data: {} };
  });
  try { window.localStorage.clear(); } catch { /* blocked */ }
});
afterEach(() => { cleanup(); });

let current: URLSearchParams = new URLSearchParams();
/** Every query string the page passed through, in order. */
let seen: string[] = [];
let goBack: () => void = () => {};
function Where() {
  const loc = useLocation();
  const navigate = useNavigate();
  current = new URLSearchParams(loc.search);
  seen.push(loc.search);
  goBack = () => navigate(-1);
  return null;
}

const renderAt = (entry: string | string[]) => {
  const entries = Array.isArray(entry) ? entry : [entry];
  seen = [];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={entries.map(withFiltersOpen)} initialIndex={entries.length - 1}>
        <Where />
        <Routes>
          <Route path="/" element={<OrgPage />} />
          <Route path="/users/:userKey" element={<UserDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const lastCall = (prefix: string) => {
  const hit = [...get.mock.calls].reverse().map(c => String(c[0])).find(u => u.startsWith(prefix));
  return new URLSearchParams((hit ?? '').split('?')[1] ?? '');
};
const pressed = (name: string) => screen.getByRole('button', { name, pressed: true });

describe('Org rollup keeps its filters in the URL', () => {
  it('writes the period and a chip into the URL', async () => {
    renderAt('/');
    fireEvent.click(await screen.findByRole('button', { name: '7d' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Item created' }));
    await waitFor(() => expect(current.get('range')).toBe('7d'));
    expect(current.get('types')?.split(',').sort()).toEqual(['item.closed', 'item.created']);
  });

  it('opens a shared link as the sender saw it', async () => {
    renderAt('/?range=90d&types=item.created&projects=acme%2Fapi');
    expect(await screen.findByRole('button', { name: '90d', pressed: true })).toBeInTheDocument();
    expect(pressed('Item created')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Item closed', pressed: false })).toBeInTheDocument();
    await waitFor(() => expect(lastCall('/v1/metrics').get('projects')).toBe('acme/api'));
  });

  it('prefers the link over what this browser used last', async () => {
    window.localStorage.setItem('agenfk-hub:org:filters', 'range=7d&projects=acme%2Fweb');
    renderAt('/?projects=acme%2Fapi');
    await waitFor(() => expect(lastCall('/v1/metrics').get('projects')).toBe('acme/api'));
    expect(current.get('projects')).toBe('acme/api');
  });

  it('starts a bare visit from what this browser used last, and shows it in the URL', async () => {
    window.localStorage.setItem('agenfk-hub:org:filters', 'range=7d&projects=acme%2Fweb');
    renderAt('/');
    expect(await screen.findByRole('button', { name: '7d', pressed: true })).toBeInTheDocument();
    await waitFor(() => expect(current.get('projects')).toBe('acme/web'));
    expect(lastCall('/v1/metrics').get('projects')).toBe('acme/web');
  });

  it('carries over what the old per-facet storage held', async () => {
    window.localStorage.setItem('agenfk-hub:org:projects', JSON.stringify(['acme/web']));
    renderAt('/');
    await waitFor(() => expect(lastCall('/v1/metrics').get('projects')).toBe('acme/web'));
  });

  it('defaults a first visit to closed items over 30 days', async () => {
    renderAt('/');
    expect(await screen.findByRole('button', { name: '30d', pressed: true })).toBeInTheDocument();
    expect(pressed('Item closed')).toBeInTheDocument();
  });

  it('keeps an explicitly cleared event-type filter cleared in the link', async () => {
    renderAt('/?types=');
    await screen.findByRole('button', { name: 'Item closed' });
    expect(screen.getByRole('button', { name: 'Item closed', pressed: false })).toBeInTheDocument();
  });

  it('remembers the choice for the next bare visit', async () => {
    const { unmount } = renderAt('/');
    fireEvent.click(await screen.findByRole('button', { name: '90d' }));
    await waitFor(() => expect(current.get('range')).toBe('90d'));
    unmount();
    renderAt('/');
    expect(await screen.findByRole('button', { name: '90d', pressed: true })).toBeInTheDocument();
  });

  it('leaves the child-hub scope in the URL alone', async () => {
    renderAt('/?childHubId=h1&range=7d');
    fireEvent.click(await screen.findByRole('button', { name: '90d' }));
    await waitFor(() => expect(current.get('range')).toBe('90d'));
    expect(current.get('childHubId')).toBe('h1');
  });
});

describe('Back restores the earlier view without rewriting it', () => {
  for (const [page, base] of [['Org', '/'], ['the user page', '/users/alice%40acme.com']] as const) {
    it(page, async () => {
      renderAt([`${base}?types=item.closed`, `${base}?types=item.closed%2Citem.created`]);
      await screen.findByRole('button', { name: 'Item created', pressed: true });
      seen = [];
      act(() => goBack());
      await screen.findByRole('button', { name: 'Item created', pressed: false });
      // The popped entry must never be overwritten with the view just left.
      expect(seen.some(q => new URLSearchParams(q).get('types')?.includes('item.created'))).toBe(false);
      expect(current.get('types')).toBe('item.closed');
    });
  }
});

describe('the user page keeps its filters in the URL', () => {
  it('never carries a remembered custom date range onto a bare visit', async () => {
    window.localStorage.setItem('agenfk-hub:user:filters', 'range=7d&from=2026-09-01&to=2026-09-10');
    renderAt('/users/bob%40acme.com?childHubId=h1');
    expect(await screen.findByRole('button', { name: '7d', pressed: true })).toBeInTheDocument();
    await waitFor(() => expect(current.get('range')).toBe('7d'));
    expect(current.get('from')).toBeNull();
    expect(current.get('to')).toBeNull();
  });

  it('does not remember a custom date range for the next bare visit', async () => {
    const { unmount } = renderAt('/users/alice%40acme.com?from=2026-09-01&to=2026-09-10');
    await waitFor(() => expect(lastCall('/v1/timeline').get('from')).toBe(new Date(2026, 8, 1).toISOString()));
    unmount();
    expect(window.localStorage.getItem('agenfk-hub:user:filters') ?? '').not.toMatch(/from=|to=/);
  });

  it('a preset period clears a custom date range', async () => {
    renderAt('/users/alice%40acme.com?from=2026-09-01&to=2026-09-10');
    fireEvent.click(await screen.findByRole('button', { name: '90d' }));
    await waitFor(() => expect(current.get('range')).toBe('90d'));
    expect(current.get('from')).toBeNull();
    expect(current.get('to')).toBeNull();
  });

  it('opens a shared link as the sender saw it', async () => {
    renderAt('/users/alice%40acme.com?range=7d&types=item.created');
    expect(await screen.findByRole('button', { name: '7d', pressed: true })).toBeInTheDocument();
    await waitFor(() => expect(lastCall('/v1/timeline').get('types')).toBe('item.created'));
  });

  it('writes a change into the URL and keeps the child-hub scope', async () => {
    renderAt('/users/alice%40acme.com?childHubId=h1');
    fireEvent.click(await screen.findByRole('button', { name: '90d' }));
    await waitFor(() => expect(current.get('range')).toBe('90d'));
    expect(current.get('childHubId')).toBe('h1');
  });

  it('restores a custom date range from the link', async () => {
    renderAt('/users/alice%40acme.com?from=2026-09-01&to=2026-09-10');
    // The bounds are the LOCAL day's first and last instants, so the UTC date
    // they print as depends on the zone (2026-08-31 at UTC+14).
    await waitFor(() => expect(lastCall('/v1/timeline').get('from')).toBe(new Date(2026, 8, 1).toISOString()));
    expect(lastCall('/v1/timeline').get('to')).toBe(new Date(2026, 8, 10, 23, 59, 59, 999).toISOString());
  });
});
