/**
 * @vitest-environment jsdom
 *
 * Org-level flow adherence in the hub UI (CGLAB-615). The page reads S3's
 * GET /v1/adherence and must behave like every other filtered hub view: the
 * URL is the source of truth, the shared facet components drive the request
 * query string, and "nothing judged" is said out loud rather than rendered as
 * a bare 0%.
 */
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdherencePage } from '../pages/Adherence';
import { Layout } from '../components/Layout';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const ADHERENCE = {
  judged: 37,
  compliant: 30,
  score: 30 / 37,
  series: [
    { day: '2026-05-03', judged: 12, compliant: 10, score: 10 / 12 },
    { day: '2026-05-04', judged: 25, compliant: 20, score: 0.8 },
    { day: '2026-05-05', judged: 0, compliant: 0, score: null },
  ],
};
const NOTHING_JUDGED = { judged: 0, compliant: 0, score: null, series: [{ day: '2026-05-03', judged: 0, compliant: 0, score: null }] };

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/adherence')) return { data: url.includes('projects=') ? NOTHING_JUDGED : ADHERENCE };
    if (url.startsWith('/v1/event-types')) return { data: { types: ['step.transitioned', 'item.closed'] } };
    if (url.startsWith('/v1/projects')) return { data: { projects: ['git@x:web.git', 'git@x:api.git'] } };
    if (url.startsWith('/v1/item-types')) return { data: { itemTypes: ['TASK'], counts: {} } };
    if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
    if (url.startsWith('/v1/people/names')) return { data: { names: {} } };
    if (url.startsWith('/auth/me')) return { data: { userId: 'admin@x', email: 'admin@x' } };
    if (url.startsWith('/healthz')) return { data: { ok: true, version: 'test' } };
    return { data: {} };
  });
  try { window.localStorage.clear(); } catch { /* blocked */ }
});
afterEach(() => cleanup());

const renderAt = (entry: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/adherence" element={<Layout><AdherencePage /></Layout>} />
            <Route path="/" element={<Layout><div data-testid="home" /></Layout>} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
};

const adherenceCalls = () => get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/v1/adherence'));

describe('AdherencePage', () => {
  it('renders the score, judged and off-flow counts', async () => {
    renderAt('/adherence');
    expect(await screen.findByText('81%')).toBeInTheDocument();
    expect(screen.getByText('37')).toBeInTheDocument(); // judged
    expect(screen.getByText('7')).toBeInTheDocument(); // 37 - 30 off-flow
  });

  it('states the window had nothing judged instead of rendering 0%', async () => {
    renderAt('/adherence?projects=git@x:web.git');
    expect(await screen.findByText(/nothing was judged/i)).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('sends the shared filters on the adherence request (filter parity)', async () => {
    renderAt('/adherence?projects=git%40x%3Aweb.git&itemTypes=TASK&childHubId=child-1');
    await screen.findByText(/nothing was judged/i);
    const url = adherenceCalls().at(-1)!;
    // `from` is derived from the range preset (the Org page's rule), not read
    // from the URL — but it is always sent.
    for (const part of ['projects=git%40x%3Aweb.git', 'itemTypes=TASK', 'childHubId=child-1', 'from=']) {
      expect(url).toContain(part);
    }
  });

  it('sends the event-type selection too, and says why a window of it judges nothing', async () => {
    renderAt('/adherence?projects=git%40x%3Aweb.git&types=validate.passed');
    await screen.findByText(/only step changed transitions are judged/i);
    expect(adherenceCalls().at(-1)!).toContain('types=validate.passed');
  });

  it('breaks the score down by day, with an em dash for a day that judged nothing', async () => {
    renderAt('/adherence');
    await screen.findByText('81%');
    expect(screen.getByText('2026-05-03')).toBeInTheDocument();
    expect(screen.getByText('2026-05-05')).toBeInTheDocument();
    // The nothing-judged day renders the explicit em dash + sr-only text.
    expect(screen.getAllByTitle('nothing judged').length).toBeGreaterThan(0);
  });

  it('is reachable from the dashboard nav', async () => {
    renderAt('/');
    expect(await screen.findByRole('link', { name: /flow adherence/i })).toHaveAttribute('href', '/adherence');
  });
});
