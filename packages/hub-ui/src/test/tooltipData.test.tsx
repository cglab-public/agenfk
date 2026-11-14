/**
 * @vitest-environment jsdom
 *
 * Data and explanations that lived only in a tooltip (TASK 8764a515, story
 * "No hover-only information"). Each was in a title on something that is not
 * focusable, so only a mouse could read it.
 */
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { LocalTime } from '../components/ui';
import { AdminInstallations } from '../pages/Admin';
import { AdminUpgrades, GroupUpgrades } from '../pages/AdminUpgrades';
import { ModelTable } from '../components/ModelTable';
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

describe('a timestamp', () => {
  it('reads out its UTC instant, which was only its title', () => {
    render(<p data-testid="t">Updated <LocalTime value="2026-09-30T22:14:05Z" /></p>);
    expect(within(screen.getByTestId('t')).getByText('(2026-09-30 22:14:05 UTC)')).toHaveClass('sr-only');
  });

  it('keeps the visible time as the <time> element\'s whole text', () => {
    render(<LocalTime value="2026-09-30T22:14:05Z" />);
    expect(document.querySelector('time')!.textContent).not.toMatch(/UTC/);
  });
});

describe('installations', () => {
  const row = (over: Record<string, unknown>) => ({ id: 'id-1', agenfkVersion: '2.0.0', firstSeen: '2026-09-01', lastSeen: '2026-09-30', osUser: 'carol', gitName: 'Carol', gitEmail: null, ...over });

  it('explains "attributed by username" on screen, not in a title', async () => {
    table = { '/v1/admin/installations': [row({})], '/v1/admin/hidden-users': [] };
    mount(<AdminInstallations />);
    expect(await screen.findByText(/filed under an OS username instead of a person/)).toBeVisible();
  });

  it('opens each "no git email" warning to say what it costs', async () => {
    table = { '/v1/admin/installations': [row({})], '/v1/admin/hidden-users': [] };
    mount(<AdminInstallations />);
    const summary = await screen.findByText('no git email — attributed by username');
    expect(summary.tagName).toBe('SUMMARY');
    expect(summary.closest('details')!.textContent!.length).toBeGreaterThan(summary.textContent!.length + 20);
  });

  it('says who retired an installation', async () => {
    table = { '/v1/admin/installations': [row({ gitEmail: 'c@x', retired: true, retiredByEmail: 'admin@acme.dev' })], '/v1/admin/hidden-users': [] };
    mount(<AdminInstallations />);
    await screen.findByText('Carol');
    expect(screen.getByText(/by admin@acme\.dev/)).toBeVisible();
  });
});

describe('upgrades', () => {
  it('a target\'s version says when it was last seen', async () => {
    table = {
      '/v1/admin/upgrade': { directives: [{
        directiveId: 'dir-1', targetVersion: '1.1.21', scope: { type: 'all' }, createdAt: '2026-09-30T10:00:00.000Z',
        createdByUserId: null, createdByEmail: null, requestIp: null, expiresAt: null,
        progress: { pending: 1, in_progress: 0, succeeded: 0, failed: 0, cancelled: 0 },
        targets: [{ installationId: 'i-1', state: 'pending', attemptedAt: null, finishedAt: null, resultVersion: null, errorMessage: null, agenfkVersion: '1.1.20', agenfkVersionUpdatedAt: '2026-09-29T08:00:00Z' }],
      }] },
      '/v1/admin/installations': [], '/v1/admin/upgrade/available-versions': { versions: ['1.1.21'], fleetFloor: null },
      '/v1/admin/child-hubs': { isParent: false, childHubs: [] }, '/v1/admin/upgrade-dispatches': { dispatches: [] },
    };
    mount(<AdminUpgrades />);
    fireEvent.click(await screen.findByRole('button', { expanded: false, name: /1\.1\.21/ }));
    expect(await screen.findByText(/^last seen /)).toHaveClass('sr-only');
  });

  it('a group upgrade lists each skipped installation and why', async () => {
    get.mockImplementation(async () => ({ data: { dispatches: [{
      id: 'd-1', targetVersion: '1.2.3', scope: 'all', cancelledAt: null,
      targets: [{ childHubId: 'ch-a', name: 'alpha', state: 'completed', detail: { counts: { pending: 0, updated: 3, failed: 0, skipped: 2 },
        skipped: [{ installationId: 'i9', reason: 'retired' }, { installationId: 'i7', reason: 'unsupported os' }] } }],
    }] } }));
    mount(<GroupUpgrades />);
    const skips = await screen.findByTestId('group-target-skips-d-1-ch-a');
    expect(skips.tagName).toBe('DETAILS');
    expect(within(skips).getByText('2 skipped')).toBeInTheDocument();
    expect(within(skips).getByText('i9: retired')).toBeInTheDocument();
    expect(within(skips).getByText('i7: unsupported os')).toBeInTheDocument();
    expect(skips).not.toHaveAttribute('title');
  });
});

describe('the models table', () => {
  it('explains "Show all classification rules" as a hint tied to the checkbox', () => {
    mount(<ModelTable groups={[]} metaRows={[] as never} loading={false} onError={() => {}} invalidate={vi.fn()}
      onUnmap={() => {}} unmapping={false} unmappedCount={0} unusedCount={0} />);
    const box = screen.getByRole('checkbox', { name: /Show all classification rules/ });
    expect(box).toHaveAccessibleDescription(/only models actually reported/i);
    expect(screen.queryByText('ⓘ')).toBeNull();
  });
});
