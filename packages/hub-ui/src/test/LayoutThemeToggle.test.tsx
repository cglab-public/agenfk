/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { Layout } from '../components/Layout';

vi.mock('../api', () => ({
  api: {
    get: vi.fn((url: string) => {
      if (url === '/auth/me') {
        return Promise.resolve({ data: { userId: 'u1', orgId: 'o1', role: 'viewer' } });
      }
      if (url === '/healthz') {
        return Promise.resolve({ data: { ok: true, version: '1.0.0' } });
      }
      if (url === '/v1/admin/system/pending') {
        return Promise.resolve({ data: { pendingEnvOrgId: null } });
      }
      return Promise.resolve({ data: {} });
    }),
    post: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

function renderLayout() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ThemeProvider>
          <Layout>
            <div>content</div>
          </Layout>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(cleanup);

describe('Layout theme toggle', () => {
  it('renders a theme toggle button', async () => {
    renderLayout();
    const toggleBtn = await waitFor(() =>
      screen.getByTitle(/switch to (light|dark) mode/i)
    );
    expect(toggleBtn).toBeDefined();
  });

  it('toggles the button title when clicked', async () => {
    renderLayout();
    const toggleBtn = await waitFor(() =>
      screen.getByTitle(/switch to (light|dark) mode/i)
    );
    const beforeTitle = toggleBtn.getAttribute('title');
    fireEvent.click(toggleBtn);
    await waitFor(() => {
      const afterTitle = screen.getByTitle(/switch to (light|dark) mode/i).getAttribute('title');
      expect(afterTitle).not.toBe(beforeTitle);
    });
  });
});