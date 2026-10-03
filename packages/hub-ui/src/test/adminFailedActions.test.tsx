/**
 * @vitest-environment jsdom
 *
 * [UX] Admin safety: failed admin actions disappeared silently. A failed
 * invite wiped the form and said nothing; issuing a key or generating an
 * invite threw into the void (mutateAsync with no catch); revoke, hide, retire,
 * role changes, flow assignments and ending an address change showed no error;
 * the Sign-in form showed axios' "Request failed with status code 400" instead
 * of the hub's reason; and Identities had one error slot, under "Merge
 * manually", even for a failed revert in the history table.
 *
 * Every failure now says what the hub said, next to the control that failed.
 */
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminAuth, AdminKeys, AdminUsers, AdminInstallations } from '../pages/Admin';
import { AdminRepoint } from '../pages/AdminRepoint';
import { AdminIdentities } from '../pages/AdminIdentities';
import { AdminFlows } from '../pages/AdminFlows';
import { InlineError } from '../components/ui';
import { PUBLIC_REGISTRY_REPO } from '../pages/adminFlowRegistry';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';
import { answerConfirm, forbidWindowConfirm, letMutationsLand } from './helpers/confirmDialog';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const refuse = (error: string, status = 400) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { error } } });

let table: Record<string, unknown> = {};
const mount = (el: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<ThemeProvider><QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider></ThemeProvider>);
};
/** The card (section) a control lives in: an error must show there, not somewhere else on the page. */
const cardOf = (el: HTMLElement) => (el.closest('section') ?? el.closest('form') ?? el.parentElement) as HTMLElement;

