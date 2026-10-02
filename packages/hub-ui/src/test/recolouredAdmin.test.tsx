/**
 * @vitest-environment jsdom
 *
 * The admin sections render on the visual-system tokens only (CGLAB-434 S3.3).
 * Each section is mounted against a mocked api with populated rows, so tables,
 * pills, badges and callouts actually render, and its classes are checked the
 * same way as the dashboards (recolouredPages.test.tsx): no raw Tailwind palette,
 * no gradient or glow, no old teal-tint chrome, teal only on primary buttons.
 */
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminLayout, AdminAuth, AdminKeys, AdminUsers, AdminInstallations } from '../pages/Admin';
import { AdminFlows } from '../pages/AdminFlows';
import { AdminUpgrades } from '../pages/AdminUpgrades';
import { AdminRepoint } from '../pages/AdminRepoint';
import { AdminIdentities } from '../pages/AdminIdentities';
import { AdminModels } from '../pages/AdminModels';
import { AdminJira } from '../pages/AdminJira';
import { AdminOrg } from '../pages/AdminOrg';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';
import { expectOnTypeScale } from './helpers/typeScale';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const RAW_PALETTE = /\b(?:bg|text|border|ring|ring-offset|from|to|via|fill|stroke|outline|divide|shadow|caret|accent|decoration|placeholder)-(?:(?:red|rose|amber|yellow|orange|emerald|green|teal|cyan|sky|blue|indigo|violet|purple|pink|fuchsia|lime|slate|gray|zinc|neutral|stone)-\d{2,3}|white|black)\b/;
const OLD_ACCENT = /(?:^|\s|:)(?:(?:bg|from|to|via)-chip(?:\/\d+)?|(?:border|outline|ring)-border-brand(?:\/\d+)?|bg-mint(?:\/\d+)?|bg-brand\/\d+|text-brand-dark|text-brand-light|shadow-glow|bg-gradient-[\w-]+|bg-\[image:var\(--gradient-accent\)\]|(?:border|ring|outline)-brand(?:\/\d+)?|ring-brand)(?=\s|$)/;

