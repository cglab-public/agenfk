/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../ThemeContext';
import { Layout } from '../components/Layout';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Layout pulls /auth/me, /healthz and (as admin) /v1/admin/system/pending.
vi.mock('../api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url === '/auth/me') return { data: { userId: 'user-1', orgId: 'org-1', role: 'admin' } };
      if (url === '/healthz') return { data: { ok: true, version: '9.9.9' } };
      if (url === '/v1/admin/system/pending') return { data: { pendingEnvOrgId: null } };
      return { data: null };
    }),
    post: vi.fn(async () => ({ data: null })),
  },
}));

function mockOsPreference(dark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' ? dark : false,
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

const html = () => document.documentElement;

function Probe() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button data-testid="toggle" onClick={toggleTheme}>toggle</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  html().classList.remove('light', 'dark');
  html().removeAttribute('data-theme');
});

describe('ThemeProvider', () => {
  it('defaults to dark when the OS prefers dark and nothing is saved', () => {
    mockOsPreference(true);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(html().classList.contains('dark')).toBe(true);
    expect(html().classList.contains('light')).toBe(false);
    expect(html().getAttribute('data-theme')).toBe('dark');
  });

  it('defaults to light when the OS prefers light and nothing is saved', () => {
    mockOsPreference(false);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(html().classList.contains('light')).toBe(true);
    expect(html().getAttribute('data-theme')).toBe('light');
  });

  it('prefers the saved theme over the OS preference', () => {
    mockOsPreference(false);
    localStorage.setItem('theme', 'dark');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(html().classList.contains('dark')).toBe(true);
    expect(html().getAttribute('data-theme')).toBe('dark');
  });

  it('falls back to the OS preference when the saved value is invalid', () => {
    mockOsPreference(true);
    localStorage.setItem('theme', 'neon');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('toggleTheme flips the html class, data-theme and persists the choice', () => {
    mockOsPreference(true);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(html().classList.contains('dark')).toBe(true);

    fireEvent.click(screen.getByTestId('toggle'));
    expect(html().classList.contains('light')).toBe(true);
    expect(html().classList.contains('dark')).toBe(false);
    expect(html().getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');

    fireEvent.click(screen.getByTestId('toggle'));
    expect(html().classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('theme')).toBe('dark');
  });
});

describe('Layout theme toggle', () => {
  function renderLayout() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <ThemeProvider>
        <QueryClientProvider client={qc}>
          <MemoryRouter>
            <Layout><div data-testid="page">content</div></Layout>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );
  }

  it('shows a toggle in the sidebar (dark initial) and switches to light on click', () => {
    mockOsPreference(true);
    renderLayout();
    const btn = screen.getByTitle('Switch to Light Mode');
    fireEvent.click(btn);
    expect(html().classList.contains('light')).toBe(true);
    expect(html().getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
    expect(screen.getByTitle('Switch to Dark Mode')).toBeTruthy();
  });

  it('shows a toggle in the sidebar (light initial) and switches to dark on click', () => {
    mockOsPreference(false);
    renderLayout();
    const btn = screen.getByTitle('Switch to Dark Mode');
    fireEvent.click(btn);
    expect(html().classList.contains('dark')).toBe(true);
    expect(html().getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
  });
});
