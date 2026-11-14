/**
 * @vitest-environment jsdom
 *
 * BUG f44b1128 / CGLAB-354 — the sidebar footer printed the raw user id, so
 * every signed-in user showed up as a UUID. It must show who you are, and
 * degrade sensibly when the identity provider gave us less to work with.
 */
import { render, screen, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../ThemeContext';
import { Layout } from '../components/Layout';

let meResponse: any = {};

vi.mock('../api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url === '/auth/me') return { data: meResponse };
      if (url === '/healthz') return { data: { ok: true, version: '1.1.20' } };
      return { data: {} };
    }),
    post: vi.fn(async () => ({ data: {} })),
  },
}));

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

const footer = () => within(screen.getByTestId('sidebar-footer'));

describe('sidebar “Signed in” identity', () => {
  beforeEach(() => {
    meResponse = {};
  });
  afterEach(cleanup);

  it('shows the display name when the provider gave us one', async () => {
    meResponse = {
      userId: 'efcb8233-248f-4258-a104-0d9f2b6a1f77',
      orgId: 'cglab',
      role: 'admin',
      email: 'leonardo.silva@cglab.com',
      name: 'Leonardo Rosa da Silva',
    };
    renderLayout();
    expect(await footer().findByText('Leonardo Rosa da Silva')).toBeTruthy();
    // The UUID must not be what identifies the user any more.
    expect(footer().queryByText(/efcb8233/)).toBeNull();
  });

  it('falls back to the email when there is no name', async () => {
    meResponse = {
      userId: 'efcb8233-248f-4258-a104-0d9f2b6a1f77',
      orgId: 'cglab',
      role: 'admin',
      email: 'leonardo.silva@cglab.com',
      name: null,
    };
    renderLayout();
    expect(await footer().findByText('leonardo.silva@cglab.com')).toBeTruthy();
    expect(footer().queryByText(/efcb8233/)).toBeNull();
  });

  it('falls back to the user id only when neither name nor email is available', async () => {
    meResponse = {
      userId: 'efcb8233-248f-4258-a104-0d9f2b6a1f77',
      orgId: 'cglab',
      role: 'admin',
    };
    renderLayout();
    expect(await footer().findByText('efcb8233-248f-4258-a104-0d9f2b6a1f77')).toBeTruthy();
  });

  it('still shows the role next to the identity', async () => {
    meResponse = {
      userId: 'u-1',
      orgId: 'cglab',
      role: 'admin',
      email: 'leonardo.silva@cglab.com',
      name: 'Leonardo Rosa da Silva',
    };
    renderLayout();
    expect(await footer().findByText('Leonardo Rosa da Silva')).toBeTruthy();
    expect(footer().getByText('admin')).toBeTruthy();
  });
});
