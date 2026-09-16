/**
 * @vitest-environment jsdom
 *
 * Admin → Organization is where a hub's place in the world is configured.
 *
 * It used to hold only the org-id rename, while "who reports to us" (Child
 * hubs) and "who we report to" (Parent hub) sat in two separate tabs — three
 * places for one subject. They are one page now, and the two old URLs still
 * land somewhere sensible so nobody's bookmark dead-ends.
 */
import { render, screen, waitFor, cleanup, within, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '../App';
import { api } from '../api';

// The page chrome is not what this file is about; stubbing it keeps the test
// pinned to the route table and the Organization page's composition.
vi.mock('../components/Layout', () => ({ Layout: ({ children }: any) => <div>{children}</div> }));
vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const CHILD_HUBS = {
  isParent: true,
  childHubs: [{
    id: 'ch-1', name: 'acme-emea', hubVersion: '1.1.19',
    firstSeen: '2026-09-01T10:00:00.000Z', lastSeen: '2026-09-14T10:00:00.000Z',
    live: true, detached: false, detachedAt: null,
  }],
};

const routeData: Record<string, unknown> = {
  '/auth/me': { userId: 'admin@x', orgId: 'acme', role: 'admin' },
  '/auth/providers': { password: true, google: false, entra: false, requiresSetup: false },
  '/healthz': { ok: true, version: '1.1.19' },
  '/v1/admin/federation': { bound: false, outboxDepth: 0 },
  '/v1/admin/child-hubs': CHILD_HUBS,
};

const renderAt = (path: string) => {
  get.mockImplementation(async (url: string) => {
    const key = Object.keys(routeData).find(k => url.startsWith(k));
    return { data: key ? routeData[key] : {} };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => { get.mockReset(); (api.post as unknown as ReturnType<typeof vi.fn>).mockReset(); });
afterEach(() => { cleanup(); get.mockReset(); });

describe('Admin → Organization', () => {
  it('carries the org identity, the parent hub and the child hubs on one page', async () => {
    renderAt('/admin/org');
    expect(await screen.findByRole('heading', { name: /^organization$/i })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /parent hub/i })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /child hubs/i })).toBeInTheDocument();
    // and the sections are live, not headings over nothing
    expect(await screen.findByText('acme-emea')).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: /join token/i })).toBeInTheDocument();
  });

  it('no longer offers Child hubs and Parent hub as their own tabs', async () => {
    renderAt('/admin/org');
    await screen.findByRole('heading', { name: /^organization$/i });
    const nav = screen.getByRole('navigation');
    expect(within(nav).queryByRole('link', { name: /child hubs/i })).toBeNull();
    expect(within(nav).queryByRole('link', { name: /parent hub/i })).toBeNull();
    expect(within(nav).getByRole('link', { name: /organization/i })).toBeInTheDocument();
  });

  it('lands the old Child hubs URL on the child hubs section, not the page top', async () => {
    // The roster is an operational list — rename, detach, "not checking in".
    // Two scrolls into a settings page with no address would be a demotion, so
    // the redirect keeps an anchor that still names it.
    renderAt('/admin/child-hubs');
    await waitFor(() => expect(screen.getByRole('heading', { name: /^organization$/i })).toBeInTheDocument());
    expect(await screen.findByRole('heading', { name: /child hubs/i })).toBeInTheDocument();
    expect(document.getElementById('child-hubs')).not.toBeNull();
  });

  it('lands the old Parent hub URL on the parent hub section', async () => {
    renderAt('/admin/parent-hub');
    await waitFor(() => expect(screen.getByRole('heading', { name: /^organization$/i })).toBeInTheDocument());
    expect(await screen.findByRole('heading', { name: /parent hub/i })).toBeInTheDocument();
    expect(document.getElementById('parent-hub')).not.toBeNull();
  });

  it('still renames the org from the composed page', async () => {
    // Three components on one page: the rename must not have been broken by
    // the two that joined it, nor buried when one of them errors.
    const post = api.post as unknown as ReturnType<typeof vi.fn>;
    renderAt('/admin/org');
    await screen.findByRole('heading', { name: /^organization$/i });
    fireEvent.change(screen.getByPlaceholderText(/new org id/i), { target: { value: 'newcorp' } });
    fireEvent.click(screen.getByRole('button', { name: /^rename$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /rename to newcorp/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/orgs/rename', { from: 'acme', to: 'newcorp' }));
  });

  it('keeps the rename reachable when the federation section fails to load', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/admin/federation')) throw new Error('hub unreachable');
      const key = Object.keys(routeData).find(k => url.startsWith(k));
      return { data: key ? routeData[key] : {} };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/admin/org']}><App /></MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: /^organization$/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/new org id/i)).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load federation status/i);
  });
});
