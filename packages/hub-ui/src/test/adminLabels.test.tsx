/**
 * @vitest-environment jsdom
 *
 * [UX] Plain labels for admin enums: the admin pages said "directive",
 * "campaign", "spoke installations", "Fleet floor", "3LO", raw `in_progress`
 * and database table names. Each page is rendered and its visible text is
 * read, so a regression is a word an admin would actually see.
 */
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminUpgrades } from '../pages/AdminUpgrades';
import { AdminJira } from '../pages/AdminJira';
import { AdminOrg } from '../pages/AdminOrg';
import { AdminRepoint } from '../pages/AdminRepoint';
import { AdminFlows } from '../pages/AdminFlows';
import { upgradeStateLabel } from '../pages/adminLabels';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const T0 = '2026-09-01T10:00:00.000Z';
const T1 = '2026-09-20T10:00:00.000Z';
const steps = [
  { id: 's0', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { id: 's1', name: 'DONE', label: 'Done', order: 1, isAnchor: true },
];
const ROUTES: Record<string, unknown> = {
  '/auth/me': { userId: 'u1', orgId: 'acme', role: 'admin', email: 'admin@acme.dev' },
  '/healthz': { ok: true, version: '2.0.0' },
  '/v1/admin/upgrade': { directives: [{
    directiveId: 'dir1', targetVersion: '2.0.1', scope: { type: 'all' }, createdAt: T1, createdByUserId: 'u1', createdByEmail: 'admin@acme.dev', requestIp: null, expiresAt: null,
    progress: { pending: 0, in_progress: 1, succeeded: 1, failed: 0, cancelled: 0 },
    targets: [
      { installationId: 'i1', state: 'succeeded', attemptedAt: T1, finishedAt: T1, resultVersion: '2.0.1', errorMessage: null, agenfkVersion: '2.0.1', agenfkVersionUpdatedAt: T1, gitEmail: 'carol@acme.dev' },
      { installationId: 'i3', state: 'in_progress', attemptedAt: T1, finishedAt: null, resultVersion: null, errorMessage: null, agenfkVersion: '2.0.0', agenfkVersionUpdatedAt: T0 },
    ],
  }] },
  '/v1/admin/upgrade/available-versions': { versions: ['2.0.1', '2.0.0'], fleetFloor: '1.9.0' },
  '/v1/admin/api-keys': [],
  '/v1/admin/installations': [],
  '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
  '/v1/admin/upgrade-dispatches': { dispatches: [] },
  '/v1/admin/jira': { configured: true, clientId: 'cid', clientSecretSet: true, connectedCount: 3, redirectUri: 'https://hub.acme.test/v1/jira/oauth/callback' },
  '/v1/admin/federation': { bound: false, outboxDepth: 0 },
  '/v1/admin/repoint': { campaign: { id: 'c1', targetUrl: 'https://hub.acme.dev', allowedHost: 'hub.acme.dev', createdAt: T0 }, counts: { done: 1, waiting: 0, stale: 1, blocked: 0, failed: 0 }, drained: false, targets: [
    { installationId: 'i1', state: 'done', lastSeen: T1, gitEmail: 'carol@acme.dev', gitName: 'Carol', osUser: 'carol', errorMessage: null, reportedUrl: 'https://hub.acme.dev' },
  ] },
  '/v1/admin/flows': [{ id: 'f1', name: 'Lean Flow', description: 'ours', source: 'hub', version: 2, orgAvailable: true, createdAt: T0, updatedAt: T1, definition: { name: 'Lean Flow', steps } }],
  '/v1/admin/flows/default': { id: 'default', name: 'Default Flow', steps },
  '/v1/admin/flow-assignments': [],
  '/v1/admin/flow-dispatches': { dispatches: [] },
  '/v1/admin/registry-config': { repo: 'acme/flows', branch: 'main', isPublic: false, hasToken: true, copiedAt: T0 },
  '/v1/admin/registry/flows': [],
};

const mount = (el: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>
    </ThemeProvider>,
  );
};

