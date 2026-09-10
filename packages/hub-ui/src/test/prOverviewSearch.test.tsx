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
    // The vendor meta-filter stays PRESENT and DISABLED under a search, even
    // though a single PR carries a single model. It used to disappear here, which
    // read as "nothing to filter" but actually hid a live ?model= still sitting
    // in the URL — the agreed contract is disabled and greyed, not hidden.
    expect(screen.getByRole('heading', { name: 'Provider' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Z\.ai/ })).toBeDisabled();
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

describe('Project stays live under the search', () => {
  const OTHER = 'git@github.com:acme/web.git';

  it('re-queries with the newly selected project while the search is active', async () => {
    // Project is the one filter a PR search respects, so changing it has to
    // re-run the search. If it silently stopped being a dependency of the query,
    // the page would keep showing acme/api's #57 with the chip reading acme/web
    // — a stale filter you cannot see.
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: [REMOTE, OTHER] } };
      const q = new URLSearchParams(url.split('?')[1] ?? '');
      const pr = q.get('pr');
      return { data: pr ? makeSearchHit(Number(pr)) : makeOverview(['claude-opus-4-8', 'glm-5.2']) };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/prs?pr=57']}>
          <PrOverviewPage />
          <UrlProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(searchQuery()).not.toBeNull());
    const before = overviewUrls().length;

    fireEvent.click(await screen.findByRole('button', { name: 'acme/web' }));

    await waitFor(() => {
      const after = overviewUrls().slice(before).map(u => qs(u)).filter(q => q.get('pr') === '57');
      expect(after.length).toBeGreaterThan(0);
      expect(after.at(-1)!.get('projects')).toBe(OTHER);
    });
    // …and still no superseded filter rides along. Checked on the request that
    // carries `pr`: while a search is active a second, unfiltered options request
    // runs alongside it (that one legitimately carries the window — it is what
    // keeps the disabled facets populated), so "the last call" is ambiguous.
    expect(qs(searchQuery()!).get('from')).toBeNull();
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

  it('shows EVERY matched PR when one number hits two repos months apart', async () => {
    // The case the owner signed off: with no Project selected, #57 exists once
    // per repo. Two repos means two open dates, and those dates can be further
    // apart than the day axis can span (buildDayAxis caps at 366 columns).
    // Deriving the axis from a date range would then silently drop the later PR
    // from the volume chart AND from the heatmap — so the KPI tile would count 2
    // PRs, the chart would draw 1, and the dropped PR would have no cell to
    // click. The axis must come from the data, not from a window.
    const far = makeOverview(['glm-5.2', 'claude-opus-4-8']);
    const twoRepos = {
      ...far,
      period: { from: '2025-02-10T11:00:00.000Z', to: '2026-04-01T09:00:00.000Z' },
      totals: { prs: 2, sizePoints: 12, developers: 2, medianBucket: 'm' },
      byDay: [
        { day: '2025-02-10', sizes: { xs: 0, s: 0, m: 1, l: 0, xl: 0 }, total: 1, devBySize: { xs: [], s: [], m: [{ user_key: 'bob@acme.com', count: 1 }], l: [], xl: [] } },
        { day: '2026-04-01', sizes: { xs: 0, s: 1, m: 0, l: 0, xl: 0 }, total: 1, devBySize: { xs: [], s: [{ user_key: 'carol@acme.com', count: 1 }], m: [], l: [], xl: [] } },
      ],
      byDeveloper: [
        { user_key: 'bob@acme.com', prs: 1, sizePoints: 8, sizes: { xs: 0, s: 0, m: 1, l: 0, xl: 0 }, daily: { '2025-02-10': 1 } },
        { user_key: 'carol@acme.com', prs: 1, sizePoints: 4, sizes: { xs: 0, s: 1, m: 0, l: 0, xl: 0 }, daily: { '2026-04-01': 1 } },
      ],
      prs: [
        { repo: 'acme/api', prNumber: 57, url: 'https://github.com/acme/api/pull/57', user_key: 'bob@acme.com', model: 'glm-5.2', harness: null, openedAt: '2025-02-10T11:00:00.000Z', day: '2025-02-10', points: 8, bucket: 'm' },
        { repo: 'acme/web', prNumber: 57, url: 'https://github.com/acme/web/pull/57', user_key: 'carol@acme.com', model: 'claude-opus-4-8', harness: null, openedAt: '2026-04-01T09:00:00.000Z', day: '2026-04-01', points: 4, bucket: 's' },
      ],
      previous: null,
    };
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: [REMOTE] } };
      return { data: twoRepos };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/prs?pr=57']}>
          <PrOverviewPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('Weighted size');
    // The volume chart's own total must agree with the KPI tile above it.
    expect(screen.getByText('Total').parentElement).toHaveTextContent('2');
    // And both PRs must be reachable — one drillable cell per matched day.
    expect(screen.getAllByRole('button', { name: /open list/i })).toHaveLength(2);
  });
});

