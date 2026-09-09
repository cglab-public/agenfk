/**
 * @vitest-environment jsdom
 *
 * PR Overview — search by PR number (story 79220886).
 *
 * The behaviour that matters here is the OVERRIDE, and the risk it carries:
 *  - the search supersedes date, model and developer, so the data query must
 *    stop sending those params entirely. Sending them AND `pr` would let the
 *    server disagree with the user about what "PR #57" means.
 *  - Project (git remote) is the one filter that survives, because #57 exists in
 *    every repo the org reports.
 *  - a superseded control that still LOOKS live is a lie. The date presets, the
 *    date inputs and the model/developer facets are disabled while the search is
 *    active, and the page says why.
 *  - like every other filter on this page, the search lives in the URL, so a
 *    shared link restores the same single PR.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrOverviewPage } from '../pages/PrOverview';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const REMOTE = 'git@github.com:acme/api.git';

/** An overview for N PRs opened by one developer on one model. */
function makeOverview(models: string[]) {
  return {
    period: { from: '2026-08-10T00:00:00.000Z', to: '2026-08-22T23:59:59.999Z' },
    buckets: ['xs', 's', 'm', 'l', 'xl'],
    totals: { prs: models.length, sizePoints: models.length * 4, developers: 1, medianBucket: 'xs' },
    resized: { count: 0, grew: 0, shrank: 0 },
    byDay: [],
    byDeveloper: [{
      user_key: 'alice@acme.com', prs: models.length, sizePoints: models.length * 4,
      sizes: { xs: models.length, s: 0, m: 0, l: 0, xl: 0 }, daily: {},
    }],
    byModel: models.map(m => ({
      model: m, harnesses: [], prs: 1, sizePoints: 4,
      sizes: { xs: 1, s: 0, m: 0, l: 0, xl: 0 },
      provider: m === 'glm-5.2' ? 'Z.ai' : 'Anthropic',
      licenseClass: m === 'glm-5.2' ? 'open_weights' : 'commercial',
      license: m === 'glm-5.2' ? 'MIT' : 'Proprietary (API only)',
    })),
    prs: models.map((m, i) => ({
      repo: 'acme/api', prNumber: i + 1, url: `https://github.com/acme/api/pull/${i + 1}`,
      user_key: 'alice@acme.com', model: m, harness: null,
      openedAt: '2026-08-11T10:00:00.000Z', day: '2026-08-11', points: 4, bucket: 'xs',
    })),
    previous: { prs: 1, sizePoints: 4 },
  };
}

/** Overview as the hub answers a PR search that hit: one PR, and the period the
 *  answer actually covers (which is the PR's own open time, not a window). */
function makeSearchHit(prNumber: number) {
  const one = makeOverview(['glm-5.2']);
  return {
    ...one,
    period: { from: '2025-02-10T11:00:00.000Z', to: '2025-02-10T11:00:00.000Z' },
    totals: { prs: 1, sizePoints: 8, developers: 1, medianBucket: 'm' },
    prs: one.prs.slice(0, 1).map(p => ({ ...p, prNumber, url: `https://github.com/acme/api/pull/${prNumber}` })),
    previous: null,
  };
}

function UrlProbe() {
  const [sp] = useSearchParams();
  return <span data-testid="url-probe">{sp.toString()}</span>;
}

