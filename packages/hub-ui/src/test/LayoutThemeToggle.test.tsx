/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from '../components/Layout';

// Layout relies on react-query for /auth/me, /healthz, and the admin-only
// pending banner. Stub the api axios instance so no network is touched.
vi.mock('../api', () => {
  const handlers: Record<string, (url: string) => unknown> = {
    '/auth/me': () => ({ userId: 'viewer@example.com', orgId: 'org-1', role: 'viewer' }),
    '/healthz': () => ({ ok: true, version: '9.9.9' }),
    '/v1/admin/system/pending': () => ({ pendingEnvOrgId: null }),
  };
  const get = vi.fn(async (url: string) => ({ data: (handlers[url] ?? (() => null))(url) }));
  const post = vi.fn(async () => ({ data: {} }));
  return { api: { get, post }, MeResponse: {} };
});

function renderLayout(child: React.ReactNode = <div>page</div>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Layout>{child}</Layout>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
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

  it('renders a theme toggle button in the sidebar', async () => {
    renderLayout();
    // The button exposes its current state via aria-label so it is
    // discoverable by assistive tech and by the test.
    const btn = await screen.findByRole('button', { name: /switch to dark theme/i });
    expect(btn).toBeDefined();
  });

  it('flips the theme from light to dark on click', async () => {
    renderLayout();
    const btn = await screen.findByRole('button', { name: /switch to dark theme/i });
    fireEvent.click(btn);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('theme')).toBe('dark');
    // After flipping to dark, the label offers switching back to light.
    expect(screen.getByRole('button', { name: /switch to light theme/i })).toBeDefined();
  });

  it('flips back from dark to light on a second click', async () => {
    localStorage.setItem('theme', 'dark');
    document.documentElement.classList.add('dark');
    renderLayout();
    const btn = await screen.findByRole('button', { name: /switch to light theme/i });
    fireEvent.click(btn);
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(localStorage.getItem('theme')).toBe('light');
  });
});