// ── Mutation-sweep hardening (CGLAB-151) ────────────────────────────────────
// The hub-ui sweep (stryker.cglab151.config.mjs) put 954 mutants on these four
// files and 51 survivors landed on lines this story wrote. Each test below is
// aimed at a named survivor. They are not extra coverage of the same behaviour:
// the existing specs set `model=` / `users=` in the URL but never SELECT a facet,
// so `devSel.set.size` was 0 in every render and any mutation of the
// `!searchActive && devSel…` branch was invisible no matter how many assertions
// sat on top of it. Selecting the facet is what makes that branch observable.

describe('Superseded selections stay out of the badge and the summary', () => {
  it('counts a selected developer and model while nothing supersedes them', async () => {
    // Kills the ArithmeticOperator mutants on the badge total (`+` → `-`) and the
    // ConditionalExpression mutants that force the dev/model terms always-on or
    // always-off: with one of each selected the count must be exactly 2.
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'alice@acme.com' }));
    // Each selection re-queries the overview, and the facets unmount while that
    // is in flight — hence findByRole rather than getByRole between clicks.
    fireEvent.click(await screen.findByRole('button', { name: 'glm-5.2' }));

    await waitFor(() => expect(screen.getByText('2 active')).toBeInTheDocument());
    // The summary chips render only while the bar is collapsed (`{!open && …}`),
    // so collapse it to read what the badge is summarising. Singular copy here:
    // with `size === 1` inverted this reads "1 developers".
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    expect(screen.getByText('1 developer')).toBeInTheDocument();
    expect(screen.getByText('1 model')).toBeInTheDocument();
  });

  it('pluralises the summary for two selected models', async () => {
    // The other direction of the same comparison — inverted, two models would
    // read "2 model".
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'glm-5.2' }));
    fireEvent.click(await screen.findByRole('button', { name: 'claude-opus-4-8' }));
    // One filter, two selections — the badge counts filters, not picks.
    await waitFor(() => expect(screen.getByText('1 active')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    await waitFor(() => expect(screen.getByText('2 models')).toBeInTheDocument());
  });

  it('drops both from the badge and the summary the moment a search takes over', async () => {
    // The contract the badge exists to keep: it describes what the numbers
    // reflect. A search supersedes both facets, so a live selection in either
    // must not be counted or listed. `!searchActive` → `searchActive`, or the
    // ternary forced true, would leave the badge reading 3 while the request
    // carries neither param — a badge that lies about an inert filter.
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'alice@acme.com' }));
    fireEvent.click(await screen.findByRole('button', { name: 'glm-5.2' }));
    await waitFor(() => expect(screen.getByText('2 active')).toBeInTheDocument());

    fireEvent.change(searchBox(), { target: { value: '57' } });

    await waitFor(() => expect(screen.getByText('1 active')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    // The page title names the PR too, so this is a count rather than a
    // single-element lookup.
    expect(screen.getAllByText('PR #57').length).toBeGreaterThan(0);
    expect(screen.queryByText('1 developer')).not.toBeInTheDocument();
    expect(screen.queryByText('1 model')).not.toBeInTheDocument();
  });
});

