/**
 * @vitest-environment jsdom
 *
 * BUG 72c309df: the tiles read the hub's live `totals`, the same aggregate as
 * the per-person rows, rather than adding up the rollup series (UTC days,
 * closures distinct per day); and a person link keeps the period it was
 * clicked in.
 */
import { render, screen, cleanup, within, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgPage } from '../pages/Org';
import { tileTotals } from '../components/MetricsTilesRow';
import { UserDetailPage } from '../pages/UserDetail';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

/** Rollup days that add up to something else entirely: never the tiles. */
const SERIES = [
  { user_key: 'bob@acme.com', day: '2026-05-01', events_count: 900, items_closed: 90, validate_passes: 9, validate_fails: 9, prs_opened: 9 },
  { user_key: 'bob@acme.com', day: '2026-05-02', events_count: 900, items_closed: 90, validate_passes: 9, validate_fails: 9, prs_opened: 9 },
];
const TOTALS = { events_count: 41, items_closed: 7, validate_passes: 3, validate_fails: 1, prs_opened: 2 };

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* blocked */ }
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: SERIES, totals: TOTALS } };
    if (url.startsWith('/v1/users')) return { data: [{ user_key: 'bob@acme.com', last_seen: new Date().toISOString(), events_count: 41, items_closed: 7, validate_passes: 3, validate_fails: 1, prs_opened: 2, closed_daily: {} }] };
    if (url.startsWith('/v1/timeline')) return { data: { events: [] } };
    if (url.startsWith('/v1/event-types')) return { data: { types: [] } };
    if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
    if (url.startsWith('/v1/item-types')) return { data: { itemTypes: [], counts: {} } };
    if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
    return { data: {} };
  });
});
afterEach(() => { cleanup(); get.mockReset(); });

const mount = (entry: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/" element={<OrgPage />} />
          <Route path="/users/:userKey" element={<UserDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

/** Waits for the tile labelled `label` to show `value` (as a whole number). */
async function expectTile(label: string, value: RegExp) {
  await waitFor(() => {
    const el = screen.getAllByText(label).map(l => l.closest('[data-stat-tile]')).find(Boolean);
    expect(el?.textContent ?? '').toMatch(value);
  });
}

describe('the tiles read the live totals', () => {
  it('on the Org page', async () => {
    mount('/');
    await expectTile('Events', /(?<!\d)41(?!\d)/);
    await expectTile('Items closed', /(?<!\d)7(?!\d)/);
    // 3 passed of 4 checks.
    await expectTile('Check pass rate', /75%/);
    expect(screen.queryByText((1800).toLocaleString())).toBeNull();
  });

  it('on a person page', async () => {
    mount('/users/bob%40acme.com');
    await expectTile('Events', /(?<!\d)41(?!\d)/);
    await expectTile('Items closed', /(?<!\d)7(?!\d)/);
    expect(screen.queryByText((1800).toLocaleString())).toBeNull();
  });
});

describe('a person link keeps the view it was clicked in', () => {
  const personLink = async () => {
    const table = await screen.findByRole('table', { name: 'Users' });
    const link = await within(table).findByRole('link', { name: /bob@acme\.com/ });
    return new URLSearchParams(link.getAttribute('href')!.split('?')[1] ?? '');
  };

  it('carries the range, every filter and the hub scope', async () => {
    mount('/?range=7d&types=pr.opened&projects=acme%2Fweb&itemTypes=BUG&childHubId=h1');
    const q = await personLink();
    expect(Object.fromEntries(q)).toEqual({ range: '7d', types: 'pr.opened', projects: 'acme/web', itemTypes: 'BUG', childHubId: 'h1' });
  });

  it('carries the defaults too, and an explicitly empty type filter', async () => {
    mount('/');
    expect(Object.fromEntries(await personLink())).toEqual({ range: '30d', types: 'item.closed' });
    cleanup();
    mount('/?types=');
    expect((await personLink()).get('types')).toBe('');
  });

  it('opens the person page on the clicked filters, not the ones it remembered', async () => {
    window.localStorage.setItem('agenfk-hub:user:filters', 'range=90d&projects=acme%2Fapi');
    mount('/?range=7d&projects=acme%2Fweb');
    fireEvent.click(await within(await screen.findByRole('table', { name: 'Users' })).findByRole('link', { name: /bob@acme\.com/ }));
    await waitFor(() => {
      const hit = [...get.mock.calls].map(c => String(c[0])).reverse().find(u => u.startsWith('/v1/metrics?') && u.includes('users='));
      expect(hit).toBeDefined();
      const q = new URLSearchParams(hit!.split('?')[1]);
      expect(q.get('projects')).toBe('acme/web');
      // The clicked 7 days, not the remembered 90 (nor the default 30).
      const days = (Date.now() - Date.parse(q.get('from')!)) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);
    });
  });
});

describe('tileTotals', () => {
  it('adds up the series when the hub sends no totals (one not yet upgraded)', () => {
    expect(tileTotals({ series: SERIES })).toEqual({ events: 1800, closed: 180, passes: 18, fails: 18, prsOpened: 18 });
  });

  it('is all zeros before anything has loaded', () => {
    expect(tileTotals(undefined)).toEqual({ events: 0, closed: 0, passes: 0, fails: 0, prsOpened: 0 });
  });
});
