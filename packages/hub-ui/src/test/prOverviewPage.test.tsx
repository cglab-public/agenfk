/**
 * @vitest-environment jsdom
 *
 * PR Overview — multi-select model filter (story dd3840a8).
 *
 * The page-level contract around the Model facet (the facet mechanics
 * themselves are the shared, already-tested FacetMultiselect component):
 *  - the `model` URL param is a CSV, seeded into a toggle set like projects/developers;
 *  - a legacy single-value `?model=x` link still seeds exactly one selection;
 *  - the DATA query carries the selected models (`model=a,b`), while the
 *    unfiltered OPTIONS query (facet choices) carries no model;
 *  - toggling a model updates the URL (source of truth) and refetches;
 *  - no selection → no model param sent, and the legacy single <select> is gone.
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

function makeOverview(models: string[]) {
  return {
    period: { from: '2026-08-10T00:00:00.000Z', to: '2026-08-22T23:59:59.999Z' },
    buckets: ['xs', 's', 'm', 'l', 'xl'],
    totals: { prs: models.length, sizePoints: models.length * 4, developers: 1, medianBucket: 'xs' },
    resized: { count: 0, grew: 0, shrank: 0 },
    byDay: [],
    byDeveloper: [
      {
        user_key: 'alice@acme.com',
        prs: models.length,
        sizePoints: models.length * 4,
        sizes: { xs: models.length, s: 0, m: 0, l: 0, xl: 0 },
        daily: {},
      },
    ],
    byModel: models.map(m => ({
      model: m,
      harnesses: [],
      prs: 1,
      sizePoints: 4,
      sizes: { xs: 1, s: 0, m: 0, l: 0, xl: 0 },
    })),
    previous: { prs: 1, sizePoints: 4 },
  };
}

const THREE_MODELS = ['claude-opus-4-8', 'glm-5.2', 'gpt-5.2'];

/** Probes the current search string inside the same MemoryRouter. */
function UrlProbe() {
  const [sp] = useSearchParams();
  return <span data-testid="url-probe">{sp.toString()}</span>;
}

const renderPage = (entry: string, models: string[] = THREE_MODELS) => {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/projects')) return { data: { projects: ['acme/api'] } };
    return { data: makeOverview(models) };
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

const overviewUrls = () =>
  get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/v1/prs/overview'));
const qs = (url: string) => new URLSearchParams(url.split('?')[1] ?? '');
const urlNow = () => screen.getByTestId('url-probe').textContent;

beforeEach(() => {
  get.mockReset();
});

afterEach(() => {
  cleanup();
  get.mockReset();
});

describe('PrOverviewPage model multi-select', () => {
  it('seeds the Model facet from a CSV URL param and sends it in the data query', async () => {
    renderPage('/prs?model=claude-opus-4-8,glm-5.2');

    // The Model facet is present (label) and reports two selected values.
    await screen.findByRole('heading', { name: 'Model' });
    await screen.findByRole('button', { name: 'Clear (2)' });

    // The URL write-back must preserve the CSV (join separator), not collapse it.
    // (URLSearchParams percent-encodes the comma in the written-back URL, so
    // compare the parsed value, not the raw text.)
    await waitFor(() =>
      expect(new URLSearchParams(urlNow()).get('model')).toBe('claude-opus-4-8,glm-5.2'),
    );

    // The data query carries both models; the unfiltered options query (facet
    // choices) is also issued WITHOUT a model param.
    const urls = overviewUrls();
    expect(qs(urls[0]).get('model')).toBe('claude-opus-4-8,glm-5.2');
    expect(urls.some(u => qs(u).get('model') === null)).toBe(true);
  });

  it('still honours a legacy single-value ?model= link as one selection', async () => {
    renderPage('/prs?model=glm-5.2');
    await screen.findByRole('heading', { name: 'Model' });
    await screen.findByRole('button', { name: 'Clear (1)' });
    expect(qs(overviewUrls()[0]).get('model')).toBe('glm-5.2');
  });

  it('toggling a selected model off updates the URL and refetches with the reduced filter', async () => {
    renderPage('/prs?model=claude-opus-4-8,glm-5.2');
    await screen.findByRole('button', { name: 'Clear (2)' });

    fireEvent.click(screen.getByRole('button', { name: 'glm-5.2' }));

    await screen.findByRole('button', { name: 'Clear (1)' });
    await waitFor(() => expect(urlNow()).toBe('model=claude-opus-4-8'));
    // The refetched data query carries only the remaining model.
    expect(
      overviewUrls().some(u => qs(u).get('model') === 'claude-opus-4-8'),
    ).toBe(true);
  });

  it('with no model in the URL nothing is selected and no model param is sent', async () => {
    renderPage('/prs');
    await screen.findByRole('heading', { name: 'Model' });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Clear \(\d+\)$/ })).not.toBeInTheDocument();
    });
    const urls = overviewUrls();
    expect(urls.length).toBe(1); // no active filter → no separate options query
    expect(qs(urls[0]).get('model')).toBeNull();
    // The URL write-back must not leave a dangling model param when nothing is selected.
    await waitFor(() => expect(urlNow()).toBe(''));
    // The legacy single-model <select> is gone.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('a developer selection (no model) still triggers the unfiltered options query', async () => {
    renderPage('/prs?developers=alice@acme.com');
    await screen.findByRole('heading', { name: 'Developer' });
    // filtersActive must be true on a developer-only selection: the facet options
    // query (no users, no model) runs alongside the filtered data query.
    await waitFor(() => expect(overviewUrls().length).toBe(2));
    const withUsers = overviewUrls().filter(u => qs(u).get('users') === 'alice@acme.com');
    expect(withUsers.length).toBe(1);
    expect(qs(withUsers[0]).get('model')).toBeNull();
  });

  it('renders the searchable popover path (N selected · N total) with more than six models', async () => {
    const seven = [
      'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5',
      'glm-5.2', 'gpt-5.2', 'gemini-3-flash', 'deepseek-v4',
    ];
    renderPage('/prs?model=gpt-5.2,gemini-3-flash', seven);

    // Popover trigger reports the selection count, and each selected model is
    // a removable chip.
    await screen.findByRole('button', { name: '2 selected · 7 total' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove gpt-5.2' }));

    await screen.findByRole('button', { name: '1 selected · 7 total' });
    await waitFor(() => expect(urlNow()).toBe('model=gemini-3-flash'));
  });
});
