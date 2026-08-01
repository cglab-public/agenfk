/**
 * @vitest-environment jsdom
 *
 * TASK ad468628 — ThemeToggle button in the Layout sidebar footer.
 *
 * Covers the component in isolation plus its integration into Layout, since
 * "the toggle exists" and "the toggle is actually reachable in the hub chrome"
 * are different failures — the latter is what the user sees.
 */
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../ThemeContext';
import { ThemeToggle } from '../components/ThemeToggle';
import { Layout } from '../components/Layout';

vi.mock('../api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url === '/auth/me') return { data: { userId: 'ada@acme.com', orgId: 'org1', role: 'viewer' } };
      if (url === '/healthz') return { data: { ok: true, version: '1.1.14' } };
      return { data: {} };
    }),
    post: vi.fn(async () => ({ data: {} })),
  },
}));

function mockMatchMedia(prefersDark = false) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: prefersDark && query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const renderToggle = () =>
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>
  );

const renderLayout = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ThemeProvider>
          <Layout>
            <div>page body</div>
          </Layout>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
    mockMatchMedia(false);
  });

  afterEach(cleanup);

  it('renders a real button with a stable test id', () => {
    renderToggle();
    const btn = screen.getByTestId('theme-toggle');
    expect(btn.tagName).toBe('BUTTON');
  });

  it('is labelled for screen readers, not icon-only', () => {
    renderToggle();
    // Accessible name must exist and mention the destination mode.
    const btn = screen.getByRole('button', { name: /dark mode/i });
    expect(btn).toBeDefined();
  });

  it('advertises the destination mode in its title while in light mode', () => {
    renderToggle();
    expect(screen.getByTestId('theme-toggle').getAttribute('title')).toMatch(/dark/i);
  });

  it('advertises the destination mode in its title while in dark mode', () => {
    localStorage.setItem('theme', 'dark');
    renderToggle();
    expect(screen.getByTestId('theme-toggle').getAttribute('title')).toMatch(/light/i);
  });

  it('shows the moon icon in light mode and the sun icon in dark mode', () => {
    const { container } = renderToggle();
    // lucide-react renders an <svg> with a class naming the icon.
    expect(container.querySelector('svg')?.getAttribute('class')).toMatch(/moon/i);
    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(container.querySelector('svg')?.getAttribute('class')).toMatch(/sun/i);
  });

  it('flips the document theme when clicked', () => {
    renderToggle();
    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('round-trips back to light on a second click', () => {
    renderToggle();
    const btn = screen.getByTestId('theme-toggle');
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('exposes aria-pressed reflecting whether dark is active', () => {
    renderToggle();
    const btn = screen.getByTestId('theme-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Layout integration', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
    mockMatchMedia(false);
  });

  afterEach(cleanup);

  it('mounts the toggle inside the sidebar footer, next to Sign out', async () => {
    renderLayout();
    const footer = await screen.findByTestId('sidebar-footer');
    expect(within(footer).getByTestId('theme-toggle')).toBeDefined();
    expect(within(footer).getByText(/sign out/i)).toBeDefined();
  });

  it('renders the toggle exactly once in the chrome', () => {
    renderLayout();
    expect(screen.getAllByTestId('theme-toggle')).toHaveLength(1);
  });

  it('still renders page children alongside the toggle', () => {
    renderLayout();
    expect(screen.getByText('page body')).toBeDefined();
    expect(screen.getByTestId('theme-toggle')).toBeDefined();
  });

  it('toggling from within Layout updates <html>', () => {
    renderLayout();
    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