describe('Licence-weight chips follow the same disable rule', () => {
  /** The meta-filter only renders when there is more than one model to sort
   *  through, so these need a multi-PR fixture, not a single-PR search hit. */
  const twoModels = (prs: number) => ({
    ...makeOverview(['claude-opus-4-8', 'glm-5.2']),
    totals: { prs, sizePoints: prs * 4, developers: 1, medianBucket: 'xs' },
  });

  it('disables them while a search is active', async () => {
    // `off = disabled || n === 0` — the provider buttons two tests up are a
    // DIFFERENT control, so nothing covered this row. Dropping `disabled` here
    // leaves a chip that looks clickable while its selection changes nothing.
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: [REMOTE] } };
      const q = new URLSearchParams(url.split('?')[1] ?? '');
      return { data: twoModels(q.get('pr') ? 2 : 2) };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/prs?pr=57']}>
          <PrOverviewPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: /Open weights/ });
    expect(screen.getByRole('button', { name: /Open weights/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Commercial \/ API only/ })).toBeDisabled();
  });

  it('leaves them live when nothing supersedes them', async () => {
    // The `disabled` → `true` mutant: everything off, forever. The counts are
    // non-zero in this fixture, so a live page must show clickable chips.
    renderPage();
    await screen.findByRole('button', { name: /Open weights/ });
    expect(screen.getByRole('button', { name: /Open weights/ })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Commercial \/ API only/ })).not.toBeDisabled();
  });
});

describe('Search URL and axis stay honest', () => {
  it('sends no empty `projects=` when the search runs with no project selected', async () => {
    // The share-link builder writes `projects` only if a project is chosen.
    // Forced on, it emits `projects=` — an empty value a stricter parser could
    // later read as "filter to nothing", on a link the user pastes to a
    // colleague.
    renderPage('/prs?pr=57');
    await waitFor(() => expect(searchQuery()).not.toBeNull());
    expect(urlNow().has('projects')).toBe(false);
    expect(qs(searchQuery()!).has('projects')).toBe(false);
  });

  it('orders the search axis by day even when the API returns the days shuffled', async () => {
    // The search axis is the matched days, not a window (that is what stops a
    // >366-day span silently dropping a PR). Removing the sort left the axis in
    // response order — the chart would draw the right columns in the wrong
    // sequence, and the heatmap header would disagree with its cells.
    const shuffled = makeOverview(['glm-5.2', 'claude-opus-4-8']);
    const two = {
      ...shuffled,
      totals: { prs: 2, sizePoints: 12, developers: 1, medianBucket: 'm' },
      period: { from: '2026-08-11T10:00:00.000Z', to: '2025-02-10T09:00:00.000Z' },
      byDay: [
        { day: '2026-08-11', sizes: { xs: 0, s: 1, m: 0, l: 0, xl: 0 }, total: 1, devBySize: { xs: [], s: [{ user_key: 'alice@acme.com', count: 1 }], m: [], l: [], xl: [] } },
        { day: '2025-02-10', sizes: { xs: 0, s: 0, m: 1, l: 0, xl: 0 }, total: 1, devBySize: { xs: [], s: [], m: [{ user_key: 'alice@acme.com', count: 1 }], l: [], xl: [] } },
      ],
      // ONE developer with cells on both days: the drill buttons then appear in
      // axis order. With two developers the order is the developer list's, and
      // the assertion would measure the wrong thing.
      byDeveloper: [
        { user_key: 'alice@acme.com', prs: 2, sizePoints: 12, sizes: { xs: 0, s: 1, m: 1, l: 0, xl: 0 }, daily: { '2026-08-11': 1, '2025-02-10': 1 } },
      ],
      prs: [
        { repo: 'acme/api', prNumber: 57, url: 'https://github.com/acme/api/pull/57', user_key: 'alice@acme.com', model: 'glm-5.2', harness: null, openedAt: '2026-08-11T10:00:00.000Z', day: '2026-08-11', points: 4, bucket: 's' },
        { repo: 'acme/web', prNumber: 57, url: 'https://github.com/acme/web/pull/57', user_key: 'alice@acme.com', model: 'claude-opus-4-8', harness: null, openedAt: '2025-02-10T09:00:00.000Z', day: '2025-02-10', points: 8, bucket: 'm' },
      ],
      previous: null,
    };
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: [REMOTE] } };
      return { data: two };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/prs?pr=57']}>
          <PrOverviewPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('Weighted size');
    const days = screen.getAllByRole('button', { name: /open list/i })
      .map(c => (c.getAttribute('aria-label') ?? '').match(/on (\d{4}-\d{2}-\d{2})/)?.[1] ?? '');
    expect(days).toHaveLength(2);
    expect(days).toEqual([...days].sort());
  });

  it('shows the clear affordance only when there is something to clear', async () => {
    // `{prQuery !== '' && <button …Clear PR search…>}` — forced false the box
    // can never be cleared; forced true it shows a ✕ that does nothing.
    renderPage();
    await screen.findByRole('button', { name: '90d' });
    expect(screen.queryByRole('button', { name: 'Clear PR search' })).not.toBeInTheDocument();

    fireEvent.change(searchBox(), { target: { value: '57' } });
    expect(screen.getByRole('button', { name: 'Clear PR search' })).toBeInTheDocument();
  });
});

