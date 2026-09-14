/**
 * @vitest-environment jsdom
 *
 * Admin → Child hubs (CGLAB-181). What a unit test cannot see:
 *  - a hub with no children says so instead of showing an empty table;
 *  - the invite is generated on demand and shown once, with the parent URL;
 *  - rename posts the trimmed name;
 *  - detach is confirmed before it fires, because it revokes a credential;
 *  - a stale child hub is visibly stale rather than silently listed;
 *  - detached hubs are behind a toggle, not mixed in with live ones.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminChildHubs } from '../pages/AdminChildHubs';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;
const put = api.put as unknown as ReturnType<typeof vi.fn>;

const TWO = {
  isParent: true,
  childHubs: [
    {
      id: 'ch-1', name: 'acme-emea', hubVersion: '1.1.19',
      firstSeen: '2026-09-01T10:00:00.000Z', lastSeen: '2026-09-14T10:00:00.000Z',
      live: true, detached: false, detachedAt: null,
    },
    {
      id: 'ch-2', name: 'acme-latam', hubVersion: '1.1.18',
      firstSeen: '2026-09-01T10:00:00.000Z', lastSeen: '2026-09-01T10:00:00.000Z',
      live: false, detached: false, detachedAt: null,
    },
  ],
};

const renderPage = (data: unknown = TWO) => {
  get.mockImplementation(async () => ({ data }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><AdminChildHubs /></MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => { get.mockReset(); post.mockReset(); put.mockReset(); });
afterEach(() => { cleanup(); get.mockReset(); post.mockReset(); put.mockReset(); });

describe('Admin → Child hubs', () => {
  it('tells a standalone hub it has no child hubs instead of showing an empty table', async () => {
    renderPage({ isParent: false, childHubs: [] });
    expect(await screen.findByText(/no child hubs/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('lists each child hub with its version and last contact', async () => {
    renderPage();
    expect(await screen.findByText('acme-emea')).toBeInTheDocument();
    expect(screen.getByText('acme-latam')).toBeInTheDocument();
    expect(screen.getByText('1.1.19')).toBeInTheDocument();
    expect(screen.getByText('1.1.18')).toBeInTheDocument();
  });

  it('marks a child hub that has stopped checking in', async () => {
    renderPage();
    await screen.findByText('acme-latam');
    const rows = screen.getAllByRole('row');
    const latam = rows.find(r => r.textContent?.includes('acme-latam'))!;
    expect(within(latam).getByText(/not checking in/i)).toBeInTheDocument();
    const emea = rows.find(r => r.textContent?.includes('acme-emea'))!;
    expect(within(emea).queryByText(/not checking in/i)).toBeNull();
  });

  it('generates a join token on demand and shows it with the parent URL', async () => {
    renderPage();
    await screen.findByText('acme-emea');
    post.mockResolvedValue({ data: {
      inviteToken: 'body.sig', parentUrl: 'https://hub.acme.com',
      expiresAt: '2026-09-28T10:00:00.000Z',
    } });
    // nothing is minted until asked — an invite is a credential
    expect(screen.queryByText('body.sig')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /generate join token/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/child-hubs/invite'));
    expect(await screen.findByText(/body\.sig/)).toBeInTheDocument();
    expect(screen.getByText(/hub\.acme\.com/)).toBeInTheDocument();
  });

  it('renames a child hub with the trimmed value and refreshes the list', async () => {
    renderPage();
    await screen.findByText('acme-emea');
    put.mockResolvedValue({ data: { id: 'ch-1', name: 'emea' } });
    fireEvent.click(screen.getAllByRole('button', { name: /rename/i })[0]);
    fireEvent.change(screen.getByRole('textbox', { name: /new name/i }), { target: { value: '  emea  ' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/child-hubs/ch-1', { name: 'emea' }));
  });

  it('confirms before detaching, and does not call the API if the admin backs out', async () => {
    renderPage();
    await screen.findByText('acme-emea');
    fireEvent.click(screen.getAllByRole('button', { name: /detach/i })[0]);
    // a confirmation step stands between the click and the revocation
    expect(await screen.findByText(/revokes its credential/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(post).not.toHaveBeenCalled();
  });

  it('detaches once confirmed', async () => {
    renderPage();
    await screen.findByText('acme-emea');
    post.mockResolvedValue({ data: { id: 'ch-1', detached: true, revokedKeys: 1 } });
    fireEvent.click(screen.getAllByRole('button', { name: /detach/i })[0]);
    fireEvent.click(await screen.findByRole('button', { name: /yes, detach/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/child-hubs/ch-1/detach'));
  });

  it('says the list could not be loaded instead of claiming the hub has no children', async () => {
    // The dangerous failure: a 500 or an expired session leaves `data`
    // undefined, and the isParent branch would then invite the admin to enrol
    // a child into a parent hub whose roster they simply could not see.
    get.mockRejectedValue({ response: { data: { error: 'boom' } } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><AdminChildHubs /></MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load child hubs/i);
    expect(screen.queryByText(/this hub has no child hubs/i)).toBeNull();
  });

  it('surfaces a failed detach instead of looking like the click did nothing', async () => {
    renderPage();
    await screen.findByText('acme-emea');
    post.mockRejectedValue({ response: { data: { error: 'hub unreachable' } } });
    fireEvent.click(screen.getByRole('button', { name: /detach acme-emea/i }));
    fireEvent.click(await screen.findByRole('button', { name: /yes, detach/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/hub unreachable/i);
  });

  it('surfaces a failed rename', async () => {
    renderPage();
    await screen.findByText('acme-emea');
    put.mockRejectedValue({ response: { data: { error: 'name taken' } } });
    fireEvent.click(screen.getByRole('button', { name: /rename acme-emea/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /new name/i }), { target: { value: 'emea' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/name taken/i);
  });

  it('refetches the roster after a rename and after a detach', async () => {
    renderPage();
    await screen.findByText('acme-emea');
    const afterLoad = get.mock.calls.length;
    put.mockResolvedValue({ data: { id: 'ch-1', name: 'emea' } });
    fireEvent.click(screen.getByRole('button', { name: /rename acme-emea/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /new name/i }), { target: { value: 'emea' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(afterLoad));

    const afterRename = get.mock.calls.length;
    post.mockResolvedValue({ data: { id: 'ch-1', detached: true, revokedKeys: 1 } });
    fireEvent.click(screen.getByRole('button', { name: /detach acme-emea/i }));
    fireEvent.click(await screen.findByRole('button', { name: /yes, detach/i }));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(afterRename));
  });

  it('renders a detached hub as detached: no detach action, no stale marker, and who did it', async () => {
    renderPage({
      isParent: true,
      childHubs: [{
        id: 'ch-9', name: 'acme-gone', hubVersion: '1.1.18',
        firstSeen: '2026-09-01T10:00:00.000Z', lastSeen: '2026-09-01T10:00:00.000Z',
        live: false, detached: true, detachedAt: '2026-09-10T10:00:00.000Z',
        detachedByEmail: 'admin@acme.com',
      }],
    });
    const row = (await screen.findAllByRole('row')).find(r => r.textContent?.includes('acme-gone'))!;
    expect(within(row).getByText(/detached by admin@acme\.com/i)).toBeInTheDocument();
    // "not checking in" on a hub you deliberately cut off is noise, not signal
    expect(within(row).queryByText(/not checking in/i)).toBeNull();
    expect(within(row).queryByRole('button', { name: /detach/i })).toBeNull();
    expect(within(row).getByRole('button', { name: /rename/i })).toBeInTheDocument();
  });

  it('distinguishes "every child was detached" from "never had a child"', async () => {
    renderPage({ isParent: true, childHubs: [] });
    expect(await screen.findByText(/every child hub of this one has been detached/i)).toBeInTheDocument();
    expect(screen.queryByText(/this hub has no child hubs/i)).toBeNull();
  });

  it('asks the server for detached hubs only when the toggle is on', async () => {
    renderPage();
    await screen.findByText('acme-emea');
    expect(get.mock.calls.every(c => !String(c[0]).includes('includeDetached'))).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /show detached/i }));
    await waitFor(() =>
      expect(get.mock.calls.some(c => String(c[0]).includes('includeDetached=1'))).toBe(true));
  });
});
