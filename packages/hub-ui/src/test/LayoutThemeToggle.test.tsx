/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ThemeProvider } from '../ThemeContext';
import { Layout } from '../components/Layout';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api', () => ({
  api: {
    get: vi.fn().mockImplementation((url: string) => {
      if (url === '/healthz') return Promise.resolve({ data: { ok: true, version: 'test' } });
      if (url === '/auth/me') return Promise.resolve({ data: { userId: 'u1', role: 'admin' } });
      if (url === '/v1/admin/system/pending') return Promise.resolve({ data: { pendingEnvOrgId: null } });
      return Promise.resolve({ data: {} });
    }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function wrap(ui: React.ReactNode) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ThemeProvider>{ui}</ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Layout theme toggle', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a "Switch to Dark Mode" button when theme is light', () => {
    render(wrap(<Layout><div>content</div></Layout>));
    expect(screen.getByTitle(/Switch to Dark Mode/i)).toBeDefined();
  });

  it('flips to dark, persists, and sets the html class + data-theme on click', () => {
    render(wrap(<Layout><div>content</div></Layout>));
    const btn = screen.getByTitle(/Switch to Dark Mode/i);
    fireEvent.click(btn);
    expect(screen.getByTitle(/Switch to Light Mode/i)).toBeDefined();
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});