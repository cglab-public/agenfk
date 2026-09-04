/**
 * @vitest-environment jsdom
 *
 * PR Overview — filter accordion + model meta-filter (CGLAB-133 follow-up).
 *
 * Two behaviours are load-bearing and are what these tests defend:
 *  - Collapsing the accordion does NOT deactivate the filters, and the collapsed
 *    summary says how many are active — otherwise a hidden filter silently
 *    changes the numbers with no visible cause.
 *  - The meta-filter writes plain model ids into the existing `?model=` CSV, so
 *    a shared link restores the same view and the server sees nothing new.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrOverviewPage } from '../pages/PrOverview';
import { FilterAccordion, parseFiltersOpen } from '../components/FilterAccordion';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const MODELS = ['claude-opus-4-8', 'glm-5.2', 'qwen3.8-27b', 'qwen3.8-max'];

function makeOverview(models: string[]) {
  return {
    period: { from: '2026-08-10T00:00:00.000Z', to: '2026-08-22T23:59:59.999Z' },
    buckets: ['xs', 's', 'm', 'l', 'xl'],
    totals: { prs: models.length, sizePoints: models.length * 4, developers: 1, medianBucket: 'xs' },
    resized: { count: 0, grew: 0, shrank: 0 },
    byDay: [],
    byDeveloper: [{ user_key: 'alice@acme.com', prs: models.length, sizePoints: models.length * 4, sizes: { xs: models.length, s: 0, m: 0, l: 0, xl: 0 }, daily: {} }],
    byModel: models.map(m => ({ model: m, harnesses: [], prs: 1, sizePoints: 4, sizes: { xs: 1, s: 0, m: 0, l: 0, xl: 0 } })),
    previous: { prs: 1, sizePoints: 4 },
  };
}

function UrlProbe() {
  const [sp] = useSearchParams();
  return <span data-testid="url-probe">{sp.toString()}</span>;
}

const renderPage = (entry = '/prs') => {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/projects')) return { data: { projects: ['acme/api'] } };
    return { data: makeOverview(MODELS) };
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
/**
 * The page issues TWO overview queries: the data query (carries model/users) and
 * an unfiltered options query that deliberately omits them so the facet can list
 * every model in the window. Asserting on "the last call" therefore picks up the
 * options query and sees no model param — find the data query by its param
 * instead.
 */
const dataQueryModel = () => {
  for (const u of overviewUrls()) {
    const m = qs(u).get('model');
    if (m) return m;
  }
  return null;
};

beforeEach(() => get.mockReset());
afterEach(() => { cleanup(); get.mockReset(); });

describe('parseFiltersOpen', () => {
  it('is open by default — hiding filters on first visit would be a regression', () => {
    expect(parseFiltersOpen(null)).toBe(true);
    expect(parseFiltersOpen('')).toBe(true);
    expect(parseFiltersOpen('1')).toBe(true);
    expect(parseFiltersOpen('garbage')).toBe(true);
  });
  it('collapses only on an explicit false', () => {
    expect(parseFiltersOpen('0')).toBe(false);
    expect(parseFiltersOpen('false')).toBe(false);
  });
});

