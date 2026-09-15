/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrOverviewPage } from '../pages/PrOverview';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const ALPHA = '9f1c7e2a-0000-4000-8000-000000000001';
const BETA = '9f1c7e2a-0000-4000-8000-000000000002';
const FACET = { childHubs: [{ id: ALPHA, name: 'alpha', detached: false, events: 12 }, { id: BETA, name: 'beta', detached: false, events: 3 }], hasLocal: true };
const OVERVIEW = {
  period: { from: '2026-08-10T00:00:00.000Z', to: '2026-08-22T23:59:59.999Z' },
  buckets: ['xs', 's', 'm', 'l', 'xl'],
  totals: { prs: 1, sizePoints: 4, developers: 1, medianBucket: 'xs' },
  resized: { count: 0, grew: 0, shrank: 0 }, byDay: [],
  byDeveloper: [{ user_key: 'alice@acme.com', prs: 1, sizePoints: 4, sizes: { xs: 1, s: 0, m: 0, l: 0, xl: 0 }, daily: {} }],
  byModel: [{ model: 'claude-opus-5', harnesses: [], prs: 1, sizePoints: 4, sizes: { xs: 1, s: 0, m: 0, l: 0, xl: 0 } }],
  prs: [], previous: null,
};
function Probe({ push }: { push?: string }) {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const loc = useLocation();
  return (<>
    <span data-testid="url">{sp.toString()}</span>
    <span data-testid="hash">{loc.hash}</span>
    <button onClick={() => nav(-1)}>go-back</button>
    <button onClick={() => nav(1)}>go-fwd</button>
    <button onClick={() => nav(-2)}>go-back-2</button>
    <button onClick={() => nav(push ?? '/prs')}>do-push</button>
    <button onClick={() => nav('/prs#chart')}>push-hash</button>
  </>);
}
const renderAt = (entries: string[], index: number, push?: string) => {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/child-hubs')) return { data: FACET };
    if (url.startsWith('/v1/projects')) return { data: { projects: ['acme/api'] } };
    return { data: OVERVIEW };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={entries} initialIndex={index}>
        <PrOverviewPage /><Probe push={push} />
      </MemoryRouter>
    </QueryClientProvider>);
};
const url = () => new URLSearchParams(screen.getByTestId('url').textContent ?? '');
const overviewQueries = () => get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/v1/prs/overview')).map(u => new URLSearchParams(u.split('?')[1] ?? ''));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'));
  get.mockReset();
  try { window.localStorage.clear(); } catch { /**/ }
});
afterEach(() => { cleanup(); vi.useRealTimers(); get.mockReset(); });

describe('probe', () => {
  it('A: PUSH to /prs while mounted — do the scalars follow?', async () => {
    renderAt(['/prs?range=7d&childHubId=' + ALPHA], 0, '/prs');
    await waitFor(() => expect(url().get('range')).toBe('7d'));
    fireEvent.click(screen.getByText('do-push'));
    await new Promise(r => setTimeout(r, 60));
    console.log('A final url:', screen.getByTestId('url').textContent);
  });

  it('A2: PUSH to /prs?range=today&gran=weekly while mounted', async () => {
    renderAt(['/prs?range=7d'], 0, '/prs?range=today&gran=weekly&childHubId=' + ALPHA);
    await waitFor(() => expect(url().get('range')).toBe('7d'));
    fireEvent.click(screen.getByText('do-push'));
    await new Promise(r => setTimeout(r, 60));
    console.log('A2 final url:', screen.getByTestId('url').textContent);
  });

  it('B: Forward after Back', async () => {
    renderAt(['/prs?range=7d', '/prs?range=90d'], 1);
    await waitFor(() => expect(url().get('range')).toBe('90d'));
    fireEvent.click(screen.getByText('go-back'));
    await waitFor(() => expect(url().get('range')).toBe('7d'));
    await new Promise(r => setTimeout(r, 30));
    fireEvent.click(screen.getByText('go-fwd'));
    await new Promise(r => setTimeout(r, 60));
    console.log('B after forward:', screen.getByTestId('url').textContent);
  });

  it('C: two pops in a row', async () => {
    renderAt(['/prs?range=today', '/prs?range=7d', '/prs?range=90d'], 2);
    await waitFor(() => expect(url().get('range')).toBe('90d'));
    fireEvent.click(screen.getByText('go-back'));
    await waitFor(() => expect(url().get('range')).toBe('7d'));
    await new Promise(r => setTimeout(r, 30));
    fireEvent.click(screen.getByText('go-back'));
    await new Promise(r => setTimeout(r, 80));
    console.log('C after 2nd back:', screen.getByTestId('url').textContent);
  });

  it('C2: nav(-2) multi-step jump', async () => {
    renderAt(['/prs?range=today', '/prs?range=7d', '/prs?range=90d'], 2);
    await waitFor(() => expect(url().get('range')).toBe('90d'));
    fireEvent.click(screen.getByText('go-back-2'));
    await new Promise(r => setTimeout(r, 80));
    console.log('C2 after nav(-2):', screen.getByTestId('url').textContent);
  });

  it('D: pop changing facet and scalar in opposite directions', async () => {
    renderAt([`/prs?range=90d`, `/prs?childHubId=${BETA}&range=7d`], 1);
    await waitFor(() => expect(url().get('range')).toBe('7d'));
    const before = overviewQueries().length;
    fireEvent.click(screen.getByText('go-back'));
    await new Promise(r => setTimeout(r, 80));
    console.log('D final url:', screen.getByTestId('url').textContent);
    console.log('D queries after pop:', overviewQueries().slice(before).map(q => q.toString()));
  });

  it('E: ?pr= combined with range', async () => {
    renderAt(['/prs?range=90d', '/prs?pr=57&range=7d'], 1);
    await waitFor(() => expect(url().get('pr')).toBe('57'));
    const before = overviewQueries().length;
    fireEvent.click(screen.getByText('go-back'));
    await new Promise(r => setTimeout(r, 500));
    console.log('E final url:', screen.getByTestId('url').textContent);
    console.log('E queries after pop:', overviewQueries().slice(before).map(q => q.toString()));
  });

  it('F: hash survives?', async () => {
    renderAt(['/prs?range=7d'], 0);
    await waitFor(() => expect(url().get('range')).toBe('7d'));
    fireEvent.click(screen.getByText('push-hash'));
    await new Promise(r => setTimeout(r, 60));
    console.log('F hash:', JSON.stringify(screen.getByTestId('hash').textContent), 'url:', screen.getByTestId('url').textContent);
  });

  it('G: pop to explicit from/to from a preset range', async () => {
    renderAt(['/prs?from=2026-01-01&to=2026-01-31&range=7d', '/prs?range=90d'], 1);
    await waitFor(() => expect(url().get('range')).toBe('90d'));
    fireEvent.click(screen.getByText('go-back'));
    await new Promise(r => setTimeout(r, 80));
    console.log('G final url:', screen.getByTestId('url').textContent);
  });
});
