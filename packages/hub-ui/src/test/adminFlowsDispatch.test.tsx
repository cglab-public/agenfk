/**
 * @vitest-environment jsdom
 *
 * Admin → Flows: dispatching a flow to child hubs (CGLAB-358).
 *
 * The API (CGLAB-182) was complete and tested, and unreachable: no button
 * called it, so a child hub never received a parent flow unless someone
 * hand-crafted the request. This is the button, and the board that says what
 * happened after it was pressed. What a unit test of flowDispatch.ts cannot
 * see:
 *  - a standalone hub is shown none of it;
 *  - 'all' posts no ids, 'selected' posts exactly the ticked ones, and nothing
 *    posts with nothing ticked;
 *  - detached children are not offered;
 *  - the board names the flow, not its id, and shows each child's answer;
 *  - a failed board load is visible instead of looking like "no dispatches";
 *  - the server's refusal reaches the admin's eyes.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminFlows } from '../pages/AdminFlows';
import { PUBLIC_REGISTRY_REPO } from '../pages/adminFlowRegistry';
import { api } from '../api';
import { ThemeProvider } from '../ThemeContext';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

const steps = [
  { id: 's0', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { id: 's1', name: 'DONE', label: 'Done', order: 1, isAnchor: true },
];
const LOCAL_FLOW = {
  id: 'f-local', name: 'Group TDD', description: 'ours',
  source: 'hub', version: 4, orgAvailable: true,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
  definition: { name: 'Group TDD', steps },
};
const PARENT_FLOW = {
  id: 'f-parent', name: 'HQ Standard', description: 'from above',
  source: 'parent', version: 1, orgAvailable: true,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
  definition: { name: 'HQ Standard', steps },
};

const CHILDREN = {
  isParent: true,
  childHubs: [
    { id: 'ch-1', name: 'acme-emea', hubVersion: '1.1.21', firstSeen: '2026-09-01T10:00:00.000Z', lastSeen: '2026-09-22T10:00:00.000Z', live: true, detached: false, detachedAt: null },
    { id: 'ch-2', name: 'acme-latam', hubVersion: '1.1.20', firstSeen: '2026-09-01T10:00:00.000Z', lastSeen: '2026-09-22T10:00:00.000Z', live: true, detached: false, detachedAt: null },
    { id: 'ch-3', name: 'acme-old', hubVersion: '1.1.18', firstSeen: '2026-08-01T10:00:00.000Z', lastSeen: '2026-08-02T10:00:00.000Z', live: false, detached: true, detachedAt: '2026-08-03T10:00:00.000Z' },
  ],
};
const STANDALONE = { isParent: false, childHubs: [] };

const DISPATCHES = {
  dispatches: [
    {
      id: 'd-1', flowId: 'f-local', flowVersion: 3, scope: 'selected', createdByEmail: 'ops@acme.test',
      createdAt: '2026-09-22T09:00:00.000Z', cancelledAt: null,
      targets: [
        { childHubId: 'ch-1', name: 'acme-emea', state: 'installed', detail: null, updatedAt: '2026-09-22T09:01:00.000Z' },
        { childHubId: 'ch-2', name: 'acme-latam', state: 'failed', detail: 'the directive did not carry a usable flow definition', updatedAt: '2026-09-22T09:01:30.000Z' },
      ],
    },
    {
      id: 'd-2', flowId: 'f-local', flowVersion: 4, scope: 'all', createdByEmail: 'ops@acme.test',
      createdAt: '2026-09-22T10:00:00.000Z', cancelledAt: null, targets: [],
    },
    {
      id: 'd-3', flowId: 'f-deleted', flowVersion: 1, scope: 'all', createdByEmail: null,
      createdAt: '2026-09-20T10:00:00.000Z', cancelledAt: '2026-09-20T11:00:00.000Z', targets: [],
    },
  ],
};

type Routes = Record<string, unknown | (() => unknown)>;
const routes = (over: Routes = {}): void => {
  const table: Routes = {
    '/v1/admin/flows': [LOCAL_FLOW, PARENT_FLOW],
    '/v1/admin/flows/default': { id: 'default', name: 'Default Flow', steps: [] },
    '/v1/admin/flow-assignments': [],
    '/v1/admin/registry-config': { repo: PUBLIC_REGISTRY_REPO, branch: 'main', isPublic: true, hasToken: false, copiedAt: null },
    '/v1/admin/registry/flows': [],
    '/v1/admin/child-hubs': CHILDREN,
    '/v1/admin/flow-dispatches': { dispatches: [] },
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
      <ThemeProvider><AdminFlows /></ThemeProvider>
    </QueryClientProvider>,
  );
};

const expand = async (flowId: string) => {
  renderPage();
  await waitFor(() => screen.getByTestId(`admin-flow-row-${flowId}`));
  fireEvent.click(screen.getByTestId(`admin-flow-row-${flowId}`));
  await waitFor(() => screen.getByTestId('admin-flow-edit-btn'));
};

beforeEach(() => { get.mockReset(); post.mockReset(); post.mockResolvedValue({ data: {} }); });
afterEach(() => { cleanup(); });

describe('Admin → Flows: a standalone hub', () => {
  it('is shown no dispatch control and no board — it has nobody to send to', async () => {
    routes({ '/v1/admin/child-hubs': STANDALONE });
    await expand('f-local');
    expect(screen.queryByTestId('admin-flow-dispatch-btn')).toBeNull();
    expect(screen.queryByTestId('flow-dispatches')).toBeNull();
  });
});

describe('Admin → Flows: dispatching to child hubs', () => {
  it('offers Dispatch on a flow this hub owns', async () => {
    routes();
    await expand('f-local');
    const btn = await screen.findByTestId('admin-flow-dispatch-btn');
    expect(btn).toBeEnabled();
  });

  it("disables Dispatch on a flow the parent sent, and says it is the parent's", async () => {
    routes();
    await expand('f-parent');
    const btn = await screen.findByTestId('admin-flow-dispatch-btn');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toMatch(/parent/i);
  });

  it("'all' posts the flow id and scope only — no ids, so future children are covered too", async () => {
    routes();
    await expand('f-local');
    fireEvent.click(await screen.findByTestId('admin-flow-dispatch-btn'));
    fireEvent.click(await screen.findByTestId('flow-dispatch-scope-all'));
    fireEvent.click(screen.getByTestId('flow-dispatch-send'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/flow-dispatches', { flowId: 'f-local', scope: 'all' }));
  });

  it("'selected' posts exactly the ticked children", async () => {
    routes();
    await expand('f-local');
    fireEvent.click(await screen.findByTestId('admin-flow-dispatch-btn'));
    fireEvent.click(await screen.findByTestId('flow-dispatch-scope-selected'));
    fireEvent.click(screen.getByTestId('flow-dispatch-child-ch-2'));
    fireEvent.click(screen.getByTestId('flow-dispatch-send'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/v1/admin/flow-dispatches', { flowId: 'f-local', scope: 'selected', childHubIds: ['ch-2'] },
    ));
  });

  it("'selected' with nothing ticked sends nothing and says why", async () => {
    routes();
    await expand('f-local');
    fireEvent.click(await screen.findByTestId('admin-flow-dispatch-btn'));
    fireEvent.click(await screen.findByTestId('flow-dispatch-scope-selected'));
    fireEvent.click(screen.getByTestId('flow-dispatch-send'));
    expect(await screen.findByTestId('flow-dispatch-error')).toHaveTextContent(/pick at least one/i);
    expect(post).not.toHaveBeenCalled();
  });

  it('does not offer a detached child', async () => {
    routes();
    await expand('f-local');
    fireEvent.click(await screen.findByTestId('admin-flow-dispatch-btn'));
    fireEvent.click(await screen.findByTestId('flow-dispatch-scope-selected'));
    expect(screen.getByTestId('flow-dispatch-child-ch-1')).toBeInTheDocument();
    expect(screen.getByTestId('flow-dispatch-child-ch-2')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-dispatch-child-ch-3')).toBeNull();
  });

  it("surfaces the server's refusal instead of swallowing it", async () => {
    routes();
    post.mockRejectedValueOnce({ response: { status: 404, data: { error: 'child hub not targetable', missing: ['ch-2'] } } });
    await expand('f-local');
    fireEvent.click(await screen.findByTestId('admin-flow-dispatch-btn'));
    fireEvent.click(await screen.findByTestId('flow-dispatch-scope-all'));
    fireEvent.click(screen.getByTestId('flow-dispatch-send'));
    expect(await screen.findByTestId('flow-dispatch-error')).toHaveTextContent(/not targetable/i);
  });

  it('refreshes the board after a successful send', async () => {
    let served = 0;
    routes({ '/v1/admin/flow-dispatches': () => { served += 1; return { dispatches: [] }; } });
    await expand('f-local');
    await waitFor(() => expect(served).toBeGreaterThan(0));
    const before = served;
    fireEvent.click(await screen.findByTestId('admin-flow-dispatch-btn'));
    fireEvent.click(await screen.findByTestId('flow-dispatch-scope-all'));
    fireEvent.click(screen.getByTestId('flow-dispatch-send'));
    await waitFor(() => expect(served).toBeGreaterThan(before));
  });
});

describe('Admin → Flows: the dispatch board', () => {
  it('renders nothing when a parent has never dispatched anything', async () => {
    routes();
    renderPage();
    await waitFor(() => screen.getByTestId('admin-flow-row-f-local'));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/v1/admin/flow-dispatches'));
    expect(screen.queryByTestId('flow-dispatches')).toBeNull();
  });

  it("names the flow and its version, not the flow's id", async () => {
    routes({ '/v1/admin/flow-dispatches': DISPATCHES });
    renderPage();
    const row = await screen.findByTestId('flow-dispatch-d-1');
    expect(row).toHaveTextContent('Group TDD');
    expect(row).toHaveTextContent('v3');
    expect(row).not.toHaveTextContent('f-local');
  });

  it('falls back to the id when the flow has since been deleted', async () => {
    routes({ '/v1/admin/flow-dispatches': DISPATCHES });
    renderPage();
    const row = await screen.findByTestId('flow-dispatch-d-3');
    expect(row).toHaveTextContent('f-deleted');
  });

  it("shows each child's answer, with the failure's own explanation", async () => {
    routes({ '/v1/admin/flow-dispatches': DISPATCHES });
    renderPage();
    const emea = await screen.findByTestId('flow-dispatch-target-d-1-ch-1');
    expect(emea).toHaveTextContent('acme-emea');
    expect(emea).toHaveTextContent(/installed/i);
    const latam = screen.getByTestId('flow-dispatch-target-d-1-ch-2');
    expect(latam).toHaveTextContent(/failed/i);
    expect(latam).toHaveTextContent(/did not carry a usable flow definition/);
  });

  it("says when nobody has picked an 'all' dispatch up yet, rather than showing a blank", async () => {
    routes({ '/v1/admin/flow-dispatches': DISPATCHES });
    renderPage();
    expect(await screen.findByTestId('flow-dispatch-unpolled-d-2')).toHaveTextContent(/no child hub has picked this up yet/i);
  });

  it('cancels a live dispatch through the cancel route, and refreshes', async () => {
    let served = 0;
    routes({ '/v1/admin/flow-dispatches': () => { served += 1; return DISPATCHES; } });
    renderPage();
    const row = await screen.findByTestId('flow-dispatch-d-2');
    const before = served;
    fireEvent.click(within(row).getByTestId('flow-dispatch-cancel-d-2'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/flow-dispatches/d-2/cancel', {}));
    await waitFor(() => expect(served).toBeGreaterThan(before));
  });

  it('shows a cancelled dispatch as cancelled, with no Cancel button', async () => {
    routes({ '/v1/admin/flow-dispatches': DISPATCHES });
    renderPage();
    const row = await screen.findByTestId('flow-dispatch-d-3');
    expect(within(row).getByTestId('flow-dispatch-cancelled-d-3')).toBeInTheDocument();
    expect(within(row).queryByTestId('flow-dispatch-cancel-d-3')).toBeNull();
  });

  it('a failed load is visible — it must not look like "no dispatches"', async () => {
    routes({ '/v1/admin/flow-dispatches': () => { throw new Error('boom'); } });
    renderPage();
    expect(await screen.findByTestId('flow-dispatches-error')).toHaveTextContent(/could not load/i);
  });
});
