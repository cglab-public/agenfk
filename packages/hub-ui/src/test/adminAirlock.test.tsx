/**
 * @vitest-environment jsdom
 *
 * Admin → Airlock (GH-294, T3). The org's Airlock policy is kept on the hub
 * and every joined installation adopts it. The page:
 *  - is reachable under Fleet;
 *  - says when the org has no policy yet, and saves the first one at
 *    expectedRevision 0;
 *  - shows the mode, model selectors and host lists of the stored policy, and
 *    saves edits as a new revision (one host per line);
 *  - shows the hub's refusal (a metadata host allow-listed) inline;
 *  - keeps the IOC host list through its own route, once a policy exists.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminAirlock } from '../pages/AdminAirlock';
import { AdminLayout } from '../pages/Admin';
import { ADMIN_GROUPS } from '../pages/adminSections';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const put = api.put as unknown as ReturnType<typeof vi.fn>;

const STORED = {
  policy: {
    schemaVersion: 1,
    mode: 'enforce',
    models: [{ client: 'pi', provider: 'cloudflare-workers-ai' }],
    appliesWhenModelUnknown: true,
    hosts: { allow: ['github.com', 'registry.npmjs.org'], deny: ['evil.example'] },
    iocHosts: { revision: '2', hosts: ['bad.example'], updatedAt: '2026-10-20T10:00:00.000Z' },
    rules: { uploadToUnlistedHost: 'deny', credentialReadWithNetwork: 'deny', namespaceEscape: 'deny', cloudMutation: 'needs-human-approval' },
  },
  revision: 4,
  iocRevision: 2,
  updatedAt: '2026-10-21T09:30:00.000Z',
  updatedByEmail: 'admin@acme.test',
};

const NONE = { policy: null, revision: 0, iocRevision: 0, updatedAt: null, updatedByEmail: null };

function hubAnswers(body: unknown) {
  get.mockImplementation(async (url: string) => {
    if (url === '/v1/admin/airlock') return { data: body };
    throw new Error(`unexpected GET ${url}`);
  });
}

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/airlock']}>
        <Routes>
          <Route path="/admin" element={<AdminLayout />}>
            <Route path="airlock" element={<AdminAirlock />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => { get.mockReset(); put.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Admin → Airlock', () => {
  it('is a Fleet section, reachable from the admin nav', () => {
    const fleet = ADMIN_GROUPS.find(g => g.id === 'fleet')!;
    expect(fleet.sections.map(s => s.to)).toContain('airlock');
    hubAnswers(NONE);
    renderPage();
    const nav = screen.getByRole('navigation', { name: /admin sections/i });
    const group = within(nav).getByRole('group', { name: 'Fleet' });
    expect(within(group).getByRole('link', { name: /airlock/i })).toHaveAttribute('href', '/admin/airlock');
  });

  it('says the org has no policy yet, and saves the first one at revision 0', async () => {
    hubAnswers(NONE);
    put.mockResolvedValue({ data: { ...STORED, revision: 1 } });
    renderPage();
    expect(await screen.findByText(/no airlock policy yet/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^mode$/i), { target: { value: 'observe' } });
    fireEvent.click(screen.getByRole('button', { name: /save policy/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [url, body] = put.mock.calls[0];
    expect(url).toBe('/v1/admin/airlock');
    expect(body.expectedRevision).toBe(0);
    expect(body.policy.mode).toBe('observe');
  });

  it('shows the stored policy: mode, revision, who saved it, models and hosts', async () => {
    hubAnswers(STORED);
    renderPage();
    expect(await screen.findByText(/revision 4/i)).toBeInTheDocument();
    expect(screen.getByText(/admin@acme.test/)).toBeInTheDocument();
    expect((screen.getByLabelText(/^mode$/i) as HTMLSelectElement).value).toBe('enforce');
    expect((screen.getByLabelText(/allowed hosts/i) as HTMLTextAreaElement).value).toBe('github.com\nregistry.npmjs.org');
    expect((screen.getByLabelText(/denied hosts/i) as HTMLTextAreaElement).value).toBe('evil.example');
    expect((screen.getByLabelText(/models/i) as HTMLTextAreaElement).value).toBe('pi cloudflare-workers-ai');
  });

  it('saves an edit as the next revision, one host per line, blank lines dropped', async () => {
    hubAnswers(STORED);
    put.mockResolvedValue({ data: { ...STORED, revision: 5 } });
    renderPage();
    const allow = await screen.findByLabelText(/allowed hosts/i);
    fireEvent.change(allow, { target: { value: 'github.com\n\n  pypi.org  \n' } });
    fireEvent.click(screen.getByRole('button', { name: /save policy/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [url, body] = put.mock.calls[0];
    expect(url).toBe('/v1/admin/airlock');
    expect(body.expectedRevision).toBe(4);
    expect(body.policy.hosts.allow).toEqual(['github.com', 'pypi.org']);
    expect(body.policy.hosts.deny).toEqual(['evil.example']);
    expect(body.policy.models).toEqual([{ client: 'pi', provider: 'cloudflare-workers-ai' }]);
    expect(body.policy.rules.cloudMutation).toBe('needs-human-approval');
  });

  it("shows the hub's refusal inline", async () => {
    hubAnswers(STORED);
    put.mockRejectedValue({
      isAxiosError: true,
      response: { status: 400, data: { error: 'Invalid Airlock policy', errors: ['hosts.allow: "169.254.169.254" would allow the built-in metadata host 169.254.169.254, which is always denied'] } },
      message: 'Request failed with status code 400',
    });
    renderPage();
    const allow = await screen.findByLabelText(/allowed hosts/i);
    fireEvent.change(allow, { target: { value: '169.254.169.254' } });
    fireEvent.click(screen.getByRole('button', { name: /save policy/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/metadata host/);
  });

  it('saves the IOC host list through its own route', async () => {
    hubAnswers(STORED);
    put.mockResolvedValue({ data: { ...STORED, iocRevision: 3 } });
    renderPage();
    const ioc = await screen.findByLabelText(/ioc hosts/i);
    expect((ioc as HTMLTextAreaElement).value).toBe('bad.example');
    fireEvent.change(ioc, { target: { value: 'bad.example\nworse.example' } });
    fireEvent.click(screen.getByRole('button', { name: /save ioc list/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/airlock/ioc', { hosts: ['bad.example', 'worse.example'] }));
  });

  it('offers no IOC list until a policy exists', async () => {
    hubAnswers(NONE);
    renderPage();
    await screen.findByText(/no airlock policy yet/i);
    expect(screen.queryByRole('button', { name: /save ioc list/i })).toBeNull();
    expect(screen.getByText(/save a policy first/i)).toBeInTheDocument();
  });
});