const T0 = '2026-09-20T10:00:00.000Z';
const T1 = '2026-09-29T10:00:00.000Z';
const steps = [
  { id: 's0', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { id: 's1', name: 'DONE', label: 'Done', order: 1, isAnchor: true },
];
const FLOW2 = { id: 'f2', name: 'Lean Flow', description: 'available, not the default', source: 'hub', version: 1, orgAvailable: true, createdAt: T0, updatedAt: T1, definition: { name: 'Lean Flow', steps } };
const FLOW = { id: 'f1', name: 'Group TDD', description: 'ours', source: 'hub', version: 2, orgAvailable: true, createdAt: T0, updatedAt: T1, definition: { name: 'Group TDD', steps } };
const INSTALL = (id: string, extra = {}) => ({ id, agenfkVersion: '2.0.0', agenfkVersionUpdatedAt: T0, firstSeen: T0, lastSeen: T1, osUser: 'carol', gitName: 'Carol Diaz', gitEmail: 'carol@acme.dev', ...extra });

const ROUTES: Record<string, unknown> = {
  '/auth/me': { userId: 'u1', orgId: 'o', role: 'admin', email: 'admin@acme.dev', name: 'Ada' },
  '/v1/admin/auth-config': { passwordEnabled: true, googleEnabled: true, entraEnabled: false, google: { clientId: 'x.apps.googleusercontent.com', clientSecretSet: true }, entra: { tenantId: '', clientId: '', clientSecretSet: false }, emailAllowlist: ['acme.dev'] },
  '/v1/admin/api-keys': [
    { tokenHashPreview: 'a1b2c3d4', label: 'laptop', createdAt: T0, revokedAt: null, installationId: 'i1', osUser: 'carol', gitName: 'Carol Diaz', gitEmail: 'carol@acme.dev' },
    { tokenHashPreview: 'e5f6a7b8', label: 'old', createdAt: T0, revokedAt: T1, installationId: null },
  ],
  '/v1/admin/users': [
    { id: 'u1', email: 'admin@acme.dev', provider: 'password', role: 'admin', active: 1, created_at: T0, last_login_at: T1 },
    { id: 'u2', email: 'bob@acme.dev', provider: 'google', role: 'viewer', active: 0, created_at: T0, last_login_at: null },
  ],
  '/v1/admin/installations': [INSTALL('i1'), INSTALL('i2', { gitEmail: null, gitName: null, osUser: 'dan', hidden: true }), INSTALL('i3', { retired: true, retiredAt: T1, retiredByEmail: 'admin@acme.dev' })],
  '/v1/admin/hidden-users': [{ userKey: 'eve@acme.dev', hiddenByEmail: 'admin@acme.dev', createdAt: T0 }],
  '/v1/admin/flows': [FLOW, FLOW2],
  '/v1/admin/flows/default': { id: 'default', name: 'Default Flow', steps },
  '/v1/admin/flow-assignments': [{ scope: 'org', targetId: 'o', flowId: 'f1', updatedAt: T1 }, { scope: 'repo', targetId: 'r', flowId: 'f1', updatedAt: T1, remoteUrl: 'github.com/acme/api' }],
  '/v1/admin/registry-config': { repo: 'acme/flows', branch: 'main', isPublic: false, hasToken: true, copiedAt: T0 },
  '/v1/admin/registry/flows': [],
  '/v1/admin/registry/pulls': { repo: 'acme/flows', branch: 'main', isPublic: false, pulls: [{ number: 7, title: 'Add flow', url: 'https://github.com/acme/flows/pull/7', author: 'carol', createdAt: T0, draft: true, headBranch: 'x' }] },
  '/v1/admin/child-hubs': { isParent: true, childHubs: [
    { id: 'ch-1', name: 'acme-emea', hubVersion: '2.0.0', firstSeen: T0, lastSeen: T1, live: true, detached: false, detachedAt: null },
    { id: 'ch-2', name: 'acme-old', hubVersion: '1.1.18', firstSeen: T0, lastSeen: T0, live: false, detached: true, detachedAt: T1, releaseRequested: true, releaseReason: 'moving' },
  ] },
  '/v1/admin/flow-dispatches': { dispatches: [{ id: 'd1', flowId: 'f1', flowVersion: 2, scope: 'selected', createdByEmail: 'ops@acme.dev', createdAt: T1, cancelledAt: null, targets: [
    { childHubId: 'ch-1', name: 'acme-emea', state: 'installed', detail: null, updatedAt: T1 },
    { childHubId: 'ch-2', name: 'acme-old', state: 'failed', detail: 'no usable definition', updatedAt: T1 },
  ] }] },
  '/v1/admin/projects': [{ projectId: 'p1', lastSeen: T1, remoteUrl: 'https://github.com/acme/api.git' }],
  '/v1/admin/upgrade': { directives: [{
    directiveId: 'dir1', targetVersion: '2.0.1', scope: { type: 'all' }, createdAt: T1, createdByUserId: 'u1', createdByEmail: 'admin@acme.dev', requestIp: null, expiresAt: null,
    progress: { pending: 1, in_progress: 1, succeeded: 1, failed: 1, cancelled: 0 },
    targets: [
      { installationId: 'i1', state: 'succeeded', attemptedAt: T1, finishedAt: T1, resultVersion: '2.0.1', errorMessage: null, agenfkVersion: '2.0.1', agenfkVersionUpdatedAt: T1, gitEmail: 'carol@acme.dev' },
      { installationId: 'i2', state: 'failed', attemptedAt: T1, finishedAt: T1, resultVersion: null, errorMessage: 'npm ERR!', agenfkVersion: '2.0.0', agenfkVersionUpdatedAt: T0 },
      { installationId: 'i3', state: 'in_progress', attemptedAt: T1, finishedAt: null, resultVersion: null, errorMessage: null, agenfkVersion: '2.0.0', agenfkVersionUpdatedAt: T0 },
      { installationId: 'i4', state: 'pending', attemptedAt: null, finishedAt: null, resultVersion: null, errorMessage: null, agenfkVersion: '1.9.0', agenfkVersionUpdatedAt: T0 },
    ],
  }] },
  '/v1/admin/upgrade/available-versions': { versions: ['2.0.1', '2.0.0'], fleetFloor: '1.9.0' },
  '/v1/admin/upgrade-dispatches': { dispatches: [{ id: 'g1', targetVersion: '2.0.1', scope: 'all', cancelledAt: null, targets: [
    { childHubId: 'ch-1', name: 'acme-emea', state: 'done', detail: { counts: { pending: 0, updated: 3, failed: 1, skipped: 1 }, skipped: [{ installationId: 'i9', reason: 'retired' }] } },
  ] }] },
  '/v1/admin/repoint': { campaign: { id: 'c1', targetUrl: 'https://hub.acme.dev', allowedHost: 'hub.acme.dev', createdAt: T0 }, counts: { done: 1, waiting: 1, stale: 1, blocked: 1, failed: 1 }, drained: false, targets: [
    { installationId: 'i1', state: 'done', lastSeen: T1, gitEmail: 'carol@acme.dev', gitName: 'Carol', osUser: 'carol', errorMessage: null, reportedUrl: 'https://hub.acme.dev' },
    { installationId: 'i2', state: 'failed', lastSeen: T1, gitEmail: null, gitName: null, osUser: 'dan', errorMessage: 'refused', reportedUrl: null },
    { installationId: 'i3', state: 'pending', lastSeen: T0, gitEmail: null, gitName: null, osUser: 'eve', errorMessage: null, reportedUrl: null },
  ] },
  '/v1/admin/identity-suggestions': [
    { from: 'carol', to: 'carol@acme.dev', events: 12, firstSeen: T0, lastSeen: T1, installations: ['i1'], sourceInstallationCount: 1, targetCandidateCount: 1, confidence: 'unambiguous', blockedByLiveKey: false },
    { from: 'dan', to: 'dan@acme.dev', events: 3, firstSeen: T0, lastSeen: T1, installations: ['i2'], sourceInstallationCount: 1, targetCandidateCount: 2, confidence: 'ambiguous', blockedByLiveKey: true },
  ],
  '/v1/admin/user-keys/merges': [
    { id: 'm1', from: 'bob', to: 'bob@acme.dev', eventsMoved: 4, mergedByEmail: 'admin@acme.dev', revertedAt: null, createdAt: T0 },
    { id: 'm2', from: 'x', to: 'x@acme.dev', eventsMoved: 1, mergedByEmail: null, revertedAt: T1, createdAt: T0 },
  ],
  '/v1/admin/models': {
    mappings: [{ aliasModel: 'qwen38-27b', canonicalModel: 'qwen3.8:27b', createdByUserId: 'u1', createdByEmail: 'admin@acme.dev', createdAt: T0 }],
    observed: [{ model: 'glm-5.2', prs: 40, canonicalModel: 'glm-5.2', isMapped: false }, { model: 'qwen38-27b', prs: 2, canonicalModel: 'qwen3.8:27b', isMapped: true }],
  },
  '/v1/admin/jira': { configured: true, clientId: 'jira-client', clientSecretSet: true, connectedCount: 3, redirectUri: 'https://hub.acme.dev/jira/callback' },
  '/v1/admin/federation': { bound: true, parentUrl: 'https://hq.acme.dev', childHubId: 'ch-9', state: 'active', enrolledAt: T0, outboxDepth: 2, canLeave: true },
};

function mockApi() {
  get.mockImplementation(async (url: string) => {
    const path = url.split('?')[0];
    if (path in ROUTES) return { data: ROUTES[path] };
    return { data: {} };
  });
}

function mountLayout() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Same shape as App.tsx: sections nest under /admin.
  return render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/admin/auth']}>
          <Routes><Route path="/admin" element={<AdminLayout />}><Route path="auth" element={<div>auth section</div>} /></Route></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

function mount(element: React.ReactNode, entry = '/admin/x') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes><Route path="/admin/*" element={element} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

function expectOnTokens(root: HTMLElement) {
  // Story 7073be87: the type scale and the two content widths too.
  expectOnTypeScale(root);
  // A destructive control must not hover in the selection colour.
  for (const el of Array.from(root.querySelectorAll('button, a'))) {
    const c = el.getAttribute('class') ?? '';
    if (/(?:^|\s)text-status-danger-text(?:\s|$)/.test(c)) expect(c, `danger control "${el.textContent?.trim()}"`).not.toMatch(/hover:bg-accent-fill/);
  }
  const cls = [root, ...Array.from(root.querySelectorAll('*'))].map(el => el.getAttribute('class') ?? '').join(' ');
  expect(cls.match(RAW_PALETTE)?.[0] ?? null, 'raw palette colour').toBeNull();
  expect(cls.match(OLD_ACCENT)?.[0]?.trim() ?? null, 'old teal accent / gradient / glow').toBeNull();
  expect(cls.match(/(?:^|\s|:)text-accent-text(?:\s|$)/)?.[0] ?? null, 'teal text').toBeNull();
  for (const el of Array.from(root.querySelectorAll('[class]'))) {
    if (/(?:^|\s)bg-brand(?:\s|$)/.test(el.getAttribute('class') ?? '')) {
      expect(el.tagName, `bg-brand on <${el.tagName.toLowerCase()}> "${el.textContent?.slice(0, 24)}"`).toBe('BUTTON');
    }
  }
}

beforeEach(() => { get.mockReset(); mockApi(); });
afterEach(() => { cleanup(); get.mockReset(); });

const SECTIONS: Array<[string, React.ReactNode, () => Promise<unknown>]> = [
  ['Auth', <AdminAuth />, () => screen.findByText(/Microsoft Entra/i)],
  ['API keys', <AdminKeys />, () => screen.findAllByText(/a1b2c3d4/)],
  ['Users', <AdminUsers />, () => screen.findByText('bob@acme.dev')],
  ['Installations', <AdminInstallations />, () => screen.findAllByText(/Carol Diaz/)],
  ['Flows', <AdminFlows />, async () => {
    // The org-available chip and the assignments panel only render for a
    // non-default available flow, and only once its row is expanded.
    const name = await screen.findByText('Lean Flow');
    (name.closest('button') as HTMLElement).click();
    return screen.findAllByText(/Available/);
  }],
  ['Flows registry', <AdminFlows />, async () => {
    // The registry panels have their own tab now.
    (await screen.findByRole('tab', { name: 'Registry' })).click();
    return screen.findByTestId('admin-registry-save');
  }],
  ['Upgrades', <AdminUpgrades />, () => screen.findAllByText(/2\.0\.1/)],
  ['Repoint', <AdminRepoint />, () => screen.findAllByText(/hub\.acme\.dev/)],
  ['Identities', <AdminIdentities />, () => screen.findAllByText(/carol@acme\.dev/)],
  ['Models', <AdminModels />, () => screen.findAllByText(/glm-5\.2/)],
  ['JIRA', <AdminJira />, () => screen.findByText(/jira\/callback/)],
  ['Organization', <AdminOrg />, () => screen.findAllByText(/acme-emea/)],
];

describe('admin sections are on tokens only', () => {
  for (const [name, element, ready] of SECTIONS) {
    it(name, async () => {
      const { container } = mount(element);
      await ready();
      // Let secondary queries (registry pulls, dispatch boards) settle too.
      await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(0));
      await new Promise(r => setTimeout(r, 50));
      expectOnTokens(container);
    });
  }

  it('the admin section rail', async () => {
    const { container } = mountLayout();
    await screen.findByRole('link', { name: 'Sign-in' });
    expectOnTokens(container);
  });
});

describe('admin controls use the shared primitives', () => {
  it('every Active switch in the users table has a name that says whose it is', async () => {
    mount(<AdminUsers />);
    await screen.findByText('bob@acme.dev');
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBeGreaterThanOrEqual(2);
    for (const sw of switches) expect(sw).toHaveAccessibleName(/@acme\.dev/);
  });

  it('the current admin section is announced as current', async () => {
    mountLayout();
    const tab = await screen.findByRole('link', { name: 'Sign-in' }); // the auth section, renamed
    expect(tab).toHaveAttribute('aria-current', 'page');
    expect(tab.className).toMatch(/(?:^|\s)text-accent-ink(?:\s|$)/);
  });
});
