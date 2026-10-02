/**
 * @vitest-environment jsdom
 *
 * Richer Org user rows (story f355efe4). An event total measures how chatty a
 * machine is; each person's row now also says what they got done: items
 * closed, check pass rate, PRs, and their activity over the period.
 */
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgPage } from '../pages/Org';
import { Sparkline } from '../components/Sparkline';
import { checkPassRate } from '../checkPassRate';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
afterEach(() => { cleanup(); get.mockReset(); });

// Local calendar days, like the page's axis (it buckets in the browser's zone,
// as the hub files closures). A UTC date here ran a day ahead every evening
// west of UTC and dropped today's closure off the axis.
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const USERS = [
  { user_key: 'bob@acme.com', last_seen: ago(0), events_count: 30, items_closed: 2, validate_passes: 1, validate_fails: 3, prs_opened: 1,
    closed_daily: { [day(1)]: 1, [day(0)]: 1 } },
  { user_key: 'alice@acme.com', last_seen: ago(1), events_count: 5, items_closed: 4, validate_passes: 9, validate_fails: 1, prs_opened: 3,
    closed_daily: { [day(2)]: 4 } },
  { user_key: 'quiet@acme.com', last_seen: ago(2), events_count: 1, items_closed: 0, validate_passes: 0, validate_fails: 0, prs_opened: 0,
    closed_daily: {} },
];
let metricsFails = false;

beforeEach(() => {
  metricsFails = false;
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/users')) return { data: USERS };
    if (url.startsWith('/v1/metrics')) {
      if (metricsFails) throw new Error('metrics down');
      // Deliberately unrelated to the rows: they must not be read from here.
      return { data: { bucket: 'day', series: [] } };
    }
    if (url.startsWith('/v1/event-types')) return { data: { types: [] } };
    if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
    if (url.startsWith('/v1/item-types')) return { data: { itemTypes: [], counts: {} } };
    if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
    return { data: {} };
  });
});

const mount = (entry = '/') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[entry]}><OrgPage /></MemoryRouter></QueryClientProvider>);
};

/** The cells of the row for `who`, keyed by column header text. */
async function rowFor(who: RegExp) {
  const table = await screen.findByRole('table', { name: 'Users' });
  const headers = within(table).getAllByRole('columnheader').map(h => h.textContent?.trim() ?? '');
  const tr = await within(table).findByRole('row', { name: who });
  const cells = within(tr).getAllByRole('cell');
  return Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
}

describe('checkPassRate', () => {
  it('is a clamped percentage, or null with no checks', () => {
    expect(checkPassRate(3, 1)).toBe(75);
    expect(checkPassRate(999, 1)).toBe(99);
    expect(checkPassRate(1, 300)).toBe(1);
    expect(checkPassRate(0, 0)).toBeNull();
  });
});

describe('Sparkline', () => {
  it('says what it shows, for screen readers', () => {
    render(<Sparkline daily={{ a: 1, b: 3 }} axis={['a', 'b']} label="Activity" />);
    expect(screen.getByRole('img', { name: 'Activity: 4 over 2 days, peak 3' })).toBeInTheDocument();
  });
  it('draws a dot, not an empty line, for a single day', () => {
    const { container } = render(<Sparkline daily={{ a: 2 }} axis={['a']} label="Items closed" />);
    expect(container.querySelector('circle')).not.toBeNull();
  });

  it('stays hidden when it has no label', () => {
    const { container } = render(<Sparkline daily={{ a: 1 }} axis={['a']} />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('Org user rows say what each person got done', () => {
  it('shows items closed, check pass rate, PRs and closed items per day', async () => {
    mount();
    const bob = await rowFor(/bob@acme\.com/);
    expect(bob['Items closed']).toHaveTextContent('2');
    expect(bob['Check pass rate']).toHaveTextContent('25%');
    expect(bob['PRs']).toHaveTextContent('1');
    // What got done per day, not how chatty the machine was.
    expect(within(bob['Closed per day']).getByRole('img', { name: /^Closures: 2 over \d+ days, peak 1$/ })).toBeInTheDocument();

    const alice = await rowFor(/alice@acme\.com/);
    expect(alice['Items closed']).toHaveTextContent('4');
    expect(alice['Check pass rate']).toHaveTextContent('90%');
    expect(alice['PRs']).toHaveTextContent('3');
  });

  it('reads out what the pass rate and Last active only showed on hover (story f17f36a5)', async () => {
    mount();
    const bob = await rowFor(/bob@acme\.com/);
    // Read once: the hover title sits on the aria-hidden visual, the sr-only
    // text carries the counts.
    expect(within(bob['Check pass rate']).getByText('25%, 1 passed, 3 failed')).toHaveClass('sr-only');
    expect(within(bob['Check pass rate']).getByTitle('1 passed · 3 failed')).toHaveAttribute('aria-hidden', 'true');
    const quiet = await rowFor(/quiet@acme\.com/);
    expect(within(quiet['Check pass rate']).getByText('no checks ran')).toHaveClass('sr-only');
    expect(within(quiet['Check pass rate']).getByText('—')).toHaveAttribute('aria-hidden', 'true');
    // The relative time on screen; the absolute one read out. (This view is
    // filtered by event type, so the column reads "Last match".)
    const last = within(bob['Last match']).getAllByText((_, el) => !!el?.classList.contains('sr-only') && /\d/.test(el.textContent ?? ''));
    expect(last.length).toBeGreaterThan(0);
  });

  it('reads the rows from the users answer, not the metrics the tiles use', async () => {
    metricsFails = true;
    mount();
    const alice = await rowFor(/alice@acme\.com/);
    expect(alice['Items closed']).toHaveTextContent('4');
    expect(alice['PRs']).toHaveTextContent('3');
  });

  it('says which columns follow the Event type filter', async () => {
    mount('/?types=item.closed');
    expect(await screen.findByText(/Listed by matching events\. Items closed, check pass rate and PRs count every event type/)).toBeInTheDocument();
    cleanup();
    mount('/?types=');
    await screen.findByRole('table', { name: 'Users' });
    expect(screen.queryByText(/count every event type/)).toBeNull();
  });

  it('shows zeros and a dash for someone who closed and checked nothing', async () => {
    mount();
    const quiet = await rowFor(/quiet@acme\.com/);
    expect(quiet['Items closed']).toHaveTextContent('0');
    expect(quiet['Check pass rate']).toHaveTextContent('—');
    expect(quiet['PRs']).toHaveTextContent('0');
  });

  it('sorts by what people got done', async () => {
    mount();
    const table = await screen.findByRole('table', { name: 'Users' });
    await within(table).findByRole('row', { name: /alice@acme\.com/ });
    fireEvent.click(within(table).getByRole('button', { name: /PRs/ }));
    const first = within(table).getAllByRole('row')[1];
    expect(first).toHaveTextContent('alice@acme.com');
    fireEvent.click(within(table).getByRole('button', { name: /Check pass rate/ }));
    // Highest rate first; no checks sorts below any rate.
    const order = within(table).getAllByRole('row').slice(1).map(r => r.textContent);
    expect(order[0]).toMatch(/alice/);
    expect(order[2]).toMatch(/quiet/);
  });
});
