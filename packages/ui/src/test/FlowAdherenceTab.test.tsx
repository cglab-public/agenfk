/**
 * @vitest-environment jsdom
 *
 * CGLAB-610 — the card's Flow Adherence tab: the % from versioned events only,
 * with judged counts, and an explicit no-score state when nothing is judgeable.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FlowAdherenceTab } from '../components/FlowAdherenceTab';
import { api } from '../api';
import { guardTokens } from './helpers/tokenGuard';

vi.mock('../api', () => ({ api: { getFlowAdherence: vi.fn() } }));

function show(data: unknown) {
  vi.mocked(api.getFlowAdherence).mockResolvedValue(data as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><FlowAdherenceTab itemId="c1" /></QueryClientProvider>);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());
guardTokens();

describe('FlowAdherenceTab', () => {
  it('shows the score as a percentage with judged counts', async () => {
    show({ judged: 4, compliant: 3, score: 0.75, unresolved: 0, unstamped: 2 });
    expect(await screen.findByText('75%')).toBeDefined();
    expect(screen.getByText(/4 versioned transitions judged/i)).toBeDefined();
  });

  it('shows an explicit no-score state when nothing is judgeable', async () => {
    show({ judged: 0, compliant: 0, score: null, unresolved: 0, unstamped: 3 });
    expect(await screen.findByText(/No versioned transitions to score yet/i)).toBeDefined();
    expect(screen.getByText(/3 transitions without a flow version/i)).toBeDefined();
  });

  it('shows an error message, not an endless loading state, when the fetch fails', async () => {
    vi.mocked(api.getFlowAdherence).mockRejectedValue(new Error('boom'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><FlowAdherenceTab itemId="c1" /></QueryClientProvider>);
    expect(await screen.findByText(/Could not load this card's flow adherence/i)).toBeDefined();
  });

  it('reports unresolvable revisions separately', async () => {
    show({ judged: 1, compliant: 1, score: 1, unresolved: 2, unstamped: 0 });
    expect(await screen.findByText('100%')).toBeDefined();
    expect(screen.getByText(/2 transitions name a flow revision that no longer exists/i)).toBeDefined();
  });
});
