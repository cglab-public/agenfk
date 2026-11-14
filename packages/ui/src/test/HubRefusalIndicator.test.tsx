/**
 * @vitest-environment jsdom
 *
 * #223: the board's half of the sticky refusal indicator.
 *
 * A machine whose hub refuses every event used to look perfectly healthy on
 * the board. The indicator reads GET /hub/refusals (counts only, derived from
 * the deadletter file, so it survives flushes and restarts) and stays until
 * the deadletter is emptied — or until the viewer dismisses this exact state.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api', () => ({
  api: {
    getHubRefusals: vi.fn(),
  },
}));

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorageMock.clear();
});

const makeWrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
};

const REFUSED = {
  count: 204,
  actionable: 204,
  since: '2026-10-06T22:37:15.885Z',
  reasons: { foreign_installation: 204 },
  unparseable: 0,
  hint: 'This machine\'s hub key is bound to another installation. Ask a hub admin for a new invite, run `agenfk hub join`, then `agenfk hub deadletter requeue`.',
};

async function renderWith(value: unknown) {
  const { api } = await import('../api');
  if (value instanceof Error) (api.getHubRefusals as ReturnType<typeof vi.fn>).mockRejectedValue(value);
  else (api.getHubRefusals as ReturnType<typeof vi.fn>).mockResolvedValue(value);
  const { HubRefusalIndicator } = await import('../components/HubRefusalIndicator');
  render(<HubRefusalIndicator />, { wrapper: makeWrapper() });
  return api;
}

describe('HubRefusalIndicator', () => {
  it('renders nothing when nothing actionable was refused', async () => {
    const api = await renderWith({ count: 3, actionable: 0, since: '2026-10-06T00:00:00Z', reasons: { hidden_user: 3 }, unparseable: 0, hint: null });
    await waitFor(() => expect(api.getHubRefusals).toHaveBeenCalled());
    expect(screen.queryByTestId('hub-refusal-indicator')).toBeNull();
  });

  it('renders nothing when the server cannot answer', async () => {
    const api = await renderWith(new Error('Network Error'));
    await waitFor(() => expect(api.getHubRefusals).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByTestId('hub-refusal-indicator')).toBeNull();
  });

  it('shows the count and since, and the fix once opened', async () => {
    await renderWith(REFUSED);
    const button = await screen.findByTestId('hub-refusal-indicator');
    expect(button.getAttribute('title')).toMatch(/Hub refused 204 event\(s\) since/);
    fireEvent.click(button);
    expect(await screen.findByText(/agenfk hub join/)).toBeTruthy();
    expect(screen.getByText(/foreign_installation/)).toBeTruthy();
  });

  it('dismissing hides it and remembers this exact state', async () => {
    await renderWith(REFUSED);
    fireEvent.click(await screen.findByTestId('hub-refusal-indicator'));
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }));
    await waitFor(() => expect(screen.queryByTestId('hub-refusal-indicator')).toBeNull());
    expect(localStorageMock.getItem('agenfk_dismissed_hub_refusals')).toBe('204|2026-10-06T22:37:15.885Z');
  });

  it('stays dismissed for the same state, and comes back when more events are refused', async () => {
    localStorageMock.setItem('agenfk_dismissed_hub_refusals', '204|2026-10-06T22:37:15.885Z');
    const api = await renderWith(REFUSED);
    await waitFor(() => expect(api.getHubRefusals).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByTestId('hub-refusal-indicator')).toBeNull();

    cleanup();
    await renderWith({ ...REFUSED, count: 210, actionable: 210 });
    expect(await screen.findByTestId('hub-refusal-indicator')).toBeTruthy();
  });
});
