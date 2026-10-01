/**
 * @vitest-environment jsdom
 *
 * [UX] Admin safety: irreversible and fleet-wide admin actions fired on one
 * click (revoke a key, start or end an address change, merge or revert
 * identities, clear the org default flow, remove an override, cancel a
 * dispatch, change the JIRA client ID). Each now asks first in the shared
 * ConfirmDialog, says what will happen, and sends nothing until confirmed.
 */
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminKeys, AdminUsers } from '../pages/Admin';
import { AdminRepoint } from '../pages/AdminRepoint';
import { AdminIdentities } from '../pages/AdminIdentities';
import { AdminFlows } from '../pages/AdminFlows';
import { AdminJira } from '../pages/AdminJira';
import { PUBLIC_REGISTRY_REPO } from '../pages/adminFlowRegistry';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';
import { answerConfirm, forbidWindowConfirm, letMutationsLand } from './helpers/confirmDialog';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const writes = () => [api.post, api.put, api.delete].flatMap(f => (f as unknown as ReturnType<typeof vi.fn>).mock.calls);

let table: Record<string, unknown> = {};
const mount = (el: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<ThemeProvider><QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider></ThemeProvider>);
};

beforeEach(() => {
  for (const f of [api.get, api.post, api.put, api.delete]) (f as unknown as ReturnType<typeof vi.fn>).mockReset();
  for (const f of [api.post, api.put, api.delete]) (f as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} });
  get.mockImplementation(async (url: string) => ({ data: url in table ? table[url] : [] }));
  // Nothing may fall back to the browser's own dialog.
  forbidWindowConfirm();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Trigger an action, check it asks and that declining sends nothing, then confirm and return what was sent. */
async function asksFirst(trigger: () => Promise<void> | void, consequence: RegExp) {
  await trigger();
  expect(await answerConfirm(false)).toMatch(consequence);
  await letMutationsLand();
  expect(writes()).toEqual([]);
  await trigger();
  await answerConfirm(true);
  await waitFor(() => expect(writes().length).toBeGreaterThan(0));
}

