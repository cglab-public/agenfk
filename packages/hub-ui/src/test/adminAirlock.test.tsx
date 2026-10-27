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
 *  - keeps the IOC host list through its own route, once a policy exists;
 *  - lists every installation with the revision it applied against the
 *    current one, those behind highlighted and a refused policy named (HUB-2);
 *  - lists the policy's revision history: who, when, from what to what, a
 *    page at a time.
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

const NO_INSTALLATIONS = { currentRevision: 0, currentIocRevision: 0, installations: [] };
const NO_HISTORY = { entries: [], next: null };

function hubAnswers(body: unknown, installations: unknown = NO_INSTALLATIONS, history: unknown = NO_HISTORY) {
  get.mockImplementation(async (url: string) => {
    if (url === '/v1/admin/airlock') return { data: body };
    if (url === '/v1/admin/airlock/installations') return { data: installations };
    if (url === '/v1/admin/airlock/history') return { data: history };
    throw new Error(`unexpected GET ${url}`);
  });
}

const installation = (over: Record<string, unknown>) => ({
  installationId: 'inst-x', osUser: 'x', gitName: null, gitEmail: null, lastSeen: '2026-10-27T10:00:00.000Z',
  appliedRevision: null, appliedIocRevision: null, appliedAt: null, reportedAt: null,
  refusedRevision: null, refusedIocRevision: null, refusedError: null, refusedAt: null, behind: false,
  ...over,
});

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

  describe('installations', () => {
    const FLEET = {
      currentRevision: 4,
      currentIocRevision: 2,
      installations: [
        installation({ installationId: 'inst-alice', gitEmail: 'alice@acme.test', appliedRevision: 4, appliedIocRevision: 2, appliedAt: '2026-10-27T10:00:00.000Z', behind: false }),
        installation({ installationId: 'inst-bob', gitEmail: 'bob@acme.test', appliedRevision: 3, appliedIocRevision: 2, appliedAt: '2026-10-26T08:15:00.000Z', behind: true }),
        installation({ installationId: 'inst-carol', osUser: 'carol', appliedRevision: null, behind: true }),
        installation({
          installationId: 'inst-dan', gitEmail: 'dan@acme.test', appliedRevision: 3, appliedIocRevision: 2, behind: true,
          refusedRevision: 4, refusedIocRevision: 2, refusedError: 'Hub returned an invalid Airlock policy: hosts.allow: bad', refusedAt: '2026-10-27T11:00:00.000Z',
        }),
      ],
    };

    const rowOf = async (name: RegExp) => {
      const table = await screen.findByRole('table', { name: /installations/i });
      const row = within(table).getByText(name).closest('tr');
      expect(row).not.toBeNull();
      return row as HTMLElement;
    };

    it('lists each installation with the revision it applied, against the current one', async () => {
      hubAnswers(STORED, FLEET);
      renderPage();
      const table = await screen.findByRole('table', { name: /installations/i });
      expect(within(table).getAllByRole('row')).toHaveLength(1 + 4);
      const alice = await rowOf(/alice@acme.test/);
      expect(alice).toHaveTextContent(/revision 4/i);
      expect(alice).toHaveTextContent('2026-10-27 10:00 UTC');
      expect(alice).toHaveTextContent(/up to date/i);
      expect(alice).toHaveAttribute('data-behind', 'false');
      expect(screen.getByText(/current revision 4/i)).toBeInTheDocument();
    });

    it('highlights the installations that are behind, and says so in words', async () => {
      hubAnswers(STORED, FLEET);
      renderPage();
      const bob = await rowOf(/bob@acme.test/);
      expect(bob).toHaveAttribute('data-behind', 'true');
      expect(bob).toHaveTextContent(/behind/i);
      const carol = await rowOf(/^carol$/);
      expect(carol).toHaveAttribute('data-behind', 'true');
      expect(carol).toHaveTextContent(/not reported/i);
    });

    it('names a refused policy and why', async () => {
      hubAnswers(STORED, FLEET);
      renderPage();
      const dan = await rowOf(/dan@acme.test/);
      expect(dan).toHaveTextContent(/refused revision 4 with IOC list 2/i);
      expect(dan).toHaveTextContent(/hosts\.allow: bad/);
    });

    it('says when no installation has joined yet', async () => {
      hubAnswers(STORED);
      renderPage();
      expect(await screen.findByText(/no installation has joined/i)).toBeInTheDocument();
    });
  });

  describe('revision history', () => {
    const HISTORY = {
      next: null,
      entries: [
        { id: 'a3', at: '2026-10-22T12:00:00.000Z', actorEmail: 'sec@acme.test', source: 'board', action: 'airlock.ioc', before: { revision: 4, iocRevision: 1 }, after: { revision: 4, iocRevision: 2 } },
        { id: 'a2', at: '2026-10-21T09:30:00.000Z', actorEmail: 'admin@acme.test', source: 'board', action: 'airlock.update', before: { revision: 3, iocRevision: 1 }, after: { revision: 4, iocRevision: 1 } },
        { id: 'a1', at: '2026-10-01T08:00:00.000Z', actorEmail: 'admin@acme.test', source: 'board', action: 'airlock.update', before: null, after: { revision: 1, iocRevision: 0 } },
      ],
    };

    it('lists who changed the policy, when, and from which revision to which, newest first', async () => {
      hubAnswers(STORED, NO_INSTALLATIONS, HISTORY);
      renderPage();
      const list = await screen.findByRole('list', { name: /revision history/i });
      const items = within(list).getAllByRole('listitem');
      expect(items).toHaveLength(3);
      expect(items[0]).toHaveTextContent(/IOC list 1 → 2/);
      expect(items[0]).toHaveTextContent('sec@acme.test');
      expect(items[0]).toHaveTextContent('2026-10-22 12:00 UTC');
      expect(items[1]).toHaveTextContent(/revision 3 → 4/i);
      expect(items[1]).toHaveTextContent('admin@acme.test');
      expect(items[2]).toHaveTextContent(/first saved as revision 1/i);
    });

    it('loads the next page of history with the cursor the hub gave, and stops at the last page', async () => {
      const entry = (id: string, from: number) => ({
        id, at: '2026-10-01T08:00:00.000Z', actorEmail: 'admin@acme.test', source: 'board', action: 'airlock.update',
        before: { revision: from, iocRevision: 0 }, after: { revision: from + 1, iocRevision: 0 },
      });
      get.mockImplementation(async (url: string, config?: { params?: { cursor?: string } }) => {
        if (url === '/v1/admin/airlock') return { data: STORED };
        if (url === '/v1/admin/airlock/installations') return { data: NO_INSTALLATIONS };
        if (url === '/v1/admin/airlock/history') {
          return config?.params?.cursor === 'page-2'
            ? { data: { entries: [entry('h2', 1)], next: null } }
            : { data: { entries: [entry('h3', 2)], next: 'page-2' } };
        }
        throw new Error(`unexpected GET ${url}`);
      });
      renderPage();
      const list = await screen.findByRole('list', { name: /revision history/i });
      expect(within(list).getAllByRole('listitem')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: /load more/i }));
      await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
      expect(within(list).getAllByRole('listitem')[1]).toHaveTextContent(/revision 1 → 2/i);
      expect(get).toHaveBeenCalledWith('/v1/admin/airlock/history', { params: { cursor: 'page-2' } });
      await waitFor(() => expect(screen.queryByRole('button', { name: /load more/i })).toBeNull());
    });

    it('says when the policy has no history yet', async () => {
      hubAnswers(NONE);
      renderPage();
      expect(await screen.findByText(/no changes yet/i)).toBeInTheDocument();
    });
  });
});