// ── Adversarial-review fixes (CGLAB-151) ────────────────────────────────────
// Two MAJOR findings from the review of the finished feature. Neither was a bug
// in the parser or the SQL — they were what the page DOES around it.

describe('Typing does not machine-gun the API', () => {
  it('fires one search for a typed number, not one per keystroke', async () => {
    // A PR search deliberately carries no time bound, so every committed query
    // key is a scan of the org's whole PR event stream. Typing "1234" without a
    // debounce is four of those to answer one question — plus four teardowns of
    // the results tree while the user watches.
    renderPage();
    await screen.findByRole('button', { name: '90d' });

    const box = searchBox();
    for (const ch of '1234') fireEvent.change(box, { target: { value: box.value + ch } });

    // The box keeps up with the keyboard…
    expect(searchBox().value).toBe('1234');
    // …the request waits for a pause instead.
    expect(overviewUrls().filter(u => qs(u).get('pr')).length).toBe(0);

    await waitFor(() => expect(searchQuery()).not.toBeNull());
    expect(overviewUrls().filter(u => qs(u).get('pr')).length).toBe(1);
    expect(qs(searchQuery()!).get('pr')).toBe('1234');
  });
});

describe('Superseded facets stay on screen', () => {
  it('keeps the facets and their selection visible when the search misses', async () => {
    // The answer to a miss contains no models and no developers. Sourcing the
    // facets from it therefore HIDES both controls — while ?model= and
    // ?developers= are still in force and snap back the moment the search is
    // cleared. A live filter with no control to see or clear it is the opposite
    // of the agreed "disabled and greyed, not hidden".
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: [REMOTE] } };
      const q = new URLSearchParams(url.split('?')[1] ?? '');
      if (q.get('pr')) {
        const none = makeOverview([]);
        return {
          data: {
            ...none, period: { from: null, to: null }, prs: [],
            byDeveloper: [], byModel: [], previous: null,
          },
        };
      }
      return { data: makeOverview(['claude-opus-4-8', 'glm-5.2']) };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/prs?pr=999&model=glm-5.2&developers=alice@acme.com']}>
          <PrOverviewPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText(/No PR #999 found/);

    expect(screen.getByRole('button', { name: 'glm-5.2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'alice@acme.com' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'acme/api' })).not.toBeDisabled();
    expect(screen.queryByText(/do not apply/i)).toBeInTheDocument();
  });

  it('renders a selected value that is not in the option list', async () => {
    // A hit has exactly one developer and one model, so a selection made before
    // the search is not in `options` any more. The flat layout rendered `options`
    // only, which left the header reading "Clear (1)" above chips that did not
    // include the thing selected — a control misreporting its own state.
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: [REMOTE] } };
      const q = new URLSearchParams(url.split('?')[1] ?? '');
      if (q.get('pr')) return { data: makeSearchHit(57) };
      return { data: makeOverview(['claude-opus-4-8', 'glm-5.2']) };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/prs?pr=57&developers=carol@acme.com']}>
          <PrOverviewPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('Weighted size');
    // carol never appears in the answer (bob opened #57), yet her selection is
    // still live — so she must be on screen.
    expect(screen.getByRole('button', { name: 'carol@acme.com' })).toBeInTheDocument();
  });
});
