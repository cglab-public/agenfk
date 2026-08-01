/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Layout } from '../components/Layout';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    get: vi.fn((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: { userId: 'u1', orgId: 'o1', role: 'admin' } });
      if (url === '/healthz') return Promise.resolve({ data: { ok: true, version: '1.2.3' } });
      if (url === '/v1/admin/system/pending') return Promise.resolve({ data: { pendingEnvOrgId: null } });
      return Promise.resolve({ data: {} });
    }),
    post: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

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

function renderLayout() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter>
          <Layout><div>content</div></Layout>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

describe('Layout theme toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.documentElement.classList.remove('light', 'dark');
  });

  afterEach(() => cleanup());

  it('renders a theme toggle button in the sidebar', async () => {
    renderLayout();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/auth/me'));
    expect(screen.getByTitle('Switch to dark mode')).toBeDefined();
  });

  it('clicking the toggle switches to dark mode and persists it', async () => {
    renderLayout();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/auth/me'));

    fireEvent.click(screen.getByTitle('Switch to dark mode'));

    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
    expect(screen.getByTitle('Switch to light mode')).toBeDefined();
    expect(localStorage.getItem('hub-theme')).toBe('dark');
  });
});
