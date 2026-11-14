/**
 * @vitest-environment jsdom
 *
 * Stat tiles filter on click (story 021e7e73). A tile that looks clickable
 * is: it is a button that sets the Event type filter to what it counts, shows
 * when that filter is on, and clears it on a second click. A tile without an
 * action stays a plain, non-interactive box.
 */
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatTile } from '../components/ui';
import { MetricsTilesRow } from '../components/MetricsTilesRow';
import { OrgPage } from '../pages/Org';
import { UserDetailPage } from '../pages/UserDetail';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
afterEach(() => { cleanup(); get.mockReset(); });

const TOTALS = { events: 10, closed: 2, passes: 3, fails: 1, prsOpened: 1 };

describe('StatTile', () => {
  it('is a plain box with no hover when it has no action', () => {
    render(<StatTile label="Events" value={1} />);
    expect(screen.queryByRole('button')).toBeNull();
    const tile = screen.getByText('Events').closest('[data-stat-tile]') as HTMLElement;
    expect(tile.className).not.toMatch(/hover:/);
  });

  it('is a pressable button when it has one', () => {
    const onClick = vi.fn();
    render(<StatTile label="Items closed" value={2} onClick={onClick} pressed />);
    const button = screen.getByRole('button', { name: /Items closed/ });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('MetricsTilesRow as a filter', () => {
  function Harness({ initial = [] as string[] }) {
    const [sel, setSel] = useState<string[]>(initial);
    return (
      <>
        <MetricsTilesRow totals={TOTALS} selectedTypes={new Set(sel)} onFilterTypes={setSel} />
        <output data-testid="sel">{[...sel].sort().join(',')}</output>
      </>
    );
  }
  const sel = () => screen.getByTestId('sel').textContent;

  it('sets the filter to what each tile counts', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Items closed/ }));
    expect(sel()).toBe('item.closed');
    fireEvent.click(screen.getByRole('button', { name: /Check pass rate/ }));
    expect(sel()).toBe('validate.failed,validate.passed');
    fireEvent.click(screen.getByRole('button', { name: /PRs opened/ }));
    expect(sel()).toBe('pr.opened');
    fireEvent.click(screen.getByRole('button', { name: /Events/ }));
    expect(sel()).toBe('');
  });

  it('shows which tile is the current filter, and clears it on a second click', () => {
    render(<Harness initial={['item.closed']} />);
    const closed = screen.getByRole('button', { name: /Items closed/ });
    expect(closed).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Events/ })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(closed);
    expect(sel()).toBe('');
    expect(screen.getByRole('button', { name: /Events/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the pressed "all types" tile a focusable button that cannot release itself', () => {
    render(<Harness initial={['item.closed']} />);
    const events = screen.getByRole('button', { name: /Events/ });
    events.focus();
    fireEvent.click(events);
    expect(sel()).toBe('');
    // Same element, still focused: the selection change did not swap it out.
    expect(events).toHaveFocus();
    expect(events).toHaveAttribute('aria-pressed', 'true');
    expect(events).toHaveAttribute('aria-disabled', 'true');
  });

  it('a locked tile ignores clicks and says what is already shown', () => {
    const onClick = vi.fn();
    render(<StatTile label="Events" value={1} onClick={onClick} pressed locked />);
    fireEvent.click(screen.getByRole('button', { name: /Events/ }));
    expect(onClick).not.toHaveBeenCalled();
    cleanup();
    render(<Harness initial={[]} />);
    expect(screen.getByRole('button', { name: /Events/ })).toHaveAccessibleDescription('Showing every event type');
  });

  it('shows the action, not the number, on hover', () => {
    render(<Harness />);
    const prs = screen.getByRole('button', { name: /PRs opened/ });
    expect(prs.querySelector('[title]')).toBeNull();
  });

  it('says what a click does', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /PRs opened/ })).toHaveAccessibleDescription('Show only PR opened events below');
    expect(screen.getByRole('button', { name: /Check pass rate/ })).toHaveAccessibleDescription('Show only check events below');
  });

  it('presses no tile for a selection that is not exactly one tile', () => {
    render(<Harness initial={['item.closed', 'item.created']} />);
    expect(screen.queryByRole('button', { pressed: true })).toBeNull();
  });

  it('stays static where no filter is wired', () => {
    render(<MetricsTilesRow totals={TOTALS} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

const routes = () => {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/users')) return { data: [] };
    if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: [] } };
    if (url.startsWith('/v1/event-types')) return { data: { types: ['item.closed', 'pr.opened'] } };
    if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
    if (url.startsWith('/v1/item-types')) return { data: { itemTypes: [], counts: {} } };
    if (url.startsWith('/v1/timeline')) return { data: { events: [], total: 0 } };
    if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
    return { data: {} };
  });
};

function mountAt(entry: string) {
  let search = '';
  function Where() { search = useLocation().search; return null; }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Where />
        <Routes>
          <Route path="/" element={<OrgPage />} />
          <Route path="/users/:userKey" element={<UserDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return () => new URLSearchParams(search);
}

describe('the dashboards wire the tiles to the Event type filter', () => {
  beforeEach(routes);

  it('Org: clicking PRs opened filters the page to PR events, in the link too', async () => {
    const url = mountAt('/');
    // A bare visit opens on closed items, and the tile shows that.
    expect(await screen.findByRole('button', { name: /Items closed/, pressed: true })).toBeInTheDocument();
    const prs = screen.getByRole('button', { name: /PRs opened/ });
    fireEvent.click(prs);
    await waitFor(() => expect(url().get('types')).toBe('pr.opened'));
    expect(prs).toHaveAttribute('aria-pressed', 'true');
    // Clicking it again opens the filter to every type.
    fireEvent.click(prs);
    await waitFor(() => expect(url().get('types')).toBe(''));
  });

  it('the user page: clicking Items closed narrows the event list', async () => {
    const url = mountAt('/users/alice%40acme.com?types=');
    const tiles = await screen.findByRole('button', { name: /Items closed/ });
    fireEvent.click(tiles);
    await waitFor(() => expect(url().get('types')).toBe('item.closed'));
    await waitFor(() => {
      const tl = get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/v1/timeline')).pop()!;
      expect(new URLSearchParams(tl.split('?')[1]).get('types')).toBe('item.closed');
    });
    // The tiles ignore the type filter: their numbers do not move.
    await waitFor(() => {
      const metrics = get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/v1/metrics'));
      expect(metrics.length).toBeGreaterThan(0);
      expect(metrics.every(u => !new URLSearchParams(u.split('?')[1]).has('types'))).toBe(true);
    });
  });
});
