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
 *    page at a time;
 *  - lists the org's recent denials and alerts newest first (HUB-1): an
 *    observe-mode one named as what enforce would have done, an alert
 *    highlighted with its category, filterable by client, installation,
 *    source, alert and mode, a page at a time.
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

const NO_DECISIONS = { decisions: [], next: null };

function hubAnswers(body: unknown, installations: unknown = NO_INSTALLATIONS, history: unknown = NO_HISTORY, decisions: unknown = NO_DECISIONS) {
  get.mockImplementation(async (url: string) => {
    if (url === '/v1/admin/airlock') return { data: body };
    if (url === '/v1/admin/airlock/installations') return { data: installations };
    if (url === '/v1/admin/airlock/history') return { data: history };
    if (url === '/v1/admin/airlock/decisions') return { data: decisions };
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

  it('edits the publish rule; a policy stored before it existed shows and saves its default (c9bdbe61)', async () => {
    hubAnswers(STORED);
    put.mockResolvedValue({ data: { ...STORED, revision: 5 } });
    renderPage();
    const publish = await screen.findByLabelText(/publish through an allowed host/i) as HTMLSelectElement;
    expect(publish.value).toBe('needs-human-approval');
    fireEvent.change(publish, { target: { value: 'deny' } });
    fireEvent.click(screen.getByRole('button', { name: /save policy/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1].policy.rules.publishThroughAllowedHost).toBe('deny');
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

  describe('recent denials', () => {
    const denial = (over: Record<string, unknown>) => ({
      eventId: 'ev-x', at: '2026-10-27T10:00:00.000Z', installationId: 'inst-alice', userKey: 'alice@acme.test',
      client: 'pi', model: 'cloudflare-workers-ai/qwen', tool: 'bash', capabilityKind: 'url', target: 'https://evil.example/upload',
      decision: 'deny', rule: 'uploadToUnlistedHost', mode: 'enforce', source: 'tool', alert: null, itemId: null,
      revision: 4, policySource: 'hub',
      ...over,
    });
    const RECENT = {
      next: null,
      decisions: [
        denial({ eventId: 'ev-3', at: '2026-10-27T12:00:00.000Z', target: '169.254.169.254', source: 'proxy', tool: 'proxy', alert: 'metadata-endpoint', mode: 'observe', decision: 'deny', rule: 'metadataHost' }),
        denial({ eventId: 'ev-2', at: '2026-10-27T11:00:00.000Z', target: 'aws s3 rm s3://prod', decision: 'needs-human-approval', rule: 'cloudMutation', client: 'opencode', userKey: 'bob@acme.test', installationId: 'inst-bob' }),
        denial({ eventId: 'ev-1' }),
      ],
    };
    const FLEET = {
      currentRevision: 4, currentIocRevision: 0,
      installations: [
        installation({ installationId: 'inst-alice', gitEmail: 'alice@acme.test' }),
        installation({ installationId: 'inst-bob', gitEmail: 'bob@acme.test' }),
      ],
    };

    const section = async () => {
      const table = await screen.findByRole('table', { name: /recent denials/i });
      return table.closest('section') as HTMLElement;
    };
    const rowsOf = async () => within(await screen.findByRole('table', { name: /recent denials/i })).getAllByRole('row').slice(1);
    const decisionCalls = () => get.mock.calls.filter(c => c[0] === '/v1/admin/airlock/decisions');

    it('lists the org denials newest first: when, who, client, what and the rule', async () => {
      hubAnswers(STORED, FLEET, NO_HISTORY, RECENT);
      renderPage();
      const rows = await rowsOf();
      expect(rows).toHaveLength(3);
      expect(rows[0]).toHaveTextContent('169.254.169.254');
      expect(rows[1]).toHaveTextContent('aws s3 rm s3://prod');
      expect(rows[1]).toHaveTextContent('bob@acme.test');
      expect(rows[1]).toHaveTextContent('opencode');
      expect(rows[1]).toHaveTextContent(/needs approval/i);
      expect(rows[1]).toHaveTextContent('cloudMutation');
      expect(rows[2]).toHaveTextContent('2026-10-27 10:00 UTC');
      expect(rows[2]).toHaveTextContent(/denied/i);
      expect(rows[2]).toHaveTextContent('uploadToUnlistedHost');
    });

    it('names an observe-mode denial as what enforce would have done', async () => {
      hubAnswers(STORED, FLEET, NO_HISTORY, RECENT);
      renderPage();
      const rows = await rowsOf();
      expect(rows[0]).toHaveTextContent(/observe: would deny/i);
      expect(rows[2]).not.toHaveTextContent(/observe/i);
    });

    it('highlights an alert and names its category', async () => {
      hubAnswers(STORED, FLEET, NO_HISTORY, RECENT);
      renderPage();
      const rows = await rowsOf();
      expect(rows[0]).toHaveAttribute('data-alert', 'metadata-endpoint');
      expect(rows[0].className).toMatch(/bg-status-danger-bg/);
      expect(rows[0]).toHaveTextContent(/metadata endpoint/i);
      expect(rows[2]).not.toHaveAttribute('data-alert');
      expect(rows[2].className).not.toMatch(/bg-status-danger-bg/);
    });

    it('asks the hub again with each filter chosen', async () => {
      hubAnswers(STORED, FLEET, NO_HISTORY, RECENT);
      renderPage();
      const s = await section();
      await waitFor(() => expect(within(s).getByRole('option', { name: 'bob@acme.test' })).toBeInTheDocument());
      fireEvent.change(within(s).getByLabelText(/^client$/i), { target: { value: 'pi' } });
      fireEvent.change(within(s).getByLabelText(/^installation$/i), { target: { value: 'inst-bob' } });
      fireEvent.change(within(s).getByLabelText(/^source$/i), { target: { value: 'proxy' } });
      fireEvent.change(within(s).getByLabelText(/^alert$/i), { target: { value: 'ioc-host' } });
      fireEvent.change(within(s).getByLabelText(/^policy mode$/i), { target: { value: 'observe' } });
      await waitFor(() => expect(get).toHaveBeenCalledWith('/v1/admin/airlock/decisions', {
        params: { client: 'pi', installation: 'inst-bob', source: 'proxy', alert: 'ioc-host', mode: 'observe' },
      }));
      // The first read carried no filter at all.
      expect(decisionCalls()[0][1]).toEqual({ params: {} });
    });

    it('offers every alert category, and any alert', async () => {
      hubAnswers(STORED, FLEET, NO_HISTORY, RECENT);
      renderPage();
      const s = await section();
      const alert = within(s).getByLabelText(/^alert$/i);
      const values = within(alert).getAllByRole('option').map(o => (o as HTMLOptionElement).value);
      expect(values).toEqual(['', 'any', 'cloud-storage', 'metadata-endpoint', 'ioc-host']);
    });

    it('loads the next page with the cursor and the filters chosen, and stops at the last page', async () => {
      get.mockImplementation(async (url: string, config?: { params?: Record<string, string> }) => {
        if (url === '/v1/admin/airlock') return { data: STORED };
        if (url === '/v1/admin/airlock/installations') return { data: FLEET };
        if (url === '/v1/admin/airlock/history') return { data: NO_HISTORY };
        if (url === '/v1/admin/airlock/decisions') {
          return config?.params?.cursor === 'page-2'
            ? { data: { decisions: [denial({ eventId: 'ev-old', target: 'older.example' })], next: null } }
            : { data: { decisions: [denial({ eventId: 'ev-new', target: 'newer.example' })], next: 'page-2' } };
        }
        throw new Error(`unexpected GET ${url}`);
      });
      renderPage();
      const s = await section();
      fireEvent.change(within(s).getByLabelText(/^source$/i), { target: { value: 'proxy' } });
      await waitFor(() => expect(get).toHaveBeenCalledWith('/v1/admin/airlock/decisions', { params: { source: 'proxy' } }));
      fireEvent.click(await within(s).findByRole('button', { name: /load more/i }));
      await waitFor(async () => expect(await rowsOf()).toHaveLength(2));
      expect((await rowsOf())[1]).toHaveTextContent('older.example');
      expect(get).toHaveBeenCalledWith('/v1/admin/airlock/decisions', { params: { source: 'proxy', cursor: 'page-2' } });
      await waitFor(() => expect(within(s).queryByRole('button', { name: /load more/i })).toBeNull());
    });

    it('says when there is nothing to show', async () => {
      hubAnswers(STORED);
      renderPage();
      expect(await screen.findByText(/no denials or alerts/i)).toBeInTheDocument();
    });
  });
});
