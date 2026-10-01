/**
 * @vitest-environment jsdom
 *
 * Admin → Upgrades: a cancel the hub refuses must say so where the admin
 * clicked. The error used to go into the issue form's banner, which renders
 * only while that form is open, so a failed cancel showed nothing at all.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminUpgrades } from '../pages/AdminUpgrades';
import { api } from '../api';
import { ThemeProvider } from '../ThemeContext';
import { answerConfirm, forbidWindowConfirm } from './helpers/confirmDialog';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

const DIRECTIVE = {
  directiveId: 'dir-1',
  targetVersion: '1.1.21',
  scope: { type: 'all' },
  createdAt: '2026-09-30T10:00:00.000Z',
  createdByUserId: null,
  createdByEmail: null,
  requestIp: null,
  expiresAt: null,
  progress: { pending: 1, in_progress: 0, succeeded: 0, failed: 0, cancelled: 0 },
  targets: [],
};

const renderPage = (directives: unknown[] = [DIRECTIVE]) => {
  const table: Record<string, unknown> = {
    '/v1/admin/upgrade': { directives },
    '/v1/admin/upgrade/available-versions': { versions: ['1.1.21'], fleetFloor: null },
    '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
    '/v1/admin/upgrade-dispatches': { dispatches: [] },
  };
  get.mockImplementation(async (url: string) => ({ data: table[url] ?? [] }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider><AdminUpgrades /></ThemeProvider>
    </QueryClientProvider>,
  );
};

let confirmSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  get.mockReset(); post.mockReset();
  confirmSpy = forbidWindowConfirm();
});
afterEach(() => { cleanup(); confirmSpy.mockRestore(); });

describe('AdminUpgrades — a refused cancel', () => {
  it('shows the hub\'s reason without opening the issue form', async () => {
    post.mockRejectedValueOnce({ response: { status: 403, data: { error: 'Admins only' } } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel waiting' }));
    await answerConfirm(true);
    expect(await screen.findByRole('alert')).toHaveTextContent('Admins only');
  });

  it('clears the message once a later cancel succeeds', async () => {
    post.mockRejectedValueOnce({ response: { status: 500, data: { error: 'Database unavailable' } } });
    post.mockResolvedValueOnce({ data: { cancelledCount: 1 } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel waiting' }));
    await answerConfirm(true);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel waiting' }));
    await answerConfirm(true);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('does not leak into the issue form', async () => {
    post.mockRejectedValueOnce({ response: { status: 404, data: { error: 'Upgrade not found' } } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel waiting' }));
    await answerConfirm(true);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /Issue upgrade/ }));
    expect(screen.getAllByText('Upgrade not found')).toHaveLength(1);
  });

  it('shows the message on the row whose cancel was refused', async () => {
    const other = { ...DIRECTIVE, directiveId: 'dir-2', targetVersion: '1.1.22' };
    post.mockRejectedValueOnce({ response: { status: 404, data: { error: 'Upgrade not found' } } });
    renderPage([DIRECTIVE, other]);
    const row = (v: string) => screen.getByText(v).closest('.rounded-md') as HTMLElement;
    await screen.findByText('v1.1.22');
    fireEvent.click(within(row('v1.1.22')).getByRole('button', { name: 'Cancel waiting' }));
    await answerConfirm(true);
    await waitFor(() => expect(within(row('v1.1.22')).getByRole('alert')).toHaveTextContent('Upgrade not found'));
    expect(within(row('v1.1.21')).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('drops the old message as soon as a retry starts', async () => {
    post.mockRejectedValueOnce({ response: { status: 500, data: { error: 'Database unavailable' } } });
    post.mockReturnValueOnce(new Promise(() => {}));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel waiting' }));
    await answerConfirm(true);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel waiting' }));
    await answerConfirm(true);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