const steps = [
  { id: 's0', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { id: 's1', name: 'DONE', label: 'Done', order: 1, isAnchor: true },
];
const FLOW = {
  id: 'f-local', name: 'Group TDD', description: 'ours', source: 'hub', version: 4, orgAvailable: true,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', definition: { name: 'Group TDD', steps },
};
const flowRoutes = (over: Record<string, unknown> = {}) => ({
  '/v1/admin/flows': [FLOW],
  '/v1/admin/flows/default': { id: 'default', name: 'Default Flow', steps: [] },
  '/v1/admin/flow-assignments': [],
  '/v1/admin/registry-config': { repo: PUBLIC_REGISTRY_REPO, branch: 'main', isPublic: true, hasToken: false, copiedAt: null },
  '/v1/admin/registry/flows': [],
  '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
  '/v1/admin/flow-dispatches': { dispatches: [] },
  ...over,
});

describe('API keys', () => {
  it('revoking a key asks first and says machines stop reporting', async () => {
    table = { '/v1/admin/api-keys': [{ tokenHashPreview: 'abcd1234', label: 'laptop-a', createdAt: '2026-09-01T00:00:00Z', revokedAt: null }] };
    mount(<AdminKeys />);
    const revoke = await screen.findByRole('button', { name: /revoke/i });
    await asksFirst(() => { fireEvent.click(revoke); }, /stops reporting.*join again/i);
    expect(api.delete).toHaveBeenCalledWith('/v1/admin/api-keys/abcd1234');
  });
});

describe('Users', () => {
  it('deleting a user asks first in the dialog, not the browser', async () => {
    table = {
      '/auth/me': { userId: 'me' },
      '/v1/admin/users': [
        { id: 'me', email: 'me@x', provider: 'password', role: 'admin', active: 1, created_at: '2026-09-01', last_login_at: null },
        { id: 'v', email: 'view@x', provider: 'password', role: 'viewer', active: 1, created_at: '2026-09-01', last_login_at: null },
      ],
    };
    mount(<AdminUsers />);
    const del = await screen.findByRole('button', { name: /delete/i });
    await asksFirst(() => { fireEvent.click(del); }, /view@x.*cannot be undone/i);
    expect(api.delete).toHaveBeenCalledWith('/v1/admin/users/v');
  });
});

describe('Address change', () => {
  it('starting one asks first and names the new address', async () => {
    table = { '/v1/admin/repoint': { campaign: null, counts: {}, targets: [], drained: false } };
    mount(<AdminRepoint />);
    fireEvent.change(await screen.findByPlaceholderText('https://hub.new-domain.com'), { target: { value: 'https://hub.new.dev' } });
    const start = screen.getByRole('button', { name: /start the address change/i });
    await asksFirst(() => { fireEvent.click(start); }, /hub\.new\.dev/);
    expect(api.post).toHaveBeenCalledWith('/v1/admin/repoint', { targetUrl: 'https://hub.new.dev' });
  });

  it('ending one asks first and says unmoved installations stay behind', async () => {
    table = { '/v1/admin/repoint': {
      campaign: { id: 'c-1', targetUrl: 'https://hub.new.dev', allowedHost: 'hub.new.dev', createdAt: '2026-09-01T00:00:00Z' },
      counts: {}, targets: [], drained: false,
    } };
    mount(<AdminRepoint />);
    const end = await screen.findByRole('button', { name: /end the address change/i });
    await asksFirst(() => { fireEvent.click(end); }, /not moved|haven.t moved|stay/i);
    expect(api.post).toHaveBeenCalledWith('/v1/admin/repoint/c-1/close');
  });
});

describe('Identities', () => {
  const SUGGESTION = {
    from: 'dp', to: 'dp@acme.dev', events: 12, firstSeen: '2026-09-01', lastSeen: '2026-09-10',
    installations: ['i-1'], sourceInstallationCount: 1, targetCandidateCount: 1,
    confidence: 'unambiguous', blockedByLiveKey: false,
  };
  const MERGE = { id: 'm-1', from: 'old', to: 'new@acme.dev', eventsMoved: 5, mergedByEmail: 'a@x', revertedAt: null, createdAt: '2026-09-02' };

  it('says one thing about undo: merges are reversible from Merge history, newest first', async () => {
    table = { '/v1/admin/identity-suggestions': [], '/v1/admin/user-keys/merges': [MERGE] };
    mount(<AdminIdentities />);
    await screen.findByRole('heading', { name: /Merge history/ });
    expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument();
    expect(document.body.textContent).toMatch(/revers/i);
  });

  it('a suggested merge asks first and says how to undo it', async () => {
    table = { '/v1/admin/identity-suggestions': [SUGGESTION], '/v1/admin/user-keys/merges': [] };
    mount(<AdminIdentities />);
    // The suggestion's Merge comes first; the manual one below it starts disabled.
    await screen.findByText(/12 events/);
    const btn = screen.getAllByRole('button', { name: /^merge$/i })[0];
    await asksFirst(() => { fireEvent.click(btn); }, /merge history.*newest first/i);
    expect(api.post).toHaveBeenCalledWith('/v1/admin/user-keys/merge', { from: 'dp', to: 'dp@acme.dev' });
  });

  it('a manual merge asks first and says how to undo it', async () => {
    table = { '/v1/admin/identity-suggestions': [], '/v1/admin/user-keys/merges': [] };
    mount(<AdminIdentities />);
    fireEvent.change(await screen.findByPlaceholderText('from (old identity)'), { target: { value: 'old' } });
    fireEvent.change(screen.getByPlaceholderText('to (kept identity)'), { target: { value: 'new@acme.dev' } });
    const btn = screen.getAllByRole('button', { name: /^merge$/i }).at(-1)!;
    await asksFirst(() => { fireEvent.click(btn); }, /merge history.*newest first/i);
    expect(api.post).toHaveBeenCalledWith('/v1/admin/user-keys/merge', { from: 'old', to: 'new@acme.dev' });
  });

  it('a revert asks first', async () => {
    table = { '/v1/admin/identity-suggestions': [], '/v1/admin/user-keys/merges': [MERGE] };
    mount(<AdminIdentities />);
    const btn = await screen.findByRole('button', { name: /revert/i });
    await asksFirst(() => { fireEvent.click(btn); }, /back to old.*newer merge.*refuse/i);
    expect(api.post).toHaveBeenCalledWith('/v1/admin/user-keys/merges/m-1/revert');
  });

  it('shows the hub refusing an out-of-order revert', async () => {
    table = { '/v1/admin/identity-suggestions': [], '/v1/admin/user-keys/merges': [MERGE] };
    (api.post as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce({ response: { status: 409, data: { error: 'A newer merge has since taken these events.' } } });
    mount(<AdminIdentities />);
    fireEvent.click(await screen.findByRole('button', { name: /revert/i }));
    await answerConfirm(true);
    expect(await screen.findByText(/newer merge has since taken/i)).toBeInTheDocument();
  });
});

describe('Flows', () => {
  const expand = async () => fireEvent.click(await screen.findByTestId('admin-flow-row-f-local'));

  it('clearing the org default asks first and says what everyone falls back to', async () => {
    table = flowRoutes({ '/v1/admin/flow-assignments': [{ scope: 'org', targetId: '', flowId: 'f-local', updatedAt: '2026-09-01' }] });
    mount(<AdminFlows />);
    await expand();
    const clear = await screen.findByRole('button', { name: 'Clear' });
    await asksFirst(() => { fireEvent.click(clear); }, /keep the flow they already have/i);
    expect(api.put).toHaveBeenCalledWith('/v1/admin/flow-assignments', { scope: 'org', targetId: '', flowId: null });
  });

  it('removing a repo override asks first and names the repo', async () => {
    table = flowRoutes({ '/v1/admin/flow-assignments': [{ scope: 'repo', targetId: 'github.com/acme/api', remoteUrl: 'github.com/acme/api', flowId: 'f-local', updatedAt: '2026-09-01' }] });
    mount(<AdminFlows />);
    await expand();
    const row = (await screen.findByTitle('github.com/acme/api')).parentElement as HTMLElement;
    const remove = within(row).getByRole('button', { name: /remove/i });
    await asksFirst(() => { fireEvent.click(remove); }, /github\.com\/acme\/api.*org default.*keep the flow/i);
    expect(api.put).toHaveBeenCalledWith('/v1/admin/flow-assignments', { scope: 'repo', targetId: 'github.com/acme/api', flowId: null });
  });

  it('removing an installation override asks first and names the installation', async () => {
    table = flowRoutes({ '/v1/admin/flow-assignments': [{ scope: 'installation', targetId: 'inst-7', flowId: 'f-local', updatedAt: '2026-09-01' }] });
    mount(<AdminFlows />);
    await expand();
    const row = (await screen.findByTitle('inst-7')).parentElement as HTMLElement;
    await asksFirst(() => { fireEvent.click(within(row).getByRole('button', { name: /remove/i })); }, /inst-7/);
    expect(api.put).toHaveBeenCalledWith('/v1/admin/flow-assignments', { scope: 'installation', targetId: 'inst-7', flowId: null });
  });

  it('setting the org default asks first: it changes the flow for the whole fleet', async () => {
    table = flowRoutes();
    mount(<AdminFlows />);
    await expand();
    const set = await screen.findByTestId('admin-flow-set-org-default');
    await asksFirst(() => { fireEvent.click(set); }, /every installation.*next sync/i);
    expect(api.put).toHaveBeenCalledWith('/v1/admin/flow-assignments', { scope: 'org', flowId: 'f-local' });
  });

  it('cancelling a dispatch asks first', async () => {
    table = flowRoutes({
      '/v1/admin/child-hubs': { isParent: true, childHubs: [] },
      '/v1/admin/flow-dispatches': { dispatches: [{ id: 'd-1', flowId: 'f-local', flowVersion: 4, scope: 'all', createdByEmail: null, createdAt: '2026-09-22T10:00:00.000Z', cancelledAt: null, targets: [] }] },
    });
    mount(<AdminFlows />);
    const cancel = await screen.findByTestId('flow-dispatch-cancel-d-1');
    await asksFirst(() => { fireEvent.click(cancel); }, /not installed it yet will not.*keep it/i);
    expect(api.post).toHaveBeenCalledWith('/v1/admin/flow-dispatches/d-1/cancel', {});
  });
});

describe('Flow registry', () => {
  it('moving back to the public registry asks first', async () => {
    table = flowRoutes({ '/v1/admin/registry-config': { repo: 'acme/flows', branch: 'main', isPublic: false, hasToken: true, copiedAt: null } });
    mount(<AdminFlows />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Registry' }));
    const repo = await screen.findByTestId('admin-registry-repo');
    await waitFor(() => expect(repo).toHaveValue('acme/flows'));
    fireEvent.change(repo, { target: { value: PUBLIC_REGISTRY_REPO } });
    const save = screen.getByTestId('admin-registry-save');
    await asksFirst(() => { fireEvent.click(save); }, /browse the public one again/i);
    expect(api.put).toHaveBeenCalledWith('/v1/admin/registry-config', expect.objectContaining({ repo: PUBLIC_REGISTRY_REPO }));
  });
});

describe('JIRA', () => {
  const VIEW = { configured: true, clientId: 'old-client', clientSecretSet: true, connectedCount: 3, redirectUri: 'https://hub/jira/cb' };

  it('changing the client ID asks first and says everyone is disconnected', async () => {
    table = { '/v1/admin/jira': VIEW };
    mount(<AdminJira />);
    const id = await screen.findByLabelText(/client id/i);
    fireEvent.change(id, { target: { value: 'new-client' } });
    fireEvent.change(screen.getByLabelText(/client secret/i), { target: { value: 'new-secret' } });
    const save = screen.getByRole('button', { name: /^save$/i });
    await asksFirst(() => { fireEvent.click(save); }, /disconnected.*connect again/i);
    expect(api.put).toHaveBeenCalledWith('/v1/admin/jira', { clientId: 'new-client', clientSecret: 'new-secret' });
  });

  it('a new client ID without its secret is stopped in the form, before asking', async () => {
    table = { '/v1/admin/jira': VIEW };
    mount(<AdminJira />);
    fireEvent.change(await screen.findByLabelText(/client id/i), { target: { value: 'new-client' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/needs its client secret/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await letMutationsLand();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('saving with the same client ID does not ask', async () => {
    table = { '/v1/admin/jira': VIEW };
    mount(<AdminJira />);
    fireEvent.change(await screen.findByLabelText(/client secret/i), { target: { value: 'rotated' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/v1/admin/jira', { clientId: 'old-client', clientSecret: 'rotated' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the first client ID on an unconfigured app does not ask', async () => {
    table = { '/v1/admin/jira': { ...VIEW, configured: false, clientId: '', clientSecretSet: false, connectedCount: 0 } };
    mount(<AdminJira />);
    fireEvent.change(await screen.findByLabelText(/client id/i), { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

