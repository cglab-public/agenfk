/**
 * @vitest-environment jsdom
 *
 * Admin → Upgrades, the group-upgrade board (CGLAB-183, task 4).
 *
 * The helper's unit test pins the wording; this pins that it actually reaches
 * the screen, and that the one distinction the board exists to keep — asked to
 * stop versus stopped — survives rendering.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GroupUpgrades } from '../pages/AdminUpgrades';
import { api } from '../api';
import { ThemeProvider } from '../ThemeContext';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

const dispatches = (over: any[] = []) => ({
  data: {
    dispatches: over.length ? over : [{
      id: 'd-1', targetVersion: '1.2.3', scope: 'all', cancelledAt: null,
      targets: [
        { childHubId: 'ch-a', name: 'alpha', state: 'completed',
          detail: { counts: { pending: 0, updated: 3, failed: 0, skipped: 1 },
                    skipped: [{ installationId: 'i9', reason: 'retired' }] } },
        { childHubId: 'ch-b', name: 'beta', state: 'cancel-pending', detail: null },
      ],
    }],
  },
});

const renderBoard = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider><GroupUpgrades /></ThemeProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  get.mockReset(); post.mockReset();
  get.mockImplementation(async () => dispatches());
  post.mockResolvedValue({ data: { ok: true } });
});
afterEach(() => cleanup());

describe('Admin → Upgrades: the group-upgrade board', () => {
  it('shows each child hub, its state and its counts', async () => {
    renderBoard();
    await waitFor(() => screen.getByTestId('group-target-d-1-ch-a'));
    const a = screen.getByTestId('group-target-d-1-ch-a');
    expect(a.textContent).toContain('alpha');
    expect(a.textContent).toContain('3 updated');
    expect(a.textContent).toContain('1 skipped');
  });

  it('does not tell the admin a hub has stopped when it has only been ASKED to', async () => {
    renderBoard();
    await waitFor(() => screen.getByTestId('group-target-d-1-ch-b'));
    const b = screen.getByTestId('group-target-d-1-ch-b').textContent ?? '';
    expect(b).toContain('Stopping');
    expect(b).not.toContain('Stopped');
  });

  it('surfaces the skip reasons rather than only a number', async () => {
    renderBoard();
    await waitFor(() => screen.getByTestId('group-target-skips-d-1-ch-a'));
    expect(screen.getByTestId('group-target-skips-d-1-ch-a')).toHaveAttribute(
      'title', expect.stringContaining('i9'),
    );
  });

  it('cancels a dispatch through the admin endpoint', async () => {
    renderBoard();
    await waitFor(() => screen.getByTestId('group-dispatch-cancel-d-1'));
    fireEvent.click(screen.getByTestId('group-dispatch-cancel-d-1'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/upgrade-dispatches/d-1/cancel', {}));
  });

  it('offers no cancel for a dispatch already cancelled, and says it is', async () => {
    get.mockImplementation(async () => dispatches([{
      id: 'd-2', targetVersion: '1.2.3', scope: 'all', cancelledAt: '2026-09-15T10:00:00Z', targets: [],
    }]));
    renderBoard();
    await waitFor(() => screen.getByTestId('group-dispatch-cancelled-d-2'));
    expect(screen.queryByTestId('group-dispatch-cancel-d-2')).toBeNull();
  });

  it('says nobody has polled yet rather than rendering an empty space', async () => {
    // Under scope 'all' a hub appears only once it polls, so an empty target
    // list means "not picked up", not "not targeted".
    get.mockImplementation(async () => dispatches([{
      id: 'd-3', targetVersion: '1.2.3', scope: 'all', cancelledAt: null, targets: [],
    }]));
    renderBoard();
    await waitFor(() => screen.getByTestId('group-dispatch-unpolled-d-3'));
  });

  it('renders nothing at all on a hub with no child hubs', async () => {
    // A standalone hub must not be shown a control it can never use.
    get.mockImplementation(async () => ({ data: { dispatches: [] } }));
    const { container } = renderBoard();
    await waitFor(() => expect(screen.queryByTestId('group-upgrades')).toBeNull());
    expect(container.textContent).toBe('');
  });
});
