/**
 * @vitest-environment jsdom
 *
 * Sortable, searchable, paged tables (story f15fb3a6). One DataTable with
 * sortable headers (aria-sort), used by Org's Users and PR overview's By
 * developer / By model; the user page says how many events there are and
 * loads more instead of stopping silently at 200.
 */
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DataTable, type DataColumn } from '../components/ui';
import { OrgPage } from '../pages/Org';
import { PrOverviewPage } from '../pages/PrOverview';
import { UserDetailPage } from '../pages/UserDetail';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
afterEach(() => { cleanup(); get.mockReset(); });

const mount = (el: React.ReactElement, entry = '/', path = '*') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}><Routes><Route path={path} element={el} /></Routes></MemoryRouter>
    </QueryClientProvider>,
  );
};

/** First-column text of each body row, in order. */
const firstCells = (table: HTMLElement) =>
  within(table).getAllByRole('row').slice(1).map(r => within(r).getAllByRole('cell')[0].textContent?.trim());

interface Row { name: string; n: number; note: string }
const ROWS: Row[] = [
  { name: 'carol', n: 2, note: 'x' },
  { name: 'alice', n: 5, note: 'y' },
  { name: 'bob', n: 2, note: 'z' },
];
const COLS: DataColumn<Row>[] = [
  { key: 'name', header: 'Name', render: r => r.name, sortValue: r => r.name },
  { key: 'n', header: 'Count', render: r => r.n, sortValue: r => r.n, align: 'right', firstDir: 'desc' },
  { key: 'note', header: 'Note', render: r => r.note },
];

describe('DataTable', () => {
  it('starts in the default order and marks that header', () => {
    render(<DataTable caption="People" columns={COLS} rows={ROWS} rowKey={r => r.name} defaultSort={{ key: 'n', dir: 'desc' }} />);
    const table = screen.getByRole('table', { name: 'People' });
    // Ties keep their input order: carol before bob.
    expect(firstCells(table)).toEqual(['alice', 'carol', 'bob']);
    expect(screen.getByRole('columnheader', { name: /Count/ })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'none');
  });

  it('sorts by a header, and flips on a second click', () => {
    render(<DataTable caption="People" columns={COLS} rows={ROWS} rowKey={r => r.name} />);
    const table = screen.getByRole('table', { name: 'People' });
    expect(firstCells(table)).toEqual(['carol', 'alice', 'bob']);
    fireEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(firstCells(table)).toEqual(['alice', 'bob', 'carol']);
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(firstCells(table)).toEqual(['carol', 'bob', 'alice']);
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'descending');
  });

  it('starts a column in its declared direction, ascending otherwise, even with no rows', () => {
    render(<DataTable caption="Empty" columns={COLS} rows={[]} rowKey={r => r.name} />);
    fireEvent.click(screen.getByRole('button', { name: /Count/ }));
    expect(screen.getByRole('columnheader', { name: /Count/ })).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'ascending');
  });

  it('starts numbers high-to-low on the first click', () => {
    render(<DataTable caption="People" columns={COLS} rows={ROWS} rowKey={r => r.name} />);
    fireEvent.click(screen.getByRole('button', { name: /Count/ }));
    expect(firstCells(screen.getByRole('table'))[0]).toBe('alice');
  });

  it('leaves a column without sortValue unsortable', () => {
    render(<DataTable caption="People" columns={COLS} rows={ROWS} rowKey={r => r.name} />);
    const note = screen.getByRole('columnheader', { name: 'Note' });
    expect(within(note).queryByRole('button')).toBeNull();
    expect(note).not.toHaveAttribute('aria-sort');
  });

  it('filters by search and says when nothing matches', () => {
    render(
      <DataTable caption="People" columns={COLS} rows={ROWS} rowKey={r => r.name}
        search={{ label: 'Search people', matches: (r, q) => r.name.includes(q) }} />,
    );
    const box = screen.getByRole('searchbox', { name: 'Search people' });
    fireEvent.change(box, { target: { value: 'al' } });
    expect(firstCells(screen.getByRole('table'))).toEqual(['alice']);
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText('No rows match “zzz”.')).toBeInTheDocument();
  });
});

describe('Org Users is a sortable, searchable table', () => {
  beforeEach(() => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/users')) return { data: [
        { user_key: 'bob@acme.com', last_seen: '2026-09-29T00:00:00Z', events_count: 12 },
        { user_key: 'alice@acme.com', last_seen: '2026-09-30T00:00:00Z', events_count: 3 },
        { user_key: 'carol@acme.com', last_seen: '2026-09-01T00:00:00Z', events_count: 40 },
      ] };
      if (url.startsWith('/v1/people/names')) return { data: { names: { 'alice@acme.com': 'Alice Ng' } } };
      if (url.startsWith('/v1/event-types')) return { data: { types: [] } };
      if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
      if (url.startsWith('/v1/item-types')) return { data: { itemTypes: [], counts: {} } };
      if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: [] } };
      if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
      return { data: {} };
    });
  });

  it('opens on most recently active, sorts by events, and finds people by name or email', async () => {
    mount(<OrgPage />);
    const table = await screen.findByRole('table', { name: 'Users' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    const order = () => within(table).getAllByRole('row').slice(1).map(r => r.textContent);
    expect(order()[0]).toMatch(/Alice Ng/);
    // Org opens filtered to closed items, so the columns say they count matches.
    expect(screen.getByRole('columnheader', { name: /Last match/ })).toHaveAttribute('aria-sort', 'descending');

    fireEvent.click(within(table).getByRole('button', { name: /events/i }));
    expect(order()[0]).toMatch(/carol@acme\.com/);

    const search = screen.getByRole('searchbox', { name: 'Search people' });
    fireEvent.change(search, { target: { value: 'alice ng' } });
    expect(order()).toHaveLength(1);
    fireEvent.change(search, { target: { value: 'BOB@' } });
    expect(order()[0]).toMatch(/bob@acme\.com/);
    // The person still links to their page.
    expect(within(table).getByRole('link', { name: /bob@acme\.com/ })).toHaveAttribute('href', '/users/bob%40acme.com');
  });
});

