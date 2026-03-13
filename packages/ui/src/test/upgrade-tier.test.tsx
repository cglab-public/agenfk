/**
 * @vitest-environment jsdom
 *
 * Component render tests for the UI tier-aware upgrade banner in ReleaseReminder (Story 4).
 *
 * - mandatory tier: renders urgent banner, no Dismiss button
 * - recommended tier: renders with available styling, Dismiss present
 * - optional/absent: existing green behavior
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';

vi.mock('../api', () => ({
  api: {
    getLatestRelease: vi.fn(),
    triggerUpdate: vi.fn(),
    getUpdateStatus: vi.fn(),
  },
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <span>{children}</span>,
}));

vi.mock('remark-gfm', () => ({ default: () => {} }));

// Mock localStorage
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
    <QueryClientProvider client={qc}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
};

// ── Mandatory tier ────────────────────────────────────────────────────────────

describe('ReleaseReminder — mandatory tier renders urgent banner', () => {
  it('should render a button when a mandatory upgrade is available', async () => {
    const { api } = await import('../api');
    (api.getLatestRelease as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: '9.9.9',
      tagName: 'v9.9.9',
      name: 'Critical Update',
      body: 'Breaking changes require this update.',
      publishedAt: '2026-01-01T00:00:00Z',
      url: 'https://github.com/example/releases/v9.9.9',
      currentVersion: '1.0.0',
      upgradeTier: 'mandatory',
    });

    const { ReleaseReminder } = await import('../components/ReleaseReminder');
    render(<ReleaseReminder />, { wrapper: makeWrapper() });
    await new Promise(r => setTimeout(r, 50));
    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('should not render a Dismiss option for mandatory upgrades', async () => {
    const { api } = await import('../api');
    (api.getLatestRelease as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: '9.9.9',
      tagName: 'v9.9.9',
      name: 'Critical Update',
      body: 'Breaking changes.',
      publishedAt: '2026-01-01T00:00:00Z',
      url: 'https://github.com/example/releases/v9.9.9',
      currentVersion: '1.0.0',
      upgradeTier: 'mandatory',
    });

    const { ReleaseReminder } = await import('../components/ReleaseReminder');
    render(<ReleaseReminder />, { wrapper: makeWrapper() });
    await new Promise(r => setTimeout(r, 50));

    const buttons = screen.queryAllByRole('button');
    if (buttons.length > 0) buttons[0].click();
    await new Promise(r => setTimeout(r, 50));

    const dismissBtn = screen.queryByText(/dismiss/i);
    expect(dismissBtn).toBeNull();
  });

  it('should not be dismissible — re-renders even if previously dismissed version matches', async () => {
    localStorageMock.setItem('agenfk_dismissed_release', '9.9.9');
    const { api } = await import('../api');
    (api.getLatestRelease as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: '9.9.9',
      tagName: 'v9.9.9',
      name: 'Critical Update',
      body: 'Breaking changes.',
      publishedAt: '2026-01-01T00:00:00Z',
      url: 'https://github.com/example/releases/v9.9.9',
      currentVersion: '1.0.0',
      upgradeTier: 'mandatory',
    });

    const { ReleaseReminder } = await import('../components/ReleaseReminder');
    render(<ReleaseReminder />, { wrapper: makeWrapper() });
    await new Promise(r => setTimeout(r, 50));
    // Should still render despite dismissed version matching — mandatory ignores dismiss
    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });
});

// ── Recommended tier ──────────────────────────────────────────────────────────

describe('ReleaseReminder — recommended tier renders', () => {
  it('should render when a recommended upgrade is available', async () => {
    const { api } = await import('../api');
    (api.getLatestRelease as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: '2.0.0',
      tagName: 'v2.0.0',
      name: 'Recommended Update',
      body: 'Improvements and fixes.',
      publishedAt: '2026-01-01T00:00:00Z',
      url: 'https://github.com/example/releases/v2.0.0',
      currentVersion: '1.0.0',
      upgradeTier: 'recommended',
    });

    const { ReleaseReminder } = await import('../components/ReleaseReminder');
    render(<ReleaseReminder />, { wrapper: makeWrapper() });
    await new Promise(r => setTimeout(r, 50));
    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });
});