describe('FilterAccordion', () => {
  it('renders its children open by default', () => {
    render(
      <FilterAccordion activeCount={0} activeSummary={[]} initialOpen onOpenChange={() => {}}>
        <p>facet-body</p>
      </FilterAccordion>,
    );
    expect(screen.getByText('facet-body')).toBeVisible();
    expect(screen.getByRole('button', { name: /Filters/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('hides the body when collapsed but keeps the toggle reachable', () => {
    render(
      <FilterAccordion activeCount={0} activeSummary={[]} initialOpen={false} onOpenChange={() => {}}>
        <p>facet-body</p>
      </FilterAccordion>,
    );
    // `hidden` (not just visually collapsed) — a hidden-but-focusable control is
    // a keyboard trap.
    expect(screen.getByText('facet-body').closest('[hidden]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Filters/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('reports the active count so a collapsed bar cannot hide that filters apply', () => {
    render(
      <FilterAccordion activeCount={2} activeSummary={['2 models']} initialOpen={false} onOpenChange={() => {}}>
        <p>facet-body</p>
      </FilterAccordion>,
    );
    expect(screen.getByText('2 active')).toBeInTheDocument();
    expect(screen.getByText('2 models')).toBeInTheDocument();
  });

  it('calls onOpenChange so the caller can persist the state to the URL', () => {
    const onOpenChange = vi.fn();
    render(
      <FilterAccordion activeCount={0} activeSummary={[]} initialOpen onOpenChange={onOpenChange}>
        <p>facet-body</p>
      </FilterAccordion>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('PR Overview filters in the accordion', () => {
  it('shows the facets open by default', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Model' });
    expect(screen.getByRole('button', { name: /Filters/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps filters APPLIED while collapsed and writes filters=0 to the URL', async () => {
    renderPage('/prs?model=glm-5.2');
    await screen.findByRole('heading', { name: 'Model' });

    // Collapse.
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));

    await waitFor(() => expect(urlNow().get('filters')).toBe('0'));

    // The model filter is still in the data query — collapsed != inactive.
    await waitFor(() => expect(dataQueryModel()).toBe('glm-5.2'));

    // And the collapsed summary says so.
    expect(screen.getByText('1 active')).toBeInTheDocument();
  });

  it('restores a collapsed bar from the URL', async () => {
    renderPage('/prs?filters=0');
    await screen.findByRole('button', { name: /Filters/ });
    expect(screen.getByRole('button', { name: /Filters/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('omits the filters param when open, so the common URL stays clean', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Model' });
    await waitFor(() => expect(urlNow().get('filters')).toBeNull());
  });
});

describe('PR Overview model meta-filter', () => {
  it('renders provider and weights chips', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Provider' });
    expect(screen.getByRole('button', { name: /^Anthropic/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Z\.ai/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open weights/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Commercial \/ API only/ })).toBeInTheDocument();
  });

  it('adds the vendor’s models to the model CSV (client-side, no new API param)', async () => {
    renderPage();
    // Alibaba owns both qwen models in the fixture.
    fireEvent.click(await screen.findByRole('button', { name: /^Alibaba/ }));

    await waitFor(() => {
      const m = (urlNow().get('model') ?? '').split(',').sort();
      expect(m).toEqual(['qwen3.8-27b', 'qwen3.8-max']);
    });

    // The server saw a plain model CSV — nothing meta-specific.
    await waitFor(() => {
      const sent = dataQueryModel()?.split(',').sort();
      expect(sent).toEqual(['qwen3.8-27b', 'qwen3.8-max']);
    });
  });

  it('splits one family by license class — the reason the seed is artifact-level', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Open weights/ }));
    await waitFor(() => {
      const m = (urlNow().get('model') ?? '').split(',').sort();
      // glm + qwen3.8-27b are open; claude and qwen3.8-max are not.
      expect(m).toEqual(['glm-5.2', 'qwen3.8-27b']);
    });
  });

  it('never drops models the user picked individually', async () => {
    renderPage('/prs?model=claude-opus-4-8');
    fireEvent.click(await screen.findByRole('button', { name: /Open weights/ }));
    await waitFor(() => {
      const m = (urlNow().get('model') ?? '').split(',').sort();
      expect(m).toEqual(['claude-opus-4-8', 'glm-5.2', 'qwen3.8-27b']);
    });
  });

  it('disables a vendor with nothing left to add rather than hiding it', async () => {
    renderPage('/prs?model=claude-opus-4-8');
    const anthropic = await screen.findByRole('button', { name: /^Anthropic/ });
    await waitFor(() => expect(anthropic).toBeDisabled());
  });

  it('is hidden when there is nothing to meta-filter', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: ['acme/api'] } };
      return { data: makeOverview(['solo-model']) };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/prs']}>
          <PrOverviewPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole('heading', { name: 'Model' });
    expect(screen.queryByRole('heading', { name: 'Provider' })).not.toBeInTheDocument();
  });
});