describe('PR overview tables sort', () => {
  beforeEach(() => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
      if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
      return { data: {
        period: { from: '2026-08-10T00:00:00.000Z', to: '2026-08-22T23:59:59.999Z' },
        buckets: ['xs', 's', 'm', 'l', 'xl'],
        totals: { prs: 4, sizePoints: 20, developers: 2, medianBucket: 's' },
        resized: { count: 0, grew: 0, shrank: 0 },
        byDay: [],
        byDeveloper: [
          { user_key: 'zed@acme.com', prs: 3, sizePoints: 6, sizes: { xs: 3, s: 0, m: 0, l: 0, xl: 0 }, daily: {} },
          { user_key: 'amy@acme.com', prs: 1, sizePoints: 14, sizes: { xs: 0, s: 0, m: 1, l: 0, xl: 0 }, daily: {} },
        ],
        byModel: [
          { model: 'a-model', harnesses: [], prs: 1, sizePoints: 14, sizes: { xs: 0, s: 0, m: 1, l: 0, xl: 0 } },
          { model: 'b-model', harnesses: [], prs: 3, sizePoints: 6, sizes: { xs: 3, s: 0, m: 0, l: 0, xl: 0 } },
        ],
        previous: null,
      } };
    });
  });

  it('By developer: most PRs first, and by size points on request', async () => {
    mount(<PrOverviewPage />, '/prs');
    const table = await screen.findByRole('table', { name: 'By developer' });
    expect(firstCells(table)[0]).toMatch(/zed@acme\.com/);
    expect(within(table).getByRole('columnheader', { name: /PRs/ })).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(within(table).getByRole('button', { name: /Size points/ }));
    expect(firstCells(table)[0]).toMatch(/amy@acme\.com/);
  });

  it('By model: most PRs first, by name on request', async () => {
    mount(<PrOverviewPage />, '/prs');
    const table = await screen.findByRole('table', { name: 'By model' });
    expect(firstCells(table)[0]).toMatch(/b-model/);
    fireEvent.click(within(table).getByRole('button', { name: /Model/ }));
    expect(firstCells(table)[0]).toMatch(/a-model/);
  });
});

describe('the user page says how many events there are and loads more', () => {
  const event = (i: number) => ({
    event_id: `e${i}`, occurred_at: new Date(Date.UTC(2026, 8, 1, 0, 0, 1000 - i)).toISOString(),
    type: 'item.created', project_id: 'p', item_id: `i${i}`, item_type: 'TASK', remote_url: null,
    item_title: `Item ${i}`, external_id: null, user_key: 'alice@acme.com', payload: {},
  });

  let total = 250;
  /** The server's cursor pages, plus an overlap it must not show twice. */
  beforeEach(() => {
    total = 250;
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/timeline')) {
        const q = new URLSearchParams(url.split('?')[1]);
        const limit = Number(q.get('limit'));
        const before = q.get('before');
        // Page 2 starts 3 events early, as if 3 arrived in between.
        const start = before ? Number(before.split('|')[1].slice(1)) + 1 - 3 : 0;
        const n = Math.max(0, Math.min(limit, total - start));
        const events = Array.from({ length: n }, (_, k) => event(start + k));
        const last = events[events.length - 1];
        return { data: {
          events,
          ...(before ? {} : { total }),
          // Like the server: a full page always carries a cursor.
          nextBefore: n === limit && last ? `${last.occurred_at}|${last.event_id}` : undefined,
        } };
      }
      if (url.startsWith('/v1/event-types')) return { data: { types: [] } };
      if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
      if (url.startsWith('/v1/item-types')) return { data: { itemTypes: [], counts: {} } };
      if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: [] } };
      if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
      return { data: {} };
    });
  });

  it('offers no Load more once everything counted is shown, even after a full page', async () => {
    total = 200;
    mount(<UserDetailPage />, '/users/alice%40acme.com', '/users/:userKey');
    expect(await screen.findByText(/Showing all 200/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('says nothing about counts when there are no events', async () => {
    total = 0;
    mount(<UserDetailPage />, '/users/alice%40acme.com', '/users/:userKey');
    expect(await screen.findByText('No events match the current filters.')).toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  it('shows the latest 200 of the total, then the rest on Load more', async () => {
    mount(<UserDetailPage />, '/users/alice%40acme.com', '/users/:userKey');
    expect(await screen.findByText(/Showing latest 200 of 250/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText(/Showing all 250/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    // Asked from the last event shown, not by offset.
    const cursors = get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/v1/timeline'))
      .map(u => new URLSearchParams(u.split('?')[1]).get('before'));
    expect(cursors).toContain(`${event(199).occurred_at}|e199`);
    expect(screen.getByText('Item 249')).toBeInTheDocument();
    // The overlap the server sent is shown once.
    expect(screen.getAllByText('Item 198')).toHaveLength(1);
  });
});
