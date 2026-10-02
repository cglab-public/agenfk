/**
 * @vitest-environment jsdom
 *
 * People by name on the dashboards. The hub knows names (Installations shows
 * "Carol Diaz") but Org's Users list, PR overview's developer rows and facet,
 * and the user page heading showed the email in monospace, with initials cut
 * from the email. The name now leads, in sans, with the email as secondary;
 * someone the hub has no name for still shows their key.
 */
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgPage } from '../pages/Org';
import { UserDetailPage } from '../pages/UserDetail';
import { PrOverviewPage } from '../pages/PrOverview';
import { initialsOf } from '../components/PersonName';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const NAMES = { 'carol@acme.com': 'Carol Diaz' };
let NAMES_OVERRIDE: Record<string, string> | null = null;
const OVERVIEW = {
  period: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z' },
  buckets: ['xs', 's', 'm', 'l', 'xl'],
  totals: { prs: 2, sizePoints: 4, developers: 2, medianBucket: 'xs' },
  resized: { count: 0, grew: 0, shrank: 0 },
  byDay: [],
  byDeveloper: [
    { user_key: 'carol@acme.com', prs: 1, sizePoints: 2, sizes: { xs: 1, s: 0, m: 0, l: 0, xl: 0 }, daily: { '2026-09-10': 1 } },
    { user_key: 'dan@acme.com', prs: 1, sizePoints: 2, sizes: { xs: 1, s: 0, m: 0, l: 0, xl: 0 }, daily: { '2026-09-10': 1 } },
  ],
  byModel: [],
  previous: { prs: 1, sizePoints: 4 },
};

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/people/names')) return { data: { names: NAMES_OVERRIDE ?? NAMES } };
    if (url.startsWith('/v1/event-types')) return { data: { types: ['item.closed'] } };
    if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
    if (url.startsWith('/v1/item-types')) return { data: { itemTypes: [], counts: {} } };
    if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: [] } };
    if (url.startsWith('/v1/users')) return { data: [
      { user_key: 'carol@acme.com', last_seen: '2026-09-29T00:00:00Z', events_count: 3 },
      { user_key: 'dan@acme.com', last_seen: '2026-09-28T00:00:00Z', events_count: 1 },
    ] };
    if (url.startsWith('/v1/timeline')) return { data: { events: [] } };
    if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
    if (url.startsWith('/v1/prs/overview')) return { data: OVERVIEW };
    return { data: {} };
  });
  try { window.localStorage.clear(); } catch { /* blocked */ }
});
afterEach(() => { cleanup(); NAMES_OVERRIDE = null; });

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

describe('initialsOf', () => {
  it('takes the first letters of a name', () => {
    expect(initialsOf('Carol Diaz', 'carol@acme.com')).toBe('CD');
    expect(initialsOf('Madonna', 'm@acme.com')).toBe('M');
  });
  it('falls back to the key without a name', () => {
    expect(initialsOf(undefined, 'dan@acme.com')).toBe('DA');
  });
});

describe('Org Users list', () => {
  it('leads with the name and keeps the email as secondary', async () => {
    renderAt('/');
    const link = (await screen.findByText('Carol Diaz')).closest('a')!;
    expect(within(link).getByText('carol@acme.com')).toBeInTheDocument();
    expect(within(link).getByText('CD')).toBeInTheDocument();
  });

  it('shows the key for someone the hub has no name for', async () => {
    renderAt('/');
    const link = (await screen.findByText('dan@acme.com')).closest('a')!;
    expect(within(link).getByText('DA')).toBeInTheDocument();
  });
});

describe('user page', () => {
  it('heads the page with the name, and the email under it', async () => {
    renderAt('/users/carol%40acme.com');
    expect(await screen.findByRole('heading', { level: 1, name: 'Carol Diaz' })).toBeInTheDocument();
    expect(screen.getByText('carol@acme.com')).toBeInTheDocument();
  });

  it('heads the page with the key when there is no name', async () => {
    renderAt('/users/dan%40acme.com');
    expect(await screen.findByRole('heading', { level: 1, name: 'dan@acme.com' })).toBeInTheDocument();
  });
});

describe('PR overview', () => {
  it('names developers in the By developer table', async () => {
    renderAt('/prs');
    const row = (await screen.findAllByText('Carol Diaz')).map(el => el.closest('tr')).find(Boolean)!;
    expect(within(row).getByText('carol@acme.com')).toBeInTheDocument();
  });

  it('names developers in the developer facet', async () => {
    renderAt('/prs?filters=1');
    // The facet's options come from a second query, so give it a moment.
    fireEvent.click(await screen.findByRole('button', { name: 'Carol Diaz' }, { timeout: 3000 }));
    // The chip shows the name; the filter still sends the key.
    await waitFor(() => expect(get.mock.calls.map(c => String(c[0])).some(u =>
      u.startsWith('/v1/prs/overview') && new URLSearchParams(u.split('?')[1]).get('users') === 'carol@acme.com')).toBe(true));
  });

  it('names the person on the heatmap row and in its cells', async () => {
    renderAt('/prs');
    const cell = await screen.findByRole('button', { name: /1 PR by Carol Diaz on 2026-09-10/ }, { timeout: 3000 });
    expect(cell).toBeInTheDocument();
    // The row label sits in the same grid as the cell.
    const grid = cell.closest('.grid') as HTMLElement;
    // The name stands for the key, without a mouse-only title (STORY 501129d3).
    expect(within(grid).getByText('Carol Diaz')).not.toHaveAttribute('title');
  });

  it('tells two keys with the same name apart', async () => {
    NAMES_OVERRIDE = { 'carol@acme.com': 'Carol Diaz', 'dan@acme.com': 'Carol Diaz' };
    renderAt('/prs?filters=1');
    expect(await screen.findByRole('button', { name: 'Carol Diaz (carol@acme.com)' }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Carol Diaz (dan@acme.com)' })).toBeInTheDocument();
  });
});
