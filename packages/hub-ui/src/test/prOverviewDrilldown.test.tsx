/**
 * @vitest-environment jsdom
 *
 * PR Overview — per-cell drill-down modal (CGLAB-131).
 *
 * Page-level contract for the modal opened from a non-zero heatmap cell:
 *  - clicking the cell opens a dialog listing that developer's PRs for that day;
 *  - rows with a derived GitHub link are WHOLE-ROW links (no nested anchors):
 *    clicking anywhere on the row (repo, model, badge…) hits the PR href;
 *  - rows without a link (non-GitHub host / unparseable) are inert — no anchor;
 *  - size badges are legible: dark ink on the light ramp end (xs/s/m), white
 *    on the dark end (l/xl) — the "white box" defect was white text on the
 *    near-white XS fill.
 */
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrOverviewPage } from '../pages/PrOverview';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const overview = {
  period: { from: '2026-08-10T00:00:00.000Z', to: '2026-08-22T23:59:59.999Z' },
  buckets: ['xs', 's', 'm', 'l', 'xl'],
  totals: { prs: 2, sizePoints: 8, developers: 1, medianBucket: 'xs' },
  resized: { count: 0, grew: 0, shrank: 0 },
  byDay: [
    {
      day: '2026-08-13',
      sizes: { xs: 1, s: 0, m: 0, l: 1, xl: 0 },
      total: 2,
      devBySize: {
        xs: [{ user_key: 'alice@acme.com', count: 1 }],
        s: [], m: [], l: [{ user_key: 'alice@acme.com', count: 1 }], xl: [],
      },
    },
  ],
  byDeveloper: [
    {
      user_key: 'alice@acme.com',
      prs: 2,
      sizePoints: 8,
      sizes: { xs: 1, s: 0, m: 0, l: 1, xl: 0 },
      daily: { '2026-08-13': 2 },
    },
  ],
  byModel: [
    { model: 'claude-opus-5', harnesses: ['claude-code'], prs: 2, sizePoints: 8, sizes: { xs: 1, s: 0, m: 0, l: 1, xl: 0 } },
  ],
  prs: [
    {
      repo: 'cglab-PRIVATE/smartshot',
      prNumber: 202,
      url: 'https://github.com/cglab-PRIVATE/smartshot/pull/202',
      user_key: 'alice@acme.com',
      model: 'claude-opus-5',
      harness: 'claude-code',
      openedAt: '2026-08-13T16:50:18Z',
      day: '2026-08-13',
      points: 2,
      bucket: 'xs',
    },
    {
      repo: 'cglab-PRIVATE/smartshot',
      prNumber: 203,
      url: null, // non-GitHub host — the hub deliberately derives no link
      user_key: 'alice@acme.com',
      model: 'claude-opus-5',
      harness: 'claude-code',
      openedAt: '2026-08-13T18:12:13Z',
      day: '2026-08-13',
      points: 16,
      bucket: 'l',
    },
  ],
  previous: { prs: 1, sizePoints: 4 },
};

