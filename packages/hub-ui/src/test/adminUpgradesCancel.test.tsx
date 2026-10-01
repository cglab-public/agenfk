/**
 * @vitest-environment jsdom
 *
 * Admin → Upgrades: the directive list and its cancel control, rendered.
 *
 * These replace hub-side tests that grepped this page's source for label text
 * ("Cancel pending", "Force-cancel") and for the nav link in Admin.tsx; they
 * broke on a rename without the behaviour changing. The rail's link to
 * /admin/upgrades is pinned by adminNav.test.tsx.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { AdminUpgrades } from '../pages/AdminUpgrades';
import { api } from '../api';
import { ThemeProvider } from '../ThemeContext';
import { answerConfirm, forbidWindowConfirm } from './helpers/confirmDialog';

// The route test mounts <App/>; the chrome is not what it is about.
vi.mock('../components/Layout', () => ({ Layout: ({ children }: any) => <div>{children}</div> }));
vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

const target = (installationId: string, state: string, agenfkVersion: string | null = null) => ({
  installationId, state, attemptedAt: null, finishedAt: null, resultVersion: null, errorMessage: null,
  agenfkVersion, agenfkVersionUpdatedAt: null,
});

const directive = (progress: Partial<Record<'pending' | 'in_progress' | 'succeeded' | 'failed' | 'cancelled', number>>, targets = [target('inst-1', 'pending', '1.1.20')]) => ({
  directiveId: 'dir-1',
  targetVersion: '1.1.21',
  scope: { type: 'all' },
  createdAt: '2026-09-30T10:00:00.000Z',
  createdByUserId: null,
  createdByEmail: 'admin@example.com',
  requestIp: null,
  expiresAt: null,
  progress: { pending: 0, in_progress: 0, succeeded: 0, failed: 0, cancelled: 0, ...progress },
  targets,
});

const routes = (directives: unknown[], over: Record<string, unknown> = {}): void => {
  const table: Record<string, unknown> = {
    '/auth/me': { userId: 'admin@x', orgId: 'acme', role: 'admin' },
    '/auth/providers': { password: true, google: false, entra: false, requiresSetup: false },
    '/v1/admin/upgrade': { directives },
    '/v1/admin/api-keys': [],
    '/v1/admin/installations': [],
    '/v1/admin/upgrade/available-versions': { versions: ['1.1.21'], fleetFloor: null },
    '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
    '/v1/admin/upgrade-dispatches': { dispatches: [] },
    ...over,
  };
  get.mockImplementation(async (url: string) => ({ data: table[url] ?? {} }));
};

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider><AdminUpgrades /></ThemeProvider>
    </QueryClientProvider>,
  );
};

// A declined confirm must send nothing; react-query dispatches a mutation
// asynchronously, so let it run before asserting its absence.
const settle = () => new Promise(r => setTimeout(r, 50));

// Confirmations are the in-page ConfirmDialog; the browser's must never open.
let confirmSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  get.mockReset(); post.mockReset();
  post.mockResolvedValue({ data: { cancelledCount: 1 } });
  confirmSpy = forbidWindowConfirm();
});
afterEach(() => { cleanup(); confirmSpy.mockRestore(); });

describe('AdminUpgrades — directive list', () => {
  it('lists directives from GET /v1/admin/upgrade with their target version', async () => {
    routes([directive({ pending: 1 })]);
    renderPage();
    expect(await screen.findByText('v1.1.21')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/v1/admin/upgrade');
  });

  it("shows each installation's current agenfk version once the directive is opened", async () => {
    routes([directive({ pending: 1 }, [target('inst-1', 'pending', '1.1.20')])]);
    renderPage();
    fireEvent.click(await screen.findByText('v1.1.21'));
    expect(await screen.findByText('v1.1.20')).toBeInTheDocument();
  });
});

describe('AdminUpgrades — cancelling a directive', () => {
  it('Cancel waiting POSTs a plain cancel once confirmed', async () => {
    routes([directive({ pending: 2 })]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel waiting' }));
    expect(await answerConfirm(true)).toMatch(/2 waiting upgrades/);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/upgrade/dir-1/cancel', {}));
  });

  it('Cancel waiting does nothing when the admin declines', async () => {
    routes([directive({ pending: 2 })]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel waiting' }));
    await answerConfirm(false);
    await settle();
    expect(post).not.toHaveBeenCalled();
  });

  it('with only running targets the control reads Clear stuck and sends force once confirmed', async () => {
    routes([directive({ in_progress: 1 }, [target('inst-1', 'in_progress')])]);
    renderPage();
    const clear = await screen.findByRole('button', { name: 'Clear stuck' });
    expect(screen.queryByRole('button', { name: 'Cancel waiting' })).not.toBeInTheDocument();
    fireEvent.click(clear);
    expect(await answerConfirm(true)).toMatch(/still running/);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/upgrade/dir-1/cancel', { force: true }));
  });

  it('Clear stuck sends nothing when the force confirm is declined', async () => {
    routes([directive({ in_progress: 1 }, [target('inst-1', 'in_progress')])]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear stuck' }));
    await answerConfirm(false);
    await settle();
    expect(post).not.toHaveBeenCalled();
  });

  it('with waiting and running targets, declining the force confirm still cancels the waiting ones', async () => {
    routes([directive({ pending: 1, in_progress: 1 }, [target('inst-1', 'pending'), target('inst-2', 'in_progress')])]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel waiting' }));
    expect(await answerConfirm(true)).toMatch(/waiting upgrade/);
    expect(await answerConfirm(false)).toMatch(/still running/);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/upgrade/dir-1/cancel', {}));
  });

  it('offers no cancel control once nothing is waiting or running', async () => {
    routes([directive({ succeeded: 1, cancelled: 1 }, [target('inst-1', 'succeeded')])]);
    renderPage();
    await screen.findByText('v1.1.21');
    const row = screen.getByText('v1.1.21').closest('div')!;
    expect(within(row).queryByRole('button', { name: /Cancel waiting|Clear stuck/ })).not.toBeInTheDocument();
  });
});

describe('AdminUpgrades — issuing a fleet upgrade', () => {
  const INSTALLATIONS = [
    { id: 'inst-a', gitName: 'Ada', gitEmail: 'ada@example.com', osUser: 'ada' },
    { id: 'inst-b', gitName: 'Bo', gitEmail: 'bo@example.com', osUser: 'bo' },
  ];
  // Several keys on one machine must still count as ONE target (BUG bb27c0aa).
  const KEYS = [
    { tokenHashPreview: 'k1', label: 'a-1', installationId: 'inst-a', gitName: 'Ada', gitEmail: 'ada@example.com', revokedAt: null },
    { tokenHashPreview: 'k2', label: 'a-2', installationId: 'inst-a', gitName: 'Ada', gitEmail: 'ada@example.com', revokedAt: null },
    { tokenHashPreview: 'k3', label: 'a-3', installationId: 'inst-a', gitName: 'Ada', gitEmail: 'ada@example.com', revokedAt: null },
  ];

  const openForm = async () => {
    routes([], { '/v1/admin/installations': INSTALLATIONS, '/v1/admin/api-keys': KEYS });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Issue upgrade/ }));
    const select = await screen.findByRole('combobox');
    await waitFor(() => expect((select as HTMLSelectElement).options.length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: '1.1.21' } });
  };

  it('counts the fleet from installations, not api keys', async () => {
    await openForm();
    expect(await screen.findByRole('button', { name: 'All (2)' })).toBeInTheDocument();
  });

  it('sends an all-installations directive to POST /v1/admin/upgrade', async () => {
    await openForm();
    await screen.findByRole('button', { name: 'All (2)' });
    fireEvent.click(screen.getByRole('button', { name: 'Issue' }));
    expect(await answerConfirm(true)).toMatch(/upgrade \d+ installation/i);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/upgrade', { targetVersion: '1.1.21', scope: { type: 'all' } }));
  });

  it('sends the single-installation shape when one installation is picked', async () => {
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: /Selected/ }));
    fireEvent.click((await screen.findAllByRole('checkbox'))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Issue' }));
    expect(await answerConfirm(true)).toMatch(/upgrade \d+ installation/i);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/upgrade', { targetVersion: '1.1.21', scope: { type: 'installation', installationId: 'inst-a' } }));
  });

  it('sends the list shape when several installations are picked', async () => {
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: /Selected/ }));
    for (const box of await screen.findAllByRole('checkbox')) fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Issue' }));
    expect(await answerConfirm(true)).toMatch(/upgrade \d+ installation/i);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/upgrade', { targetVersion: '1.1.21', scope: { type: 'installations', installationIds: ['inst-a', 'inst-b'] } }));
  });

  it('re-sends with confirmDowngrade when the hub reports a downgrade and the admin accepts', async () => {
    await openForm();
    await screen.findByRole('button', { name: 'All (2)' });
    post.mockRejectedValueOnce({ response: { status: 409, data: { downgrades: [{ installationId: 'inst-a', currentVersion: '1.1.22', targetVersion: '1.1.21' }] } } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue' }));
    expect(await answerConfirm(true)).toMatch(/upgrade \d+ installation/i);
    expect(await answerConfirm(true)).toMatch(/DOWNGRADE/i);
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/v1/admin/upgrade', { targetVersion: '1.1.21', scope: { type: 'all' }, confirmDowngrade: true }));
  });

  it('declining the downgrade sends nothing more', async () => {
    await openForm();
    await screen.findByRole('button', { name: 'All (2)' });
    post.mockRejectedValueOnce({ response: { status: 409, data: { downgrades: [{ installationId: 'inst-a', currentVersion: '1.1.22', targetVersion: '1.1.21' }] } } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue' }));
    await answerConfirm(true);
    expect(await answerConfirm(false)).toMatch(/DOWNGRADE/i);
    await settle();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('names the conflicting upgrade when one is already in flight', async () => {
    await openForm();
    await screen.findByRole('button', { name: 'All (2)' });
    post.mockRejectedValueOnce({ response: { status: 409, data: { conflicts: [{ installationId: 'inst-b', conflictingDirectiveId: 'dir-9' }] } } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue' }));
    expect(await answerConfirm(true)).toMatch(/upgrade \d+ installation/i);
    expect(await screen.findByText(/already waiting or running/)).toHaveTextContent('dir-9');
  });
});

describe('AdminUpgrades — route', () => {
  it('/admin/upgrades renders the upgrades page inside the app', async () => {
    routes([directive({ pending: 1 })]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/admin/upgrades']}><App /></MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Fleet upgrades' })).toBeInTheDocument();
  });
});
