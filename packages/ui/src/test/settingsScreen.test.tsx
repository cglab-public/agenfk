/**
 * @vitest-environment jsdom
 *
 * A place to change a preference without starting a task.
 *
 * Until now the only way to turn tmux on was the dialog that opens a terminal,
 * which means changing a PREFERENCE required beginning an ACTION. Those are
 * different things and putting them in the same place makes the preference
 * hard to find and the action heavier than it should be.
 *
 * Two things this file insists on, both learned the hard way in this epic:
 *
 * **The entry is pinned, not scrolled.** The projects list grows without limit;
 * anything below it in the same scroll container is unreachable in practice on
 * the day a user has thirty cards in flight.
 *
 * **The screen shows only settings that exist.** Empty sections copied from a
 * reference are worse than no section: they promise a control that is not
 * there, and the user goes looking for it twice.
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
    listProjects: vi.fn(async () => [
      { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
    ]),
    listActiveItems: vi.fn(async () => []),
    listRuns: vi.fn(async () => []),
    getVersion: vi.fn(async () => ({ version: '1.1.18' })),
    getReadme: vi.fn(async () => ({ content: '' })),
    getLatestRelease: vi.fn(async () => null),
    updateItem: vi.fn(async () => ({})),
    getSettings: vi.fn(async () => ({ tmuxByDefault: false })),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({
      tmuxByDefault: false, ...patch,
    })),
  },
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connected: true, connect: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn(),
  })),
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.listProjects).mockResolvedValue([
    { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
  ] as never);
  vi.mocked(api.getSettings).mockResolvedValue({ tmuxByDefault: false } as never);
  Object.defineProperty(window, 'agenfkDesktop', {
    value: {
      isDesktop: true, platform: 'darwin',
      versions: { electron: '40', chrome: '1', node: '24' },
      terminal: {
        listAgents: async () => [],
        sessionPersistence: async () => ({ available: true }),
      },
    },
    configurable: true, writable: true,
  });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(q => ({
      matches: false, media: q, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
});
afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).agenfkDesktop;
});

const renderShell = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ActiveProjectProvider>
        <SocketProvider>
          <AppShell><div>board</div></AppShell>
        </SocketProvider>
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
};

const openSettings = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }));
};

describe('getting to it', () => {
  it('pins the entry below the sessions rail, out of the scrolling list', async () => {
    // The projects list has no upper bound. An entry that scrolls with it is
    // one a user with thirty cards in flight cannot reach.
    renderShell();
    const entry = await screen.findByRole('button', { name: /^settings$/i });
    const nav = entry.closest('[data-testid="shell-nav"]');
    expect(nav).not.toBeNull();
    expect(nav!.className).toMatch(/shrink-0/);
    expect(nav!.className).not.toMatch(/overflow-y-auto/);
  });

  it('opens the settings panel and leaves the board mounted behind it', async () => {
    // Same rule as the terminal panel: panels are hidden, not unmounted.
    // Unmounting the board would throw away scroll position and any in-flight
    // edit for the sake of looking at a checkbox.
    renderShell();
    await openSettings();
    const panel = await screen.findByRole('tabpanel', { name: /settings/i });
    expect(panel).toBeVisible();
    expect(screen.getByText('board')).toBeInTheDocument();
  });
});

describe('what it offers', () => {
  it('offers the tmux setting, naming the consequence rather than the tool', async () => {
    renderShell();
    await openSettings();
    const row = (await screen.findByText(/enable tmux/i)).closest<HTMLElement>('[data-testid="setting-row"]')!;
    expect(within(row).getByRole('switch')).toBeInTheDocument();
    // The description has to say what it DOES. "Enable tmux" alone tells a
    // user who has never heard of tmux precisely nothing.
    expect(row).toHaveTextContent(/session|terminal/i);
  });

  it('shows the stored value, not a fresh default', async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ tmuxByDefault: true } as never);
    renderShell();
    await openSettings();
    const row = (await screen.findByText(/enable tmux/i)).closest<HTMLElement>('[data-testid="setting-row"]')!;
    await waitFor(() =>
      expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
  });

  it('stores a change where every client can read it', async () => {
    renderShell();
    await openSettings();
    const row = (await screen.findByText(/enable tmux/i)).closest<HTMLElement>('[data-testid="setting-row"]')!;
    fireEvent.click(within(row).getByRole('switch'));
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ tmuxByDefault: true }));
  });

  it('does not offer an auto-approve default', async () => {
    // Deliberate. Disabling an agent's permission prompts is a decision per
    // run: a stored default that is ON means a terminal opens with no rails on
    // a day the user never asked for that.
    renderShell();
    await openSettings();
    await screen.findByText(/enable tmux/i);
    expect(screen.queryByText(/auto-approve/i)).not.toBeInTheDocument();
  });

  it('has no empty sections', async () => {
    // A heading with no control under it promises something that is not there,
    // and the user goes looking for it twice.
    renderShell();
    await openSettings();
    const panel = await screen.findByRole('tabpanel', { name: /settings/i });
    const sections = panel.querySelectorAll('[data-testid="settings-section"]');
    expect(sections.length).toBeGreaterThan(0);
    sections.forEach(section => {
      expect(section.querySelectorAll('[data-testid="setting-row"]').length).toBeGreaterThan(0);
    });
  });
});

describe('when the setting cannot be saved', () => {
  it('goes back to what is actually stored instead of showing a lie', async () => {
    // An optimistic switch that stays on after the write failed tells the user
    // their terminals are protected when they are not. Reverting is the honest
    // failure, and it is the one that costs them nothing.
    vi.mocked(api.updateSettings).mockRejectedValue(new Error('server down'));
    renderShell();
    await openSettings();
    const row = (await screen.findByText(/enable tmux/i)).closest<HTMLElement>('[data-testid="setting-row"]')!;
    const toggle = within(row).getByRole('switch');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  });
});