beforeEach(() => {
  for (const f of [api.get, api.post, api.put, api.delete]) fn(f).mockReset();
  for (const f of [api.post, api.put, api.delete]) fn(f).mockResolvedValue({ data: {} });
  fn(api.get).mockImplementation(async (url: string) => ({ data: url in table ? table[url] : [] }));
  forbidWindowConfirm();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('InlineError', () => {
  it('renders nothing without an error', () => {
    const { container } = render(<InlineError error={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says the hub's own reason, as an alert", () => {
    render(<InlineError error={refuse('invite token already used')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('invite token already used');
    expect(screen.getByRole('alert')).not.toHaveTextContent(/status code/);
  });

  it('falls back to the transport message, then to something rather than nothing', () => {
    const { rerender } = render(<InlineError error={new Error('Network Error')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Network Error');
    rerender(<InlineError error={{}} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/failed/i);
  });
});

describe('Sign-in', () => {
  it("shows the hub's reason for a refused save, not axios' status line", async () => {
    table = { '/v1/admin/auth-config': {
      passwordEnabled: true, googleEnabled: true, entraEnabled: false,
      google: { clientId: 'id', clientSecretSet: true }, entra: { tenantId: '', clientId: '', clientSecretSet: false }, emailAllowlist: [],
    } };
    fn(api.put).mockRejectedValueOnce(refuse('This would leave no admin able to sign in'));
    mount(<AdminAuth />);
    fireEvent.click(await screen.findByRole('button', { name: /save changes/i }));
    expect(await screen.findByText('This would leave no admin able to sign in')).toBeInTheDocument();
    expect(screen.queryByText(/status code 400/)).not.toBeInTheDocument();
  });
});

describe('API keys and invites', () => {
  beforeEach(() => { table = { '/v1/admin/api-keys': [{ tokenHashPreview: 'abcd1234', label: 'laptop-a', createdAt: '2026-09-01T00:00:00Z', revokedAt: null }] }; });

  it('a refused key shows why, next to the form', async () => {
    fn(api.post).mockRejectedValueOnce(refuse('label must not start with invite:'));
    mount(<AdminKeys />);
    const issue = await screen.findByRole('button', { name: /issue key/i });
    fireEvent.click(issue);
    expect(await within(cardOf(issue)).findByText('label must not start with invite:')).toBeInTheDocument();
  });

  it('a refused invite shows why, next to its button', async () => {
    fn(api.post).mockRejectedValueOnce(refuse('invites are disabled'));
    mount(<AdminKeys />);
    const gen = await screen.findByRole('button', { name: /generate invite/i });
    fireEvent.click(gen);
    expect(await within(cardOf(gen)).findByText('invites are disabled')).toBeInTheDocument();
  });

  it('a refused revoke shows why, in the keys list', async () => {
    fn(api.delete).mockRejectedValueOnce(refuse('key already revoked', 409));
    mount(<AdminKeys />);
    const revoke = await screen.findByRole('button', { name: /revoke/i });
    fireEvent.click(revoke);
    await answerConfirm(true);
    expect(await within(cardOf(revoke)).findByText('key already revoked')).toBeInTheDocument();
  });
});

describe('Users', () => {
  const USERS = [
    { id: 'me', email: 'me@x', provider: 'password', role: 'admin', active: 1, created_at: '2026-09-01', last_login_at: null },
    { id: 'v', email: 'view@x', provider: 'password', role: 'viewer', active: 1, created_at: '2026-09-01', last_login_at: null },
  ];
  beforeEach(() => { table = { '/auth/me': { userId: 'me' }, '/v1/admin/users': USERS }; });

  const fillInvite = async () => {
    fireEvent.change(await screen.findByPlaceholderText(/@/), { target: { value: 'new@acme.dev' } });
    fireEvent.change(screen.getByPlaceholderText(/8|password/i), { target: { value: 'longenough1' } });
  };

  it('a failed invite keeps what was typed and says why', async () => {
    fn(api.post).mockRejectedValueOnce(refuse('A user with that email already exists', 409));
    mount(<AdminUsers />);
    await fillInvite();
    const send = screen.getByRole('button', { name: /^invite/i });
    fireEvent.click(send);
    expect(await within(cardOf(send)).findByText('A user with that email already exists')).toBeInTheDocument();
    expect(screen.getByDisplayValue('new@acme.dev')).toBeInTheDocument();
  });

  it('a successful invite clears the form', async () => {
    mount(<AdminUsers />);
    await fillInvite();
    fireEvent.click(screen.getByRole('button', { name: /^invite/i }));
    await waitFor(() => expect(screen.queryByDisplayValue('new@acme.dev')).not.toBeInTheDocument());
  });

  it("a refused role change shows the hub's reason on the users list", async () => {
    fn(api.put).mockRejectedValueOnce(refuse('This is the last active admin; make someone else an admin first.', 409));
    mount(<AdminUsers />);
    const row = (await screen.findByText('view@x')).closest('tr') as HTMLElement;
    await waitFor(() => expect(within(row).getByRole('combobox')).toBeEnabled());
    fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'admin' } });
    expect(await within(cardOf(row)).findByText(/last active admin/)).toBeInTheDocument();
  });

  it("a refused role change is cleared once another action on the card succeeds", async () => {
    fn(api.put).mockRejectedValueOnce(refuse('This is the last active admin; make someone else an admin first.', 409));
    mount(<AdminUsers />);
    const row = (await screen.findByText('view@x')).closest('tr') as HTMLElement;
    await waitFor(() => expect(within(row).getByRole('combobox')).toBeEnabled());
    fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'admin' } });
    await screen.findByText(/last active admin/);
    fireEvent.click(within(row).getByRole('button', { name: /delete/i }));
    await answerConfirm(true);
    await waitFor(() => expect(screen.queryByText(/last active admin/)).not.toBeInTheDocument());
  });

  it('a refused delete says why', async () => {
    fn(api.delete).mockRejectedValueOnce(refuse('user is referenced elsewhere', 409));
    mount(<AdminUsers />);
    const del = await screen.findByRole('button', { name: /delete/i });
    fireEvent.click(del);
    await answerConfirm(true);
    expect(await within(cardOf(del)).findByText('user is referenced elsewhere')).toBeInTheDocument();
  });
});

describe('Installations', () => {
  const BOB = '9a8b7c6d-2222-4333-8444-a55556666777';
  const ROW = { id: BOB, agenfkVersion: '1.9.0', agenfkVersionUpdatedAt: '2026-08-01T00:00:00Z', firstSeen: '2026-07-01T00:00:00Z', lastSeen: '2026-09-20T00:00:00Z', osUser: 'bob', gitName: 'Bob Silva', gitEmail: 'bob@acme.dev' };
  beforeEach(() => {
    fn(api.get).mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/admin/installations')) return { data: [ROW] };
      if (url === '/v1/admin/hidden-users') return { data: [{ userKey: 'gone@acme.dev', hiddenByEmail: 'me@x', createdAt: '2026-09-01T00:00:00Z' }] };
      return { data: [] };
    });
  });

  it('a refused hide says why', async () => {
    fn(api.post).mockRejectedValueOnce(refuse('cannot hide yourself'));
    mount(<AdminInstallations />);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Bob Silva' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide Bob Silva' }));
    await answerConfirm(true);
    const card = screen.getByRole('heading', { name: 'Installations' }).closest('section') as HTMLElement;
    expect(await within(card).findByText('cannot hide yourself')).toBeInTheDocument();
  });

  it('a refused retire says why', async () => {
    fn(api.post).mockRejectedValueOnce(refuse('installation is mid-upgrade', 409));
    mount(<AdminInstallations />);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Bob Silva' }));
    fireEvent.click(screen.getByRole('menuitem', { name: "Retire Bob Silva's installation" }));
    await answerConfirm(true);
    const card = screen.getByRole('heading', { name: 'Installations' }).closest('section') as HTMLElement;
    expect(await within(card).findByText('installation is mid-upgrade')).toBeInTheDocument();
  });

  it('a refused hide is cleared once a retire on the same card succeeds', async () => {
    fn(api.post).mockRejectedValueOnce(refuse('cannot hide yourself'));
    mount(<AdminInstallations />);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Bob Silva' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide Bob Silva' }));
    await answerConfirm(true);
    await screen.findByText('cannot hide yourself');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Bob Silva' }));
    fireEvent.click(screen.getByRole('menuitem', { name: "Retire Bob Silva's installation" }));
    await answerConfirm(true);
    await waitFor(() => expect(screen.queryByText('cannot hide yourself')).not.toBeInTheDocument());
  });

  it('a refused unhide says why', async () => {
    fn(api.delete).mockRejectedValueOnce(refuse('not hidden', 404));
    mount(<AdminInstallations />);
    const unhide = await screen.findByRole('button', { name: /unhide/i });
    fireEvent.click(unhide);
    expect(await within(cardOf(unhide)).findByText('not hidden')).toBeInTheDocument();
  });
});