const renderPage = (entry = '/prs') => {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/projects')) return { data: { projects: [REMOTE] } };
    const q = new URLSearchParams(url.split('?')[1] ?? '');
    const pr = q.get('pr');
    return { data: pr ? makeSearchHit(Number(pr)) : makeOverview(['claude-opus-4-8', 'glm-5.2']) };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <PrOverviewPage />
        <UrlProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const urlNow = () => new URLSearchParams(screen.getByTestId('url-probe').textContent ?? '');
const overviewUrls = () => get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/v1/prs/overview'));
const qs = (url: string) => new URLSearchParams(url.split('?')[1] ?? '');
/** The most recent overview request that carries `pr` — the search's data query. */
const searchQuery = () => overviewUrls().filter(u => qs(u).get('pr')).at(-1) ?? null;
/** The most recent overview request overall (the data query once the search is off). */
const lastOverview = () => overviewUrls().at(-1) ?? null;
/** The most recent overview request carrying `param` — the page issues an options
 *  query alongside the data query, so "the last call" alone is ambiguous. */
const lastWith = (param: string) => overviewUrls().filter(u => qs(u).get(param) != null).at(-1) ?? null;
const searchBox = () => screen.getByRole('textbox', { name: /PR number/i });

beforeEach(() => get.mockReset());
afterEach(() => { cleanup(); get.mockReset(); });

describe('PR Overview PR-number search box', () => {
  it('renders the search inside the Filters accordion', async () => {
    renderPage();
    const box = await screen.findByRole('textbox', { name: /PR number/i });
    // The user's call: the search is a filter, so it sits with the other
    // filters — not in the header, where it would read as a page-level nav.
    expect(box.closest('#pr-overview-filters-body')).not.toBeNull();
  });

  it('writes the number to the URL, so the view is shareable', async () => {
    renderPage();
    fireEvent.change(searchBox(), { target: { value: '57' } });
    await waitFor(() => expect(urlNow().get('pr')).toBe('57'));
  });

  it('normalises the # form to a bare number in the URL', async () => {
    renderPage();
    fireEvent.change(searchBox(), { target: { value: '#57' } });
    await waitFor(() => expect(urlNow().get('pr')).toBe('57'));
  });

  it('normalises a pasted PR URL to a bare number in the URL', async () => {
    renderPage();
    fireEvent.change(searchBox(), { target: { value: 'https://github.com/acme/api/pull/57/files' } });
    await waitFor(() => expect(urlNow().get('pr')).toBe('57'));
  });

  it('seeds the box from the URL (a shared link restores the same PR)', async () => {
    renderPage('/prs?pr=57');
    await waitFor(() => expect(searchBox()).toHaveValue('57'));
  });

  it('keeps half-typed junk out of the URL and out of the query', async () => {
    renderPage();
    fireEvent.change(searchBox(), { target: { value: 'abc' } });
    await waitFor(() => expect(lastOverview()).not.toBeNull());
    expect(urlNow().get('pr')).toBeNull();
    // The box keeps what the user typed — clearing their text under them is hostile.
    expect(searchBox()).toHaveValue('abc');
    // …and the overview is the unfiltered one, not an empty page.
    expect(qs(lastOverview()!).get('pr')).toBeNull();
    expect(qs(lastOverview()!).get('from')).toBeTruthy();
  });

  it('clears the search from the clear button', async () => {
    renderPage('/prs?pr=57');
    fireEvent.click(await screen.findByRole('button', { name: /clear PR search/i }));
    await waitFor(() => expect(urlNow().get('pr')).toBeNull());
    // The NEWEST overview request is the ordinary windowed one again — earlier
    // calls are still in the log, so this asserts on the last, not on "no call
    // with pr was ever made".
    await waitFor(() => {
      const q = qs(lastOverview()!);
      expect(q.get('pr')).toBeNull();
      expect(q.get('from')).toBeTruthy();
    });
  });
});

describe('PR search supersedes the other filters on the wire', () => {
  it('sends pr + projects only — no from, to, model or users', async () => {
    renderPage(`/prs?pr=57&projects=${encodeURIComponent(REMOTE)}&range=7d&model=glm-5.2&users=alice@acme.com`);
    await waitFor(() => expect(searchQuery()).not.toBeNull());
    const q = qs(searchQuery()!);
    expect(q.get('pr')).toBe('57');
    expect(q.get('projects')).toBe(REMOTE);
    expect(q.get('from')).toBeNull();
    expect(q.get('to')).toBeNull();
    expect(q.get('model')).toBeNull();
    expect(q.get('users')).toBeNull();
  });

  it('sends no from/to even though a preset range is selected', async () => {
    renderPage('/prs?pr=57&range=90d');
    await waitFor(() => expect(searchQuery()).not.toBeNull());
    expect(qs(searchQuery()!).get('from')).toBeNull();
  });

  it('sends no from/to while an explicit date range is set', async () => {
    renderPage('/prs?pr=57&from=2026-08-01&to=2026-08-09');
    await waitFor(() => expect(searchQuery()).not.toBeNull());
    const q = qs(searchQuery()!);
    expect(q.get('from')).toBeNull();
    expect(q.get('to')).toBeNull();
  });

  it('never leaks a model or developer param on any request while the search is active', async () => {
    renderPage('/prs?pr=57&model=glm-5.2&users=alice@acme.com');
    await waitFor(() => expect(searchQuery()).not.toBeNull());
    for (const u of overviewUrls()) {
      const q = qs(u);
      expect(q.get('model')).toBeNull();
      expect(q.get('users')).toBeNull();
    }
  });

  it('restores the superseded filters the moment the search is cleared', async () => {
    renderPage('/prs?pr=57&range=7d&model=glm-5.2');
    await waitFor(() => expect(searchQuery()).not.toBeNull());

    fireEvent.change(searchBox(), { target: { value: '' } });

    // Look for the request that carries the model rather than "the last one":
    // clearing re-enables the unfiltered options query, which legitimately has
    // no model param and would otherwise win the race.
    await waitFor(() => {
      const u = lastWith('model');
      expect(u).not.toBeNull();
      const q = qs(u!);
      expect(q.get('model')).toBe('glm-5.2');
      expect(q.get('pr')).toBeNull();
      expect(q.get('from')).toBeTruthy();
    });
  });
});

describe('Superseded controls read as inactive', () => {
  it('disables the range presets and the date inputs, and says why', async () => {
    renderPage('/prs?pr=57');
    await screen.findByText(/do not apply/i);
    expect(screen.getByRole('button', { name: '7d' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '90d' })).toBeDisabled();
    expect(screen.getByLabelText('From date')).toBeDisabled();
    expect(screen.getByLabelText('To date')).toBeDisabled();
  });

  it('disables the developer and model controls but keeps Project live', async () => {
    renderPage(`/prs?pr=57&projects=${encodeURIComponent(REMOTE)}`);
    // The facet choices come from the overview response, so wait for the data —
    // the filter chrome renders long before it lands.
    const devChip = await screen.findByRole('button', { name: 'alice@acme.com' });
    expect(devChip).toBeDisabled();
    expect(screen.getByRole('button', { name: 'glm-5.2' })).toBeDisabled();
    // …while the one filter the search respects stays clickable.
    expect(screen.getByRole('button', { name: 'acme/api' })).not.toBeDisabled();
    // One PR has one model, so there is nothing to vendor-filter and the
    // meta-filter is absent rather than an empty row of chips.
    expect(screen.queryByRole('heading', { name: 'Provider' })).not.toBeInTheDocument();
  });

  it('disables the vendor meta-filter too when the number matches in two projects', async () => {
    // The realistic case for a live meta-filter under a search: #57 with no
    // project selected resolves in two repos, opened by two different runtimes.
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: [REMOTE] } };
      const q = new URLSearchParams(url.split('?')[1] ?? '');
      if (!q.get('pr')) return { data: makeOverview(['claude-opus-4-8', 'glm-5.2']) };
      const two = makeOverview(['claude-opus-4-8', 'glm-5.2']);
      return { data: { ...two, totals: { ...two.totals, prs: 2 }, previous: null } };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/prs?pr=57']}>
          <PrOverviewPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: /^Z\.ai/ });
    expect(screen.getByRole('button', { name: /^Z\.ai/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Anthropic/ })).toBeDisabled();
  });

  it('leaves every control live when there is no search', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'glm-5.2' });
    expect(screen.getByRole('button', { name: '90d' })).not.toBeDisabled();
    expect(screen.getByLabelText('From date')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'glm-5.2' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /^Z\.ai/ })).not.toBeDisabled();
    expect(screen.queryByText(/do not apply/i)).not.toBeInTheDocument();
  });
});

