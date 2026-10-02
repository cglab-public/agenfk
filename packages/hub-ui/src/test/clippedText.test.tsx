/**
 * @vitest-environment jsdom
 *
 * Clipped reasons, errors and URLs readable in full (TASK a2da08b2, story "No
 * hover-only information"). These were cut with CSS truncate and the full
 * value kept in a title, which only a mouse can read. jsdom has no layout, so
 * the wrapping is pinned on the class that does it; what each test proves is
 * that the full text is on the element and is not truncated away.
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { PersonName } from '../components/PersonName';
import { AdminFlows } from '../pages/AdminFlows';
import { AdminUpgrades } from '../pages/AdminUpgrades';
import { PUBLIC_REGISTRY_REPO } from '../pages/adminFlowRegistry';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

let table: Record<string, unknown> = {};
beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    const hit = Object.keys(table).find(k => url === k || url.startsWith(`${k}?`));
    return { data: hit ? table[hit] : [] };
  });
  table = {};
  window.history.replaceState(null, '', '/');
});
afterEach(cleanup);

const mount = (el: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<ThemeProvider><QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider></ThemeProvider>);
};
const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);
/** The element holding exactly this text wraps it rather than cutting it. */
function expectWraps(text: string, wrap: 'break-words' | 'break-all') {
  const el = screen.getByText(text);
  expect(classes(el)).not.toContain('truncate');
  expect(classes(el)).toContain(wrap);
}

const LONG_KEY = 'a-very-long-identity-key-for-a-shared-ci-runner@build-farm.example.internal';

describe('a person\'s key', () => {
  it('wraps under their name', () => {
    render(<PersonName name="Build Farm" userKey={LONG_KEY} />);
    expectWraps(LONG_KEY, 'break-all');
  });

  it('wraps when it is all there is', () => {
    render(<PersonName userKey={LONG_KEY} />);
    expectWraps(LONG_KEY, 'break-all');
  });
});

describe('flows', () => {
  const steps = [{ id: 's0', name: 'TODO', label: 'To Do', order: 0, isAnchor: true }];
  const routes = (over: Record<string, unknown> = {}) => ({
    '/v1/admin/flows': [{ id: 'f-1', name: 'Lean', description: '', source: 'hub', version: 2, orgAvailable: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', definition: { name: 'Lean', steps } }],
    '/v1/admin/flows/default': { id: 'default', name: 'Default Flow', steps: [] },
    '/v1/admin/flow-assignments': [],
    '/v1/admin/registry-config': { repo: PUBLIC_REGISTRY_REPO, branch: 'main', isPublic: true, hasToken: false, copiedAt: null },
    '/v1/admin/registry/flows': [],
    '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
    '/v1/admin/flow-dispatches': { dispatches: [] },
    ...over,
  });

  it('a repo override\'s URL wraps', async () => {
    const url = 'https://github.example.internal/platform-engineering/monorepo-with-a-long-name.git';
    table = routes({ '/v1/admin/flow-assignments': [{ scope: 'repo', targetId: url, remoteUrl: url, flowId: 'f-1', updatedAt: '2026-09-01' }] });
    mount(<AdminFlows />);
    fireEvent.click(await screen.findByTestId('admin-flow-row-f-1'));
    await screen.findByRole('button', { name: `Remove override for ${url}` });
    expectWraps(url, 'break-all');
  });

  it('a failed dispatch target\'s detail wraps', async () => {
    const detail = 'flow definition rejected: step "REVIEW" references unknown check "coverage-gate-v2" (child hub runs an older build)';
    table = routes({
      '/v1/admin/child-hubs': { isParent: true, childHubs: [] },
      '/v1/admin/flow-dispatches': { dispatches: [{ id: 'd-1', flowId: 'f-1', flowVersion: 2, scope: 'all', createdByEmail: null, createdAt: '2026-09-22T10:00:00.000Z', cancelledAt: null,
        targets: [{ childHubId: 'ch-1', name: 'emea', state: 'failed', detail }] }] },
    });
    mount(<AdminFlows />);
    await screen.findByText(detail);
    expectWraps(detail, 'break-words');
  });
});

describe('upgrades', () => {
  it('a failed installation\'s error wraps in the open directive', async () => {
    const error = 'npm ERR! code EACCES: permission denied, mkdir /usr/local/lib/node_modules/agenfk (try a user-level prefix)';
    table = {
      '/v1/admin/upgrade': { directives: [{
        directiveId: 'dir-1', targetVersion: '1.1.21', scope: { type: 'all' }, createdAt: '2026-09-30T10:00:00.000Z',
        createdByUserId: null, createdByEmail: null, requestIp: null, expiresAt: null,
        progress: { pending: 0, in_progress: 0, succeeded: 0, failed: 1, cancelled: 0 },
        targets: [{ installationId: 'i-1', state: 'failed', attemptedAt: null, finishedAt: null, resultVersion: null, errorMessage: error, agenfkVersion: '1.1.20', agenfkVersionUpdatedAt: null }],
      }] },
      '/v1/admin/installations': [],
      '/v1/admin/upgrade/available-versions': { versions: ['1.1.21'], fleetFloor: null },
      '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
      '/v1/admin/upgrade-dispatches': { dispatches: [] },
    };
    mount(<AdminUpgrades />);
    fireEvent.click(await screen.findByRole('button', { expanded: false, name: /1\.1\.21/ }));
    await screen.findByText(error);
    expectWraps(error, 'break-words');
  });
});
