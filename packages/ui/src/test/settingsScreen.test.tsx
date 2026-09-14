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

  it('offers auto-approve, and says what it lets happen', async () => {
    // It lived in the terminal dialog as a per-run decision until the user
    // asked for the dialog to stop asking. Moving it here has a price: a
    // terminal can now open with the rails off on a day nobody thought about
    // it. The description is where that price gets paid, so it has to describe
    // the CONSEQUENCE, not the feature.
    renderShell();
    await openSettings();
    fireEvent.click(within(
      await screen.findByRole('navigation', { name: /settings sections/i }),
    ).getByRole('button', { name: /agents/i }));
    const row = (await screen.findByText(/auto-approve/i))
      .closest<HTMLElement>('[data-testid="setting-row"]')!;
    expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(row).toHaveTextContent(/without asking|permission/i);
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

/**
 * The shape of the screen.
 *
 * A section rail on the left and content on the right, because that is what
 * settings screens look like and because the alternative — one long scroll —
 * stops working the moment there is more than one group.
 *
 * The rail is held to the same rule as the screen itself: it lists sections
 * that exist. A nav entry leading to an empty pane is a worse lie than a
 * missing entry, because the user pays the click to find out.
 */
describe('the shape of it', () => {
  it('puts a section rail beside the content, not above it', async () => {
    renderShell();
    await openSettings();
    const rail = await screen.findByRole('navigation', { name: /settings sections/i });
    expect(rail).toBeInTheDocument();
  });

  it('marks which section you are looking at', async () => {
    // Without this the rail is decoration: two entries and no way to tell
    // which one produced what is on screen.
    renderShell();
    await openSettings();
    const rail = await screen.findByRole('navigation', { name: /settings sections/i });
    const current = within(rail).getByRole('button', { current: 'page' });
    expect(current).toHaveTextContent(/general/i);
  });

  it('lists only sections that have something in them', async () => {
    // Same rule as the panel. Copying a reference app's section list produces
    // entries that lead nowhere, and the user pays a click to discover it.
    //
    // Checked by VISITING each entry rather than counting: one section renders
    // at a time, so a count comparison would pass on any rail with one entry
    // and tell us nothing about the rest.
    renderShell();
    await openSettings();
    const rail = await screen.findByRole('navigation', { name: /settings sections/i });
    const labels = within(rail).getAllByRole('button').map(b => b.textContent);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      fireEvent.click(within(rail).getByRole('button', { name: label! }));
      const panel = await screen.findByRole('tabpanel', { name: /settings/i });
      const rows = panel.querySelectorAll('[data-testid="setting-row"]');
      expect(rows.length, `section "${label}" has no settings in it`).toBeGreaterThan(0);
    }
  });

  it('keeps the rail beside a narrow pane rather than letting the page scroll sideways', async () => {
    // A settings pane that pushes the window into horizontal scroll is the
    // classic two-column failure.
    renderShell();
    await openSettings();
    const panel = await screen.findByRole('tabpanel', { name: /settings/i });
    expect(panel.className).not.toMatch(/overflow-x-auto|overflow-x-scroll/);
    expect(panel.querySelector('[data-testid="settings-body"]')?.className)
      .toMatch(/min-w-0/);
  });
});

/**
 * Saying when a setting cannot actually take effect here.
 *
 * The switch stores a preference; whether tmux exists is a fact about this
 * machine. Turning the setting on where tmux is not installed stores awish
 * that silently does nothing — and the user finds out by quitting the app and
 * losing an agent. That is the exact failure the warning exists to prevent, and
 * it is worth more than the switch itself.
 */
describe('when tmux is not installed', () => {
  const withPersistence = (p: { available: boolean; hint?: string; warning?: string }) => {
    (window as unknown as Record<string, unknown>).agenfkDesktop = {
      isDesktop: true, platform: 'darwin',
      versions: { electron: '40', chrome: '1', node: '24' },
      terminal: { listAgents: async () => [], sessionPersistence: async () => p },
    };
  };

  it('says so on the row, with the command that fixes it', async () => {
    withPersistence({ available: false, hint: 'brew install tmux' });
    renderShell();
    await openSettings();
    const row = (await screen.findByText(/enable tmux/i))
      .closest<HTMLElement>('[data-testid="setting-row"]')!;
    await waitFor(() => expect(row).toHaveTextContent(/brew install tmux/));
  });

  it('still lets the preference be stored, because it is a preference', async () => {
    // Not disabled. The machine cannot honour it today; the choice is still the
    // user's and still travels to a machine that can.
    withPersistence({ available: false, hint: 'brew install tmux' });
    renderShell();
    await openSettings();
    const row = (await screen.findByText(/enable tmux/i))
      .closest<HTMLElement>('[data-testid="setting-row"]')!;
    const toggle = within(row).getByRole('switch');
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ tmuxByDefault: true }));
  });

  it('says nothing extra when tmux IS available', async () => {
    // A warning that is always on screen stops being read.
    withPersistence({ available: true });
    renderShell();
    await openSettings();
    const row = (await screen.findByText(/enable tmux/i))
      .closest<HTMLElement>('[data-testid="setting-row"]')!;
    expect(row).not.toHaveTextContent(/brew|not installed/i);
  });
});
