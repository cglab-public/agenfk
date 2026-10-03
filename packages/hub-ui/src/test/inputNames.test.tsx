/**
 * @vitest-environment jsdom
 *
 * Every admin input has a name; expanders report their state (TASK 790992ef,
 * story "Names and state on every control"). These inputs had only a
 * placeholder, which disappears once something is typed and is not reliably
 * read as a name; and two row expanders opened without saying they had.
 */
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminAuth, AdminKeys } from '../pages/Admin';
import { AdminUpgrades } from '../pages/AdminUpgrades';
import { AdminFlows } from '../pages/AdminFlows';
import { AdminOrg } from '../pages/AdminOrg';
import { AdminRepoint } from '../pages/AdminRepoint';
import { AdminIdentities } from '../pages/AdminIdentities';
import { PUBLIC_REGISTRY_REPO } from '../pages/adminFlowRegistry';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

let table: Record<string, unknown> = {};
const mount = (el: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<ThemeProvider><QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider></ThemeProvider>);
};

beforeEach(() => {
  for (const f of [api.get, api.post, api.put, api.delete]) (f as unknown as ReturnType<typeof vi.fn>).mockReset();
  get.mockImplementation(async (url: string) => {
    const hit = Object.keys(table).find(k => url === k || url.startsWith(`${k}?`));
    return { data: hit ? table[hit] : [] };
  });
  table = {};
  // AdminFlows keeps its tab in the URL hash; a Registry tab left by one test
  // would open the next test's flows page on the wrong tab.
  window.history.replaceState(null, '', '/');
});
afterEach(cleanup);

describe('inputs that had only a placeholder', () => {
  it('Sign-in: the email allowlist is named by its heading', async () => {
    table = { '/v1/admin/auth-config': {
      passwordEnabled: true, googleEnabled: false, entraEnabled: false,
      google: { clientId: '', clientSecretSet: false }, entra: { tenantId: '', clientId: '', clientSecretSet: false }, emailAllowlist: ['acme.com'],
    } };
    get.mockImplementation(async () => ({ data: table['/v1/admin/auth-config'] }));
    mount(<AdminAuth />);
    expect(await screen.findByRole('textbox', { name: 'Email allowlist' })).toHaveValue('acme.com');
  });

  it('API keys: the new key\'s label', async () => {
    table = { '/v1/admin/api-keys': [] };
    mount(<AdminKeys />);
    expect(await screen.findByRole('textbox', { name: 'Key label' })).toBeInTheDocument();
  });

  it('Upgrades: the target version and the installation filter', async () => {
    table = {
      '/v1/admin/upgrade': { directives: [] },
      '/v1/admin/installations': [{ id: 'i-1', agenfkVersion: '1.1.20', firstSeen: '2026-09-01', lastSeen: '2026-09-30', osUser: 'carol', gitName: 'Carol', gitEmail: 'c@x' }],
      '/v1/admin/upgrade/available-versions': { versions: ['1.1.21'], fleetFloor: null },
      '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
      '/v1/admin/upgrade-dispatches': { dispatches: [] },
    };
    mount(<AdminUpgrades />);
    fireEvent.click(await screen.findByRole('button', { name: /issue upgrade/i }));
    expect(await screen.findByRole('combobox', { name: 'Target version' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Selected/ }));
    expect(await screen.findByRole('textbox', { name: 'Filter installations' })).toBeInTheDocument();
  });

  it('Flow registry: the repository and the token', async () => {
    table = {
      '/v1/admin/flows': [], '/v1/admin/flows/default': { id: 'default', name: 'Default Flow', steps: [] },
      '/v1/admin/flow-assignments': [],
      '/v1/admin/registry-config': { repo: 'acme/flows', branch: 'main', isPublic: false, hasToken: true, copiedAt: null },
      '/v1/admin/registry/flows': [], '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
      '/v1/admin/flow-dispatches': { dispatches: [] },
    };
    mount(<AdminFlows />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Registry' }));
    const repo = await screen.findByRole('textbox', { name: 'Registry repository' });
    await waitFor(() => expect(repo).toHaveValue('acme/flows'));
    expect(screen.getByLabelText('GitHub token')).toHaveAttribute('type', 'password');
    expect(PUBLIC_REGISTRY_REPO).not.toBe('acme/flows');
  });

  it('Organization: the new org id, with its error tied to it', async () => {
    table = { '/auth/me': { userId: 'a', orgId: 'acme', role: 'admin' } };
    mount(<AdminOrg />);
    const input = await screen.findByRole('textbox', { name: 'New org id' });
    expect(input).not.toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(input, { target: { value: 'Not Valid!' } });

    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBeTruthy();
  });

  it('Address change: the new hub address', async () => {
    table = { '/v1/admin/repoint': { campaign: null, counts: {}, targets: [], drained: false } };
    mount(<AdminRepoint />);
    expect(await screen.findByRole('textbox', { name: 'New hub address' })).toBeInTheDocument();
  });

  it('Identities: the manual merge\'s from and to', async () => {
    table = { '/v1/admin/identity-suggestions': [], '/v1/admin/user-keys/merges': [] };
    mount(<AdminIdentities />);
    expect(await screen.findByRole('textbox', { name: 'From (old identity)' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'To (kept identity)' })).toBeInTheDocument();
  });
});

describe('expanders', () => {
  it('a flow row says whether it is open', async () => {
    const steps = [{ id: 's0', name: 'TODO', label: 'To Do', order: 0, isAnchor: true }];
    table = {
      '/v1/admin/flows': [{ id: 'f-1', name: 'Lean', description: '', source: 'hub', version: 1, orgAvailable: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', definition: { name: 'Lean', steps } }],
      '/v1/admin/flows/default': { id: 'default', name: 'Default Flow', steps: [] },
      '/v1/admin/flow-assignments': [],
      '/v1/admin/registry-config': { repo: PUBLIC_REGISTRY_REPO, branch: 'main', isPublic: true, hasToken: false, copiedAt: null },
      '/v1/admin/registry/flows': [], '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
      '/v1/admin/flow-dispatches': { dispatches: [] },
    };
    mount(<AdminFlows />);
    const row = await screen.findByTestId('admin-flow-row-f-1');
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
  });

  it('an upgrade row says whether it is open', async () => {
    table = {
      '/v1/admin/upgrade': { directives: [{
        directiveId: 'dir-1', targetVersion: '1.1.21', scope: { type: 'all' }, createdAt: '2026-09-30T10:00:00.000Z',
        createdByUserId: null, createdByEmail: null, requestIp: null, expiresAt: null, targets: [],
        progress: { pending: 0, in_progress: 0, succeeded: 1, failed: 0, cancelled: 0 },
      }] },
      '/v1/admin/installations': [],
      '/v1/admin/upgrade/available-versions': { versions: ['1.1.21'], fleetFloor: null },
      '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
      '/v1/admin/upgrade-dispatches': { dispatches: [] },
    };
    mount(<AdminUpgrades />);
    const row = await screen.findByRole('button', { expanded: false, name: /1\.1\.21/ });
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
  });
});