const renderPage = () => {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/projects')) return { data: { projects: ['cglab-PRIVATE/smartshot'] } };
    // The page asks which hubs it is showing (CGLAB-184). Answer it explicitly:
    // these fixtures otherwise treat every non-projects URL as an overview call,
    // and a standalone hub is the right default for a suite about PR filters.
    if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
    return { data: overview };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/prs']}>
        <PrOverviewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const openModal = async () => {
  renderPage();
  // Await the data load (the heatmap cells only exist once the overview
  // query has resolved) — then click the non-zero cell (the a11y fix made
  // drillable cells real buttons).
  const cell = await screen.findByRole('button', { name: '2 PRs by alice@acme.com on 2026-08-13 — open list' });
  fireEvent.click(cell);
  return screen.findByRole('dialog');
};

// The page builds its heatmap axis from the REAL clock —
// `fromIsoForRange(new Date(), range)` with a 30d default — while this file's
// fixture pins its PRs to fixed dates in August 2026. Left on the wall clock
// the two drift apart: once "today" moved more than 30 days past the fixture,
// 2026-08-13 fell outside the window, the drillable cell stopped rendering and
// every test here failed — on every commit, which is what made it look like a
// regression rather than a stale fixture. Pin the clock inside the fixture's
// period so the axis is deterministic. (CGLAB-186.)
// One day after the fixture's PR day, so the fixture day sits inside the
// window for EVERY preset the page offers (7d as well as the 30d default) —
// picking a date near the period's end left only 9 days of slack and would
// have re-armed this the moment the default range changed.
const FIXTURE_NOW = new Date('2026-08-14T12:00:00.000Z');

beforeEach(() => {
  // shouldAdvanceTime keeps timer-driven work (react-query, RTL's findBy*
  // polling) running instead of deadlocking on a frozen clock.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FIXTURE_NOW);
  get.mockReset();
});

afterEach(() => {
  // cleanup() first: unmounting under the fake clock lets components clear
  // their own timers, instead of having them discarded by the uninstall.
  cleanup();
  vi.useRealTimers();
  get.mockReset();
});

describe('PrOverviewPage drill-down modal (CGLAB-131)', () => {
  it('asks for the window the axis is drawn from, and drops days outside it', async () => {
    // The coupling that rotted (CGLAB-186), asserted directly: the heatmap
    // axis is the REQUESTED window, so a fixture day only has a cell while the
    // clock keeps it inside that window. Naming it "whatever the real date is"
    // would be false — the pinned clock is exactly what makes it true.
    renderPage();
    await screen.findByRole('button', { name: '2 PRs by alice@acme.com on 2026-08-13 — open list' });

    // the request carried the 30d default window ending at the pinned now
    const url = get.mock.calls.map(c => String(c[0])).find(u => u.includes('/v1/prs/overview'))!;
    const from = new URL(url, 'http://x').searchParams.get('from')!;
    expect(from.slice(0, 10)).toBe('2026-07-15');

    // roll the clock past the window and the same cell is gone — this is the
    // failure CGLAB-186 produced, now pinned as expected behaviour rather than
    // left to surface as four "unable to find role=button" errors.
    cleanup();
    get.mockReset();
    vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
    renderPage();
    expect(await screen.findByText('Total PRs')).toBeInTheDocument();
    expect(screen.queryByRole('button', {
      name: '2 PRs by alice@acme.com on 2026-08-13 — open list',
    })).toBeNull();
  });

  it('opens from a non-zero cell and lists that developer’s PRs for that day', async () => {
    const dialog = await openModal();
    const scope = within(dialog);
    expect(scope.getByText('#202')).toBeInTheDocument();
    expect(scope.getByText('#203')).toBeInTheDocument();
    // Exactly the PRs for this cell — nothing from other days/developers.
    expect(scope.queryByText('#999')).not.toBeInTheDocument();
  });

  it('makes the WHOLE row the GitHub link (no nested anchors) when a link was derived', async () => {
    const dialog = await openModal();
    const scope = within(dialog);
    // Both fixture PRs are in the same repo — scope to the #202 row.
    const rows = dialog.querySelectorAll('li');
    const row202 = Array.from(rows).find(li => li.textContent?.includes('#202'))!;
    // Clicking the repo text (not the #N) must land on the PR href.
    const repo = within(row202).getByText('cglab-PRIVATE/smartshot');
    const anchor = repo.closest('a');
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute('href')).toBe('https://github.com/cglab-PRIVATE/smartshot/pull/202');
    expect(anchor!.getAttribute('target')).toBe('_blank');
    // No anchor nested inside the row anchor (invalid HTML + double-link UX).
    expect(anchor!.querySelector('a')).toBeNull();
    // The #N itself is no longer a separate link — it is part of the row link.
    expect(within(row202).getByText('#202').closest('a')).toBe(anchor);
  });

  it('keeps rows without a derived link inert (no anchor anywhere in the row)', async () => {
    const dialog = await openModal();
    const scope = within(dialog);
    const num203 = scope.getByText('#203');
    expect(num203.closest('a')).toBeNull();
    // Its repo text is inert too.
    const rows = dialog.querySelectorAll('li');
    const row203 = Array.from(rows).find(li => li.textContent?.includes('#203'))!;
    expect(row203.querySelector('a')).toBeNull();
  });

  it('renders size badges with legible text color per ramp step (no white-on-white)', async () => {
    const dialog = await openModal();
    const scope = within(dialog);
    const badge = (label: string) =>
      Array.from(scope.getAllByText(label)).find(el => (el as HTMLElement).style.background) as HTMLElement;

    // XS: near-white fill #dbf7f0 → dark ink, NOT white.
    const xs = badge('XS');
    expect(xs).toBeTruthy();
    expect(xs.style.background).toContain('219, 247, 240'); // #dbf7f0
    expect(xs.style.color).not.toContain('255, 255, 255');
    expect(xs.style.color).toContain('0, 15, 59'); // #000f3b

    // L: dark fill #056f71 → white.
    const l = badge('L');
    expect(l).toBeTruthy();
    expect(l.style.background).toContain('5, 111, 113'); // #056f71
    expect(l.style.color).toContain('255, 255, 255');
  });

  // CGLAB-184: on a parent hub, (repo, prNumber) is no longer unique — two
  // child hubs can each size "acme/web#57". The server now returns both, keyed
  // by the reporting hub.
  it('renders two hubs\' same-numbered PRs as two distinct rows', async () => {
    const collided = {
      ...overview,
      totals: { ...overview.totals, prs: 2 },
      prs: [
        { ...overview.prs[0], repo: 'acme/web', prNumber: 57, url: 'https://github.com/acme/web/pull/57',
          childHubId: 'local', user_key: 'alice@acme.com', points: 2, bucket: 'xs' },
        { ...overview.prs[0], repo: 'acme/web', prNumber: 57, url: 'https://github.com/acme/web/pull/57',
          childHubId: '9f1c7e2a-0000-4000-8000-000000000001', user_key: 'alice@acme.com',
          openedAt: '2026-08-13T18:12:13Z', points: 16, bucket: 'l' },
      ],
    };
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
    try {
      get.mockImplementation(async (url: string) => {
        if (url.startsWith('/v1/projects')) return { data: { projects: ['acme/web'] } };
        // The page asks which hubs it is showing (CGLAB-184). Answer it explicitly:
        // these fixtures otherwise treat every non-projects URL as an overview call,
        // and a standalone hub is the right default for a suite about PR filters.
        if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
        return { data: collided };
      });
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/prs']}>
            <PrOverviewPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      const cell = await screen.findByRole('button', { name: '2 PRs by alice@acme.com on 2026-08-13 — open list' });
      fireEvent.click(cell);
      const dialog = await screen.findByRole('dialog');
      // Both survive the render...
      expect(dialog.querySelectorAll('li')).toHaveLength(2);
      // ...and React is not reusing one DOM node for both, which is what a
      // duplicate key causes and what makes a filter change show stale content.
      expect(errors.join('\n')).not.toMatch(/same key/i);
    } finally {
      spy.mockRestore();
    }
  });
});
