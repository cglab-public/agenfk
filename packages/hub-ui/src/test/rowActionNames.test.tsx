/**
 * @vitest-environment jsdom
 *
 * Repeated row actions say which row they act on (TASK cf73334f, story
 * "Names and state on every control"). A screen reader listing the buttons of
 * a table heard "Revoke, Revoke, Revoke": nothing said which key each one
 * revokes. Each test renders TWO rows, so a name that ignores its row cannot
 * pass by accident.
 */
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminKeys, AdminUsers, AdminInstallations } from '../pages/Admin';
import { AdminUpgrades, GroupUpgrades } from '../pages/AdminUpgrades';
import { AdminFlows } from '../pages/AdminFlows';
import { AdminIdentities } from '../pages/AdminIdentities';
import { PUBLIC_REGISTRY_REPO } from '../pages/adminFlowRegistry';
import { ChipRow } from '../components/ui';
import { FacetMultiselect } from '../components/FacetMultiselect';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

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
});
afterEach(cleanup);

const names = (re: RegExp) => screen.queryAllByRole('button', { name: re }).map(b => b.getAttribute('aria-label') ?? b.textContent);

describe('API keys', () => {
  it('each Revoke names its key: the label, or the hash preview when there is none', async () => {
    table = { '/v1/admin/api-keys': [
      { tokenHashPreview: 'abcd1234', label: 'laptop-a', createdAt: '2026-09-01T00:00:00Z', revokedAt: null },
      { tokenHashPreview: 'ef567890', label: null, createdAt: '2026-09-02T00:00:00Z', revokedAt: null },
    ] };
    mount(<AdminKeys />);
    expect(await screen.findByRole('button', { name: 'Revoke key laptop-a' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke key ef567890' })).toBeInTheDocument();
  });

  it('each invite\'s Dismiss and Copy say which invite', async () => {
    table = { '/v1/admin/api-keys': [] };
    let n = 0;
    post.mockImplementation(async () => { n += 1; return { data: { id: `inv-${n}`, joinCommand: `agenfk join ${n}`, expiresAt: '2026-10-09T00:00:00Z' } }; });
    mount(<AdminKeys />);
    fireEvent.click(await screen.findByRole('button', { name: 'Generate invite' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Generate another invite' }));
    await screen.findByText('agenfk join 2');

    expect(screen.getByRole('button', { name: 'Dismiss invite 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss invite 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy invite 1 command' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy invite 2 command' })).toBeInTheDocument();
  });
});

describe('Users', () => {
  it('each Delete names the user', async () => {
    table = {
      '/auth/me': { userId: 'me' },
      '/v1/admin/users': [
        { id: 'me', email: 'me@x', provider: 'password', role: 'admin', active: 1, created_at: '2026-09-01', last_login_at: null },
        { id: 'v', email: 'view@x', provider: 'password', role: 'viewer', active: 1, created_at: '2026-09-01', last_login_at: null },
        { id: 'w', email: 'write@x', provider: 'password', role: 'viewer', active: 1, created_at: '2026-09-01', last_login_at: null },
      ],
    };
    mount(<AdminUsers />);
    expect(await screen.findByRole('button', { name: 'Delete view@x' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete write@x' })).toBeInTheDocument();
  });
});

describe('Hidden people', () => {
  it('each Unhide names the person', async () => {
    table = { '/v1/admin/installations': [], '/v1/admin/hidden-users': [
      { userKey: 'ghost@acme.dev', createdAt: '2026-09-01', hiddenByEmail: null },
      { userKey: 'bot', createdAt: '2026-09-02', hiddenByEmail: 'a@x' },
    ] };
    mount(<AdminInstallations />);
    expect(await screen.findByRole('button', { name: 'Unhide ghost@acme.dev' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unhide bot' })).toBeInTheDocument();
  });
});

describe('Upgrades', () => {
  const directive = (id: string, targetVersion: string, createdAt: string, progress: Record<string, number>) => ({
    directiveId: id, targetVersion, scope: { type: 'all' }, createdAt, createdByUserId: null, createdByEmail: null,
    requestIp: null, expiresAt: null, targets: [],
    progress: { pending: 0, in_progress: 0, succeeded: 0, failed: 0, cancelled: 0, ...progress },
  });
  const upgradeRoutes = (directives: unknown[]) => ({
    '/v1/admin/upgrade': { directives },
    '/v1/admin/installations': [
      { id: 'i-1', agenfkVersion: '1.1.20', firstSeen: '2026-09-01', lastSeen: '2026-09-30', osUser: 'carol', gitName: 'Carol Diaz', gitEmail: 'carol@acme.dev' },
      { id: 'i-2', agenfkVersion: '1.1.20', firstSeen: '2026-09-01', lastSeen: '2026-09-30', osUser: 'bob', gitName: 'Bob Silva', gitEmail: 'bob@acme.dev' },
    ],
    '/v1/admin/upgrade/available-versions': { versions: ['1.1.21'], fleetFloor: null },
    '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
    '/v1/admin/upgrade-dispatches': { dispatches: [] },
  });

  it('each directive\'s cancel names its version and when it was issued', async () => {
    table = upgradeRoutes([
      directive('dir-1', '1.1.21', '2026-09-30T10:00:00.000Z', { pending: 2 }),
      directive('dir-2', '1.1.21', '2026-09-29T10:00:00.000Z', { in_progress: 1 }),
    ]);
    mount(<AdminUpgrades />);
    await screen.findAllByRole('button', { name: /upgrade to v1\.1\.21/ });
    const waiting = names(/^Cancel waiting upgrade to v1\.1\.21 \(.+\)$/);
    const stuck = names(/^Clear stuck upgrade to v1\.1\.21 \(.+\)$/);
    expect(waiting).toHaveLength(1);
    expect(stuck).toHaveLength(1);
    // Same version twice: only the issue time tells them apart.
    expect(waiting[0]).not.toBe(stuck[0]!.replace('Clear stuck', 'Cancel waiting'));
  });

  it('each picked installation\'s remove names the installation', async () => {
    table = upgradeRoutes([]);
    mount(<AdminUpgrades />);
    fireEvent.click(await screen.findByRole('button', { name: /issue upgrade/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Selected/ }));
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(1));
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);

    const removes = names(/^Remove /);
    expect(removes).toHaveLength(2);
    expect(new Set(removes).size).toBe(2);
  });

  it('each group upgrade\'s Cancel names its version', async () => {
    get.mockImplementation(async () => ({ data: { dispatches: [
      { id: 'd-1', targetVersion: '1.2.3', scope: 'all', cancelledAt: null, targets: [] },
      { id: 'd-2', targetVersion: '1.3.0', scope: 'all', cancelledAt: null, targets: [] },
    ] } }));
    mount(<GroupUpgrades />);
    expect(await screen.findByRole('button', { name: 'Cancel group upgrade to v1.2.3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel group upgrade to v1.3.0' })).toBeInTheDocument();
  });
});

describe('Flows', () => {
  const steps = [
    { id: 's0', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
    { id: 's1', name: 'DONE', label: 'Done', order: 1, isAnchor: true },
  ];
  const flow = (id: string, name: string, version: number) => ({
    id, name, description: '', source: 'hub', version, orgAvailable: true,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', definition: { name, steps },
  });
  const flowRoutes = (over: Record<string, unknown> = {}) => ({
    '/v1/admin/flows': [flow('f-local', 'Group TDD', 4), flow('f-two', 'Lean', 2)],
    '/v1/admin/flows/default': { id: 'default', name: 'Default Flow', steps: [] },
    '/v1/admin/flow-assignments': [],
    '/v1/admin/registry-config': { repo: PUBLIC_REGISTRY_REPO, branch: 'main', isPublic: true, hasToken: false, copiedAt: null },
    '/v1/admin/registry/flows': [],
    '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
    '/v1/admin/flow-dispatches': { dispatches: [] },
    ...over,
  });
  const expand = async () => fireEvent.click(await screen.findByTestId('admin-flow-row-f-local'));

  it('each dispatch\'s Cancel names the flow and version', async () => {
    table = flowRoutes({
      '/v1/admin/child-hubs': { isParent: true, childHubs: [] },
      '/v1/admin/flow-dispatches': { dispatches: [
        { id: 'd-1', flowId: 'f-local', flowVersion: 4, scope: 'all', createdByEmail: null, createdAt: '2026-09-22T10:00:00.000Z', cancelledAt: null, targets: [] },
        { id: 'd-2', flowId: 'f-two', flowVersion: 2, scope: 'all', createdByEmail: null, createdAt: '2026-09-23T10:00:00.000Z', cancelledAt: null, targets: [] },
      ] },
    });
    mount(<AdminFlows />);
    expect(await screen.findByRole('button', { name: 'Cancel dispatch of Group TDD v4' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel dispatch of Lean v2' })).toBeInTheDocument();
  });

  it('each override\'s remove names what it overrides, and each Add says what it adds', async () => {
    table = flowRoutes({ '/v1/admin/flow-assignments': [
      { scope: 'repo', targetId: 'github.com/acme/api', remoteUrl: 'github.com/acme/api', flowId: 'f-local', updatedAt: '2026-09-01' },
      { scope: 'repo', targetId: 'github.com/acme/web', remoteUrl: 'github.com/acme/web', flowId: 'f-local', updatedAt: '2026-09-01' },
      { scope: 'installation', targetId: 'inst-7', flowId: 'f-local', updatedAt: '2026-09-01' },
    ] });
    mount(<AdminFlows />);
    await expand();
    expect(await screen.findByRole('button', { name: 'Remove override for github.com/acme/api' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove override for github.com/acme/web' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove override for inst-7' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add repo override' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add installation override' })).toBeInTheDocument();
  });

  it('clearing the org default names the flow that stops being it', async () => {
    table = flowRoutes({ '/v1/admin/flow-assignments': [{ scope: 'org', targetId: '', flowId: 'f-local', updatedAt: '2026-09-01' }] });
    mount(<AdminFlows />);
    await expand();
    expect(await screen.findByRole('button', { name: 'Clear org default (Group TDD)' })).toBeInTheDocument();
  });
});

describe('Identities', () => {
  const suggestion = (from: string, to: string) => ({
    from, to, events: 12, firstSeen: '2026-09-01', lastSeen: '2026-09-10', installations: ['i-1'],
    sourceInstallationCount: 1, targetCandidateCount: 1, confidence: 'unambiguous', blockedByLiveKey: false,
  });
  const merge = (id: string, from: string, to: string) => ({ id, from, to, eventsMoved: 5, mergedByEmail: 'a@x', revertedAt: null, createdAt: '2026-09-02' });

  it('each suggested Merge names both identities', async () => {
    table = { '/v1/admin/identity-suggestions': [suggestion('dp', 'dp@acme.dev'), suggestion('jo', 'jo@acme.dev')], '/v1/admin/user-keys/merges': [] };
    mount(<AdminIdentities />);
    expect(await screen.findByRole('button', { name: 'Merge dp into dp@acme.dev' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge jo into jo@acme.dev' })).toBeInTheDocument();
  });

  it('each Revert names the merge it undoes', async () => {
    table = { '/v1/admin/identity-suggestions': [], '/v1/admin/user-keys/merges': [merge('m-1', 'old', 'new@acme.dev'), merge('m-2', 'x', 'y@acme.dev')] };
    mount(<AdminIdentities />);
    expect(await screen.findByRole('button', { name: 'Revert merge of old into new@acme.dev' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revert merge of x into y@acme.dev' })).toBeInTheDocument();
  });
});

describe('filter Clear buttons', () => {
  it('a chip row\'s Clear names its filter', () => {
    mount(
      <>
        <ChipRow label="Project" options={['a', 'b']} selected={new Set(['a'])} onToggle={() => {}} onClear={() => {}} />
        <ChipRow label="Model" options={['m']} selected={new Set(['m'])} onToggle={() => {}} onClear={() => {}} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Clear Project filter (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear Model filter (1)' })).toBeInTheDocument();
  });

  it.each([
    ['inline chips', ['a', 'b']],
    ['the popover', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']],
  ])('a facet\'s Clear names its filter (%s)', (_mode, options) => {
    mount(
      <>
        <FacetMultiselect label="Developer" options={options} selected={new Set(['a', 'b'])} onToggle={() => {}} onClear={() => {}} inlineThreshold={6} />
        <FacetMultiselect label="Child hub" options={options} selected={new Set(['a'])} onToggle={() => {}} onClear={() => {}} inlineThreshold={6} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Clear Developer filter (2)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear Child hub filter (1)' })).toBeInTheDocument();
  });
});