describe('Flows', () => {
  const steps = [
    { id: 's0', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
    { id: 's1', name: 'DONE', label: 'Done', order: 1, isAnchor: true },
  ];
  const FLOW = {
    id: 'f-local', name: 'Group TDD', description: 'ours', source: 'hub', version: 4, orgAvailable: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', definition: { name: 'Group TDD', steps },
  };
  beforeEach(() => {
    // The page keeps its tab in the URL hash; start every test on Flows.
    window.history.replaceState(null, '', window.location.pathname);
    table = {
      '/v1/admin/flows': [FLOW],
      '/v1/admin/flows/default': { id: 'default', name: 'Default Flow', steps: [] },
      '/v1/admin/flow-assignments': [],
      '/v1/admin/registry-config': { repo: PUBLIC_REGISTRY_REPO, branch: 'main', isPublic: true, hasToken: false, copiedAt: null },
      '/v1/admin/registry/flows': [],
      '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
      '/v1/admin/flow-dispatches': { dispatches: [] },
    };
  });

  it('a refused org default says why, in the flow panel', async () => {
    fn(api.put).mockRejectedValueOnce(refuse('flow is not valid', 422));
    mount(<AdminFlows />);
    fireEvent.click(await screen.findByTestId('admin-flow-row-f-local'));
    const set = await screen.findByTestId('admin-flow-set-org-default');
    fireEvent.click(set);
    await answerConfirm(true);
    const panel = set.closest('.space-y-3') as HTMLElement;
    expect(await within(panel).findByText('flow is not valid')).toBeInTheDocument();
  });

  it('a failed registry retry says why', async () => {
    // Retry copy is offered for any private registry.
    table['/v1/admin/registry-config'] = { repo: 'acme/flows', branch: 'main', isPublic: false, hasToken: true, copiedAt: null };
    fn(api.post).mockRejectedValueOnce(refuse('GitHub rate limit reached', 429));
    mount(<AdminFlows />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Registry' }));
    fireEvent.click(await screen.findByTestId('admin-registry-sync'));
    expect(await screen.findByText('GitHub rate limit reached')).toBeInTheDocument();
  });

  it("a refused registry save shows the hub's reason, not axios' status line", async () => {
    fn(api.put).mockRejectedValueOnce(refuse('repo not found or token lacks access', 422));
    mount(<AdminFlows />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Registry' }));
    const repo = await screen.findByTestId('admin-registry-repo');
    fireEvent.change(repo, { target: { value: 'acme/flows' } });
    const tokenInput = screen.queryByPlaceholderText(/token|ghp_/i);
    if (tokenInput) fireEvent.change(tokenInput, { target: { value: 'ghp_x' } });
    fireEvent.click(screen.getByTestId('admin-registry-save'));
    expect(await screen.findByText('repo not found or token lacks access')).toBeInTheDocument();
    expect(screen.queryByText(/status code 422/)).not.toBeInTheDocument();
  });

  it('a refused picker change says why', async () => {
    fn(api.put).mockRejectedValueOnce(refuse('flows table is locked', 503));
    fn(api.post).mockRejectedValueOnce(refuse('flows table is locked', 503));
    mount(<AdminFlows />);
    fireEvent.click(await screen.findByTestId('admin-flow-row-f-local'));
    fireEvent.click(await screen.findByTestId('admin-flow-toggle-availability'));
    expect(await screen.findByText('flows table is locked')).toBeInTheDocument();
  });
});

describe('Address change', () => {
  it('a refused end says why, in the address-change card', async () => {
    table = { '/v1/admin/repoint': {
      campaign: { id: 'c-1', targetUrl: 'https://hub.new.dev', allowedHost: 'hub.new.dev', createdAt: '2026-09-01T00:00:00Z' },
      counts: {}, targets: [], drained: false,
    } };
    fn(api.post).mockRejectedValueOnce(refuse('Unknown or already-ended address change', 404));
    mount(<AdminRepoint />);
    const end = await screen.findByRole('button', { name: /end the address change/i });
    fireEvent.click(end);
    await answerConfirm(true);
    expect(await within(cardOf(end)).findByText('Unknown or already-ended address change')).toBeInTheDocument();
  });
});

describe('Identities: each control has its own error', () => {
  const SUGGESTION = {
    from: 'dp', to: 'dp@acme.dev', events: 12, firstSeen: '2026-09-01', lastSeen: '2026-09-10',
    installations: ['i-1'], sourceInstallationCount: 1, targetCandidateCount: 1, confidence: 'unambiguous', blockedByLiveKey: false,
  };
  const MERGE = { id: 'm-1', from: 'old', to: 'new@acme.dev', eventsMoved: 5, mergedByEmail: 'a@x', revertedAt: null, createdAt: '2026-09-02' };
  beforeEach(() => { table = { '/v1/admin/identity-suggestions': [SUGGESTION], '/v1/admin/user-keys/merges': [MERGE] }; });
  const section = (heading: RegExp) => screen.getByRole('heading', { name: heading }).closest('section') as HTMLElement;

  it('a failed revert shows in Merge history, not under "Merge manually"', async () => {
    fn(api.post).mockRejectedValueOnce(refuse('A newer merge has since taken these events.', 409));
    mount(<AdminIdentities />);
    fireEvent.click(await screen.findByRole('button', { name: /revert/i }));
    await answerConfirm(true);
    expect(await within(section(/merge history/i)).findByText(/newer merge has since taken/)).toBeInTheDocument();
    expect(within(section(/merge manually/i)).queryByText(/newer merge has since taken/)).not.toBeInTheDocument();
  });

  it('a failed revert replaces an earlier note instead of sitting beside it', async () => {
    table['/v1/admin/user-keys/merges'] = [MERGE, { ...MERGE, id: 'm-2', from: 'ghost', to: 'g@acme.dev', eventsMoved: 0 }];
    fn(api.post)
      .mockResolvedValueOnce({ data: { eventsRestored: 0, note: 'This merge moved no events, so there was nothing to move back.' } })
      .mockRejectedValueOnce(refuse('A newer merge has since taken these events.', 409));
    mount(<AdminIdentities />);
    const [first, second] = await screen.findAllByRole('button', { name: /revert/i });
    fireEvent.click(second);
    await answerConfirm(true);
    await screen.findByText(/moved no events/);
    fireEvent.click(first);
    await answerConfirm(true);
    await screen.findByText(/newer merge has since taken/);
    expect(screen.queryByText(/moved no events/)).not.toBeInTheDocument();
  });

  it('a successful suggested merge leaves the manual form alone', async () => {
    mount(<AdminIdentities />);
    fireEvent.change(await screen.findByPlaceholderText('from (old identity)'), { target: { value: 'typed' } });
    await screen.findByText(/12 events/);
    fireEvent.click(screen.getByRole('button', { name: 'Merge dp into dp@acme.dev' }));
    await answerConfirm(true);
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    await letMutationsLand();
    expect(screen.getByPlaceholderText('from (old identity)')).toHaveValue('typed');
  });

  it('a failed suggested merge shows with the suggestions', async () => {
    fn(api.post).mockRejectedValueOnce(refuse('source still has a live API key', 409));
    mount(<AdminIdentities />);
    await screen.findByText(/12 events/);
    fireEvent.click(screen.getByRole('button', { name: 'Merge dp into dp@acme.dev' }));
    await answerConfirm(true);
    expect(await within(section(/identity suggestions/i)).findByText('source still has a live API key')).toBeInTheDocument();
    expect(within(section(/merge manually/i)).queryByText('source still has a live API key')).not.toBeInTheDocument();
  });

  it('a failed manual merge shows under "Merge manually"', async () => {
    fn(api.post).mockRejectedValueOnce(refuse('unknown identity', 404));
    mount(<AdminIdentities />);
    fireEvent.change(await screen.findByPlaceholderText('from (old identity)'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText('to (kept identity)'), { target: { value: 'y@acme.dev' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^merge$/i }).at(-1)!);
    await answerConfirm(true);
    expect(await within(section(/merge manually/i)).findByText('unknown identity')).toBeInTheDocument();
  });
});