const JARGON = /\b(directives?|campaigns?|spoke|fleet floor|force-cancel|3LO|in_progress|api_keys|org_id)\b/i;
const visibleText = () => document.body.textContent ?? '';

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    const key = Object.keys(ROUTES).sort((a, b) => b.length - a.length).find(k => url.startsWith(k));
    return { data: key ? ROUTES[key] : {} };
  });
});
afterEach(() => cleanup());

describe('upgradeStateLabel', () => {
  it('names every upgrade state in plain words', () => {
    expect(upgradeStateLabel('pending')).toBe('Waiting');
    expect(upgradeStateLabel('in_progress')).toBe('Running');
    expect(upgradeStateLabel('succeeded')).toBe('Updated');
    expect(upgradeStateLabel('failed')).toBe('Failed');
    expect(upgradeStateLabel('cancelled')).toBe('Cancelled');
  });
});

describe('admin pages speak plainly', () => {
  it('Upgrades: states, the version floor and the upgrade list', async () => {
    mount(<AdminUpgrades />);
    // Targets (and their state pills) show once the upgrade is expanded.
    ((await screen.findByText('v2.0.1', { selector: 'span' })).closest('button') as HTMLElement).click();
    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Updated')).toBeInTheDocument();
    // The summary chips use the same words as the pills.
    expect(screen.getByText('1 running')).toBeInTheDocument();
    expect(screen.getByText('1 updated')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear stuck' })).toBeInTheDocument();
    (await screen.findByRole('button', { name: /issue upgrade/i })).click();
    expect(await screen.findByText(/Oldest version reported/)).toBeInTheDocument();
    expect(visibleText()).not.toMatch(JARGON);
  });

  it('JIRA: counts connected boards, and no OAuth jargon', async () => {
    mount(<AdminJira />);
    expect(await screen.findByTestId('jira-connected-count')).toHaveTextContent('3');
    expect(screen.getByText(/agenfk boards connected/)).toBeInTheDocument();
    expect(visibleText()).not.toMatch(JARGON);
  });

  it('Organization: no spoke installations or table names', async () => {
    mount(<AdminOrg />);
    expect(await screen.findByRole('heading', { name: /^organization$/i })).toBeInTheDocument();
    expect(visibleText()).not.toMatch(JARGON);
  });

  it('Address change: no campaign', async () => {
    mount(<AdminRepoint />);
    expect(await screen.findByText('https://hub.acme.dev', { selector: 'div' })).toBeInTheDocument();
    expect(visibleText()).not.toMatch(JARGON);
  });

  it('Flows: the org-availability chip says where the flow shows', async () => {
    mount(<AdminFlows />);
    const name = await screen.findByText('Lean Flow');
    (name.closest('button') as HTMLElement).click();
    expect(await screen.findByText('Shown in flow picker')).toBeInTheDocument();
    expect(screen.queryByText(/^Picker$/)).toBeNull();
  });

  it('Upgrades: the empty list and the stuck-upgrade confirm speak plainly', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount(<AdminUpgrades />);
    ((await screen.findByText('v2.0.1', { selector: 'span' })).closest('button') as HTMLElement).click();
    (await screen.findByRole('button', { name: 'Clear stuck' })).click();
    const asked = String(confirmSpy.mock.calls[0]?.[0] ?? '');
    expect(asked).toMatch(/still running this upgrade/);
    expect(asked).not.toMatch(/\btoo\b/); // nothing else is being cancelled
    expect(asked).not.toMatch(JARGON);
    confirmSpy.mockRestore();
    cleanup();

    const withOne = ROUTES['/v1/admin/upgrade'];
    ROUTES['/v1/admin/upgrade'] = { directives: [] };
    try {
      mount(<AdminUpgrades />);
      expect(await screen.findByText('No upgrades sent yet.')).toBeInTheDocument();
    } finally {
      ROUTES['/v1/admin/upgrade'] = withOne;
    }
  });
});
