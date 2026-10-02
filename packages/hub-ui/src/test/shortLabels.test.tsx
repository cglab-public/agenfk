/**
 * @vitest-environment jsdom
 *
 * Full ids, repositories and event types behind short labels (TASK acbf9b22,
 * story "No hover-only information"). An 8-character prefix, a display name or
 * a friendly badge stood in for the real value, which lived only in a title.
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { eventFields } from '../eventDetails';
import { AdminKeys, AdminInstallations } from '../pages/Admin';
import { AdminUpgrades } from '../pages/AdminUpgrades';
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
});
afterEach(cleanup);

const mount = (el: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<ThemeProvider><QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider></ThemeProvider>);
};
const ID = '5f0c2a9e-1b7d-4c3e-9a8f-0d6e4b2c1a77';

describe('an expanded event', () => {
  const event = {
    type: 'step.transitioned', item_id: 'i-1', item_title: 'Fix the picker', item_type: 'TASK', external_id: null,
    remote_url: 'https://github.com/acme/platform-api.git', payload: { payload: { fromStatus: 'REVIEW', toStatus: 'DONE' } },
  };

  it('shows the raw event type behind the friendly badge', () => {
    expect(eventFields(event)).toContainEqual({ label: 'Type', value: 'step.transitioned' });
  });

  it('shows the full repository, which the row shortens and hides on phones', () => {
    expect(eventFields(event)).toContainEqual({ label: 'Repository', value: 'https://github.com/acme/platform-api.git' });
  });

  it('leaves Repository out when the event has none', () => {
    expect(eventFields({ ...event, remote_url: null }).map(f => f.label)).not.toContain('Repository');
  });
});

describe('installation ids shown as a short prefix', () => {
  it('API keys: the full id is readable, not only the first 8 characters', async () => {
    table = { '/v1/admin/api-keys': [
      { tokenHashPreview: 'abcd1234', label: 'laptop', createdAt: '2026-09-01T00:00:00Z', revokedAt: null, installationId: ID },
    ] };
    mount(<AdminKeys />);
    expect(await screen.findByText(`installation ${ID}`)).toBeInTheDocument();
  });

  it('API keys: the full id is readable after the machine\'s identity too', async () => {
    table = { '/v1/admin/api-keys': [
      { tokenHashPreview: 'ef567890', label: 'ci', createdAt: '2026-09-01T00:00:00Z', revokedAt: null, installationId: ID, gitEmail: 'ci@acme.dev' },
    ] };
    mount(<AdminKeys />);
    await screen.findByText(/ci@acme\.dev/);
    expect(screen.getByText(`installation ${ID}`)).toBeInTheDocument();
  });

  it('Installations: the full id is readable beside its copy button', async () => {
    table = { '/v1/admin/installations': [
      { id: ID, agenfkVersion: '2.0.0', firstSeen: '2026-09-01', lastSeen: '2026-09-30', osUser: 'carol', gitName: 'Carol', gitEmail: 'c@x' },
    ], '/v1/admin/hidden-users': [] };
    mount(<AdminInstallations />);
    expect(await screen.findByText(`installation ${ID}`)).toBeInTheDocument();
  });

  it('Upgrades: the full id is readable behind the display name', async () => {
    table = {
      '/v1/admin/upgrade': { directives: [{
        directiveId: 'dir-1', targetVersion: '1.1.21', scope: { type: 'all' }, createdAt: '2026-09-30T10:00:00.000Z',
        createdByUserId: null, createdByEmail: null, requestIp: null, expiresAt: null,
        progress: { pending: 1, in_progress: 0, succeeded: 0, failed: 0, cancelled: 0 },
        targets: [{ installationId: ID, state: 'pending', attemptedAt: null, finishedAt: null, resultVersion: null, errorMessage: null, agenfkVersion: '1.1.20', agenfkVersionUpdatedAt: null, gitName: 'Carol' }],
      }] },
      '/v1/admin/installations': [],
      '/v1/admin/upgrade/available-versions': { versions: ['1.1.21'], fleetFloor: null },
      '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
      '/v1/admin/upgrade-dispatches': { dispatches: [] },
    };
    mount(<AdminUpgrades />);
    fireEvent.click(await screen.findByRole('button', { expanded: false, name: /1\.1\.21/ }));
    expect(await screen.findByText(`installation ${ID}`)).toBeInTheDocument();
  });
});
