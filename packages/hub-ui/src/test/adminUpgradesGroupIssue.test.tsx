/**
 * @vitest-environment jsdom
 *
 * Admin → Upgrades: issuing a group upgrade to child hubs (CGLAB-360).
 *
 * The API shipped with CGLAB-183 and the board rendered what it produced, but
 * nothing on the page created one: the board returned null with no dispatches
 * and no button existed, so a parent admin read the page as "the hub does not
 * see my child installations". It does not, by design — the unit is the child
 * hub, which fans the version out over its own fleet. This is the form.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminUpgrades } from '../pages/AdminUpgrades';
import { api } from '../api';
import { ThemeProvider } from '../ThemeContext';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

const CHILDREN = {
  isParent: true,
  childHubs: [
    { id: 'ch-1', name: 'acme-emea', hubVersion: '1.1.21', firstSeen: '2026-09-01T10:00:00.000Z', lastSeen: '2026-09-22T10:00:00.000Z', live: true, detached: false, detachedAt: null },
    { id: 'ch-2', name: 'acme-latam', hubVersion: '1.1.20', firstSeen: '2026-09-01T10:00:00.000Z', lastSeen: '2026-09-22T10:00:00.000Z', live: true, detached: false, detachedAt: null },
    { id: 'ch-3', name: 'acme-old', hubVersion: '1.1.18', firstSeen: '2026-08-01T10:00:00.000Z', lastSeen: '2026-08-02T10:00:00.000Z', live: false, detached: true, detachedAt: '2026-08-03T10:00:00.000Z' },
  ],
};
const STANDALONE = { isParent: false, childHubs: [] };
const VERSIONS = { versions: ['1.1.21', '1.1.20'], fleetFloor: null };

type Routes = Record<string, unknown | (() => unknown)>;
const routes = (over: Routes = {}): void => {
  const table: Routes = {
    '/v1/admin/upgrade': { directives: [] },
    '/v1/admin/api-keys': [],
    '/v1/admin/installations': [],
    '/v1/admin/upgrade/available-versions': VERSIONS,
    '/v1/admin/child-hubs': CHILDREN,
    '/v1/admin/upgrade-dispatches': { dispatches: [] },
    ...over,
  };
  get.mockImplementation(async (url: string) => {
    const hit = table[url];
    if (typeof hit === 'function') return { data: (hit as () => unknown)() };
    if (hit === undefined) return { data: {} };
    return { data: hit };
  });
};

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider><AdminUpgrades /></ThemeProvider>
    </QueryClientProvider>,
  );
};

const openForm = async () => {
  renderPage();
  fireEvent.click(await screen.findByTestId('group-upgrade-issue-btn'));
  await screen.findByTestId('group-upgrade-send');
};

const pickVersion = (v: string) =>
  fireEvent.change(screen.getByTestId('group-upgrade-version'), { target: { value: v } });

beforeEach(() => { get.mockReset(); post.mockReset(); post.mockResolvedValue({ data: {} }); });
afterEach(() => { cleanup(); });

describe('Admin → Upgrades: a standalone hub', () => {
  it('sees no group-upgrade section at all, and the dispatch list is not fetched', async () => {
    routes({ '/v1/admin/child-hubs': STANDALONE });
    renderPage();
    await screen.findByText(/fleet upgrades/i);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/v1/admin/child-hubs'));
    expect(screen.queryByTestId('group-upgrade-issue-btn')).toBeNull();
    expect(screen.queryByTestId('group-upgrades')).toBeNull();
    expect(get).not.toHaveBeenCalledWith('/v1/admin/upgrade-dispatches');
  });
});

describe('Admin → Upgrades: a parent with no group upgrades yet', () => {
  it('is shown the section, an empty-state line and the control — the board is no longer invisible', async () => {
    routes();
    renderPage();
    expect(await screen.findByTestId('group-upgrades')).toBeInTheDocument();
    expect(screen.getByTestId('group-upgrades-empty')).toHaveTextContent(/no group upgrade/i);
    expect(screen.getByTestId('group-upgrade-issue-btn')).toBeEnabled();
  });
});

describe('Admin → Upgrades: issuing a group upgrade', () => {
  it('offers the same version list as the fleet form, and refuses to send without one', async () => {
    routes();
    await openForm();
    const select = screen.getByTestId('group-upgrade-version') as HTMLSelectElement;
    const values = Array.from(select.options).map(o => o.value).filter(Boolean);
    expect(values).toEqual(['1.1.21', '1.1.20']);
    expect(screen.getByTestId('group-upgrade-send')).toBeDisabled();
    pickVersion('1.1.21');
    expect(screen.getByTestId('group-upgrade-send')).toBeEnabled();
  });

  it("'all' posts the version and scope only — a hub that joins later is covered too", async () => {
    routes();
    await openForm();
    pickVersion('1.1.21');
    // Leave 'all' and come back so a broken mode switch cannot pass by default.
    fireEvent.click(screen.getByTestId('group-upgrade-scope-selected'));
    fireEvent.click(screen.getByTestId('group-upgrade-child-ch-1'));
    fireEvent.click(screen.getByTestId('group-upgrade-scope-all'));
    fireEvent.click(screen.getByTestId('group-upgrade-send'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/v1/admin/upgrade-dispatches', { targetVersion: '1.1.21', scope: 'all' },
    ));
  });

  it("'selected' posts exactly the ticked child hubs", async () => {
    routes();
    await openForm();
    pickVersion('1.1.20');
    fireEvent.click(screen.getByTestId('group-upgrade-scope-selected'));
    fireEvent.click(screen.getByTestId('group-upgrade-child-ch-2'));
    fireEvent.click(screen.getByTestId('group-upgrade-send'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/v1/admin/upgrade-dispatches', { targetVersion: '1.1.20', scope: 'selected', childHubIds: ['ch-2'] },
    ));
  });

  it("'selected' with nothing ticked sends nothing and says why", async () => {
    routes();
    await openForm();
    pickVersion('1.1.20');
    fireEvent.click(screen.getByTestId('group-upgrade-scope-selected'));
    fireEvent.click(screen.getByTestId('group-upgrade-send'));
    expect(await screen.findByTestId('group-upgrade-error')).toHaveTextContent(/pick at least one/i);
    expect(post).not.toHaveBeenCalled();
  });

  it('does not offer a detached child hub', async () => {
    routes();
    await openForm();
    fireEvent.click(screen.getByTestId('group-upgrade-scope-selected'));
    expect(screen.getByTestId('group-upgrade-child-ch-1')).toBeInTheDocument();
    expect(screen.queryByTestId('group-upgrade-child-ch-3')).toBeNull();
  });

  it('a downgrade is allowed only when the admin ticks the box, and travels as confirmDowngrade', async () => {
    routes();
    await openForm();
    pickVersion('1.1.20');
    fireEvent.click(screen.getByTestId('group-upgrade-downgrade'));
    fireEvent.click(screen.getByTestId('group-upgrade-send'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/v1/admin/upgrade-dispatches', { targetVersion: '1.1.20', scope: 'all', confirmDowngrade: true },
    ));
  });

  it("surfaces the server's refusal — a release that does not exist is refused where the admin can read it", async () => {
    routes();
    post.mockRejectedValueOnce({ response: { status: 422, data: { error: 'Release 1.1.21 not found' } } });
    await openForm();
    pickVersion('1.1.21');
    fireEvent.click(screen.getByTestId('group-upgrade-send'));
    expect(await screen.findByTestId('group-upgrade-error')).toHaveTextContent(/not found/i);
  });

  it('names the child the server would not target, not its id', async () => {
    routes();
    post.mockRejectedValueOnce({ response: { status: 404, data: { error: 'not in this group', missing: ['ch-2'] } } });
    await openForm();
    pickVersion('1.1.21');
    fireEvent.click(screen.getByTestId('group-upgrade-scope-selected'));
    fireEvent.click(screen.getByTestId('group-upgrade-child-ch-2'));
    fireEvent.click(screen.getByTestId('group-upgrade-send'));
    const err = await screen.findByTestId('group-upgrade-error');
    expect(err).toHaveTextContent('acme-latam');
    expect(err).not.toHaveTextContent('ch-2');
  });

  it('closes the form and refreshes the board after a successful send', async () => {
    let served = 0;
    routes({ '/v1/admin/upgrade-dispatches': () => { served += 1; return { dispatches: [] }; } });
    await openForm();
    await waitFor(() => expect(served).toBeGreaterThan(0));
    const before = served;
    pickVersion('1.1.21');
    fireEvent.click(screen.getByTestId('group-upgrade-send'));
    await waitFor(() => expect(screen.queryByTestId('group-upgrade-send')).toBeNull());
    await waitFor(() => expect(served).toBeGreaterThan(before));
  });
});
