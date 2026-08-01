/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { Layout } from '../components/Layout';
import { describe, it, expect, vi, afterEach } from 'vitest';

// ── mock matchMedia (required by ThemeContext) ──────────────────
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// ── mock the api module so Layout's queries resolve ──────────────
vi.mock('../api', () => ({
  api: {
    get: vi.fn((url: string) => {
      if (url === '/auth/me') {
        return Promise.resolve({ data: { userId: 'u1', role: 'admin' } });
      }
      if (url === '/healthz') {
        return Promise.resolve({ data: { ok: true, version: '1.0.0' } });
      }
      if (url === '/v1/admin/system/pending') {
        return Promise.resolve({ data: { pendingEnvOrgId: null } });
      }
      return Promise.resolve({ data: null });
    }),
    post: vi.fn(() => Promise.resolve({ data: null })),
  },
}));

describe('LayoutThemeToggle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the theme-toggle inside the sidebar', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThemeProvider>
            <Layout>
              <div>page content</div>
            </Layout>
          </ThemeProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Wait for react-query to settle and the sidebar to populate.
    await waitFor(() => {
      const toggle = screen.queryByTestId('theme-toggle');
      expect(toggle).not.toBeNull();
    });
  });
});