describe('PR search and the collapsed filter bar', () => {
  it('counts as an active filter, so a collapsed bar cannot hide that it applies', async () => {
    renderPage('/prs?pr=57');
    await waitFor(() => expect(screen.getByText('1 active')).toBeInTheDocument());
    expect(screen.getByText(/PR #57/)).toBeInTheDocument();
  });

  it('does not count the superseded facets alongside it', async () => {
    // model + developers are set in the URL but inert under the search, so they
    // must not inflate the badge — the badge describes what the numbers reflect.
    renderPage('/prs?pr=57&model=glm-5.2&users=alice@acme.com');
    await waitFor(() => expect(screen.getByText('1 active')).toBeInTheDocument());
  });

  it('keeps the search applied while the bar is collapsed', async () => {
    renderPage('/prs?pr=57&filters=0');
    await waitFor(() => expect(searchQuery()).not.toBeNull());
    expect(screen.getByRole('button', { name: /Filters/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('1 active')).toBeInTheDocument();
  });
});

describe('PR search result state', () => {
  it('names the PR in the empty state when nothing matches', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: [REMOTE] } };
      const q = new URLSearchParams(url.split('?')[1] ?? '');
      const pr = q.get('pr');
      if (!pr) return { data: makeOverview(['claude-opus-4-8', 'glm-5.2']) };
      const none = makeOverview([]);
      return { data: { ...none, period: { from: null, to: null }, prs: [], previous: null } };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/prs?pr=57']}>
          <PrOverviewPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText(/No PR #57 found/);
  });

  it('renders the matched PR through the normal overview layout', async () => {
    renderPage('/prs?pr=57');
    await screen.findByText('Weighted size');
    expect(screen.getByText('Total PRs')).toBeInTheDocument();
    // no delta badge: a comparison window is meaningless for one PR
    expect(screen.getByText('— no prior period')).toBeInTheDocument();
  });
});
