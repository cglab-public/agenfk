/**
 * @vitest-environment jsdom
 *
 * The shell's tab bar, as something the user owns (CGLAB-178).
 *
 * It was three entries written in code. What the team likes elsewhere is
 * opening as many as they want, each holding a context, and switching without
 * losing anything — so the list has to become state, and state that survives
 * closing the app.
 *
 * The groundwork was already here and is worth naming, because it is why this
 * is a small change rather than a rewrite: panels are hidden and never
 * unmounted, so switching has never cost anything, and the tablist already
 * has keyboard navigation.
 *
 * Two rules this file exists to hold:
 *
 * **The built-in tabs cannot be closed.** A user who closes Kanban has no way
 * back to the board, and a tab bar that can be emptied is a dead end.
 *
 * **The order is the user's.** It is remembered, because rearranging something
 * that resets on the next launch is worse than not being able to rearrange it.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { AppShell } from '../components/AppShell';
import { ActiveProjectProvider } from '../ActiveProject';
import { SocketProvider } from '../SocketContext';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(async () => [{ id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() }]),
    listActiveItems: vi.fn(async () => []),
    listRuns: vi.fn(async () => []),
    getVersion: vi.fn(async () => ({ version: '1.1.18' })),
    getReadme: vi.fn(async () => ({ content: '' })),
    getLatestRelease: vi.fn(async () => null),
    updateItem: vi.fn(async () => ({})),
    getSettings: vi.fn(async () => ({ tmuxByDefault: false })),
    updateSettings: vi.fn(async () => ({ tmuxByDefault: false })),
    listTerminalSessions: vi.fn(async () => []),
    recordTerminalSession: vi.fn(async () => ({ id: 'row-1' })),
    forgetTerminalSession: vi.fn(async () => {}),
    getGitStatus: vi.fn(async () => ({ changed: 0, staged: 0, files: [] })),
    listWorktreeFiles: vi.fn(async () => ({ path: '', entries: [] })),
  },
}));
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ connected: true, connect: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn() })),
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.listProjects).mockResolvedValue([
    { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
  ] as never);
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(q => ({
      matches: false, media: q, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
});
afterEach(cleanup);

const renderShell = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ActiveProjectProvider>
      <SocketProvider>
        <AppShell><div>board</div></AppShell>
      </SocketProvider>
    </ActiveProjectProvider>
  </QueryClientProvider>,
);

const shellTabs = async () =>
  within(await screen.findByRole('tablist', { name: /views/i })).getAllByRole('tab');

describe('the tabs the shell starts with', () => {
  it('still opens on the board', async () => {
    renderShell();
    const tabs = await shellTabs();
    expect(tabs[0]).toHaveTextContent(/kanban/i);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('cannot close a built-in tab, because there would be no way back', async () => {
    renderShell();
    const tabs = await shellTabs();
    expect(within(tabs[0].parentElement!).queryByRole('button', { name: /close/i })).toBeNull();
  });
});

describe('remembering the order', () => {
  it('restores an order the user chose', async () => {
    // Rearranging something that resets on the next launch is worse than not
    // being able to rearrange it at all.
    localStorage.setItem('agenfk_shell_tabs', JSON.stringify(['runs', 'kanban', 'terminal']));
    renderShell();
    const tabs = await shellTabs();
    expect(tabs[0]).toHaveTextContent(/runs/i);
  });

  it('ignores a stored order that names a tab it does not have', async () => {
    // Written by an older or newer build. Trusting it blindly would render a
    // tab bar with a hole in it, or drop a tab the user needs.
    localStorage.setItem('agenfk_shell_tabs', JSON.stringify(['nonsense', 'kanban']));
    renderShell();
    const tabs = await shellTabs();
    expect(tabs.map(t => t.textContent).join(' ')).toMatch(/kanban/i);
    expect(tabs.map(t => t.textContent).join(' ')).toMatch(/runs/i);
  });

  it('survives a stored value that is not even a list', async () => {
    localStorage.setItem('agenfk_shell_tabs', '{"not":"an array"}');
    renderShell();
    expect((await shellTabs()).length).toBeGreaterThan(0);
  });

  it('writes the order when it changes', async () => {
    renderShell();
    const tabs = await shellTabs();
    fireEvent.click(within(tabs[1].parentElement!).getByRole('button', { name: /move .* left/i }));
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('agenfk_shell_tabs') ?? '[]');
      expect(stored[0]).toBe('terminal');
    });
  });
});

describe('rearranging', () => {
  it('moves a tab left, and the selection follows the tab', async () => {
    // The selection belongs to the tab, not to the position. Moving the tab
    // you are looking at must not switch you to a different view.
    renderShell();
    let tabs = await shellTabs();
    fireEvent.click(tabs[1]);
    fireEvent.click(within(tabs[1].parentElement!).getByRole('button', { name: /move .* left/i }));
    tabs = await shellTabs();
    expect(tabs[0]).toHaveTextContent(/terminal/i);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('offers no move-left on the first tab, which has nowhere to go', async () => {
    renderShell();
    const tabs = await shellTabs();
    expect(within(tabs[0].parentElement!).queryByRole('button', { name: /move .* left/i })).toBeNull();
  });
});
