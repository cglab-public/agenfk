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
    // A region, not a tabpanel: nothing in the tablist owns this panel, and an
    // orphan tabpanel reports a tablist with nothing selected.
    const panel = await screen.findByRole('region', { name: /settings/i });
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
    const panel = await screen.findByRole('region', { name: /settings/i });
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
      const panel = await screen.findByRole('region', { name: /settings/i });
      const rows = panel.querySelectorAll('[data-testid="setting-row"]');
      expect(rows.length, `section "${label}" has no settings in it`).toBeGreaterThan(0);
    }
  });

  it('keeps the rail beside a narrow pane rather than letting the page scroll sideways', async () => {
    // A settings pane that pushes the window into horizontal scroll is the
    // classic two-column failure.
    renderShell();
    await openSettings();
    const panel = await screen.findByRole('region', { name: /settings/i });
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

describe('on Windows, where tmux cannot exist at all', () => {
  it('gives the platform reason instead of an install command that would not work', async () => {
    // Restored after nearly being lost with the terminal dialog. Telling a
    // Windows user to `brew install tmux` is worse than saying nothing: it
    // sends them after a fix that does not exist on their machine.
    (window as unknown as Record<string, unknown>).agenfkDesktop = {
      isDesktop: true, platform: 'win32',
      versions: { electron: '40', chrome: '1', node: '24' },
      terminal: {
        listAgents: async () => [],
        sessionPersistence: async () => ({ available: false, warning: 'tmux_unsupported_on_windows' }),
      },
    };
    renderShell();
    await openSettings();
    const row = (await screen.findByText(/enable tmux/i))
      .closest<HTMLElement>('[data-testid="setting-row"]')!;
    await waitFor(() => expect(row).toHaveTextContent(/windows/i));
    expect(row).not.toHaveTextContent(/brew|apt/i);
  });
});

/**
 * Saying which agents will ignore auto-approve.
 *
 * The terminal dialog used to disable its toggle for an agent that has no flag
 * for this, and say which agent and why. That disappeared with the dialog, and
 * what disappeared with it was the honesty: the setting is global, the support
 * is not, and a switch reading "on" over an agent that silently ignores it
 * tells the user the rails are off when they are not — the precise failure the
 * old toggle existed to prevent.
 */
describe('auto-approve is not honoured by every agent', () => {
  const withAgents = (agents: unknown[]) => {
    (window as unknown as Record<string, unknown>).agenfkDesktop = {
      isDesktop: true, platform: 'darwin',
      versions: { electron: '40', chrome: '1', node: '24' },
      terminal: {
        listAgents: async () => agents,
        sessionPersistence: async () => ({ available: true }),
      },
    };
  };
  const agentsRow = async () => {
    fireEvent.click(within(
      await screen.findByRole('navigation', { name: /settings sections/i }),
    ).getByRole('button', { name: /agents/i }));
    return (await screen.findByText(/auto-approve/i))
      .closest<HTMLElement>('[data-testid="setting-row"]')!;
  };

  it('names the ones that will ignore it', async () => {
    withAgents([
      { id: 'claude-code', label: 'Claude Code', installed: true, supportsAutoApprove: true },
      { id: 'gemini', label: 'Gemini CLI', installed: true, supportsAutoApprove: false },
      { id: 'pi', label: 'Pi', installed: true, supportsAutoApprove: false },
    ]);
    renderShell();
    await openSettings();
    const row = await agentsRow();
    await waitFor(() => expect(row).toHaveTextContent(/Gemini CLI/));
    expect(row).toHaveTextContent(/Pi/);
    // Never the ones that DO honour it: a list of everything is a list of
    // nothing, and the reader has to work out which half matters.
    expect(row).not.toHaveTextContent(/Claude Code/);
  });

  it('says nothing when every installed agent honours it', async () => {
    // A caveat permanently on screen stops being read.
    withAgents([
      { id: 'claude-code', label: 'Claude Code', installed: true, supportsAutoApprove: true },
    ]);
    renderShell();
    await openSettings();
    const row = await agentsRow();
    await waitFor(() => expect(row).toHaveTextContent(/auto-approve/i));
    expect(row).not.toHaveTextContent(/ignore/i);
  });

  it('ignores agents that are not installed', async () => {
    // Warning about an agent the user cannot launch is noise about a choice
    // they cannot make.
    withAgents([
      { id: 'claude-code', label: 'Claude Code', installed: true, supportsAutoApprove: true },
      { id: 'gemini', label: 'Gemini CLI', installed: false, supportsAutoApprove: false },
    ]);
    renderShell();
    await openSettings();
    const row = await agentsRow();
    await waitFor(() => expect(row).toHaveTextContent(/auto-approve/i));
    expect(row).not.toHaveTextContent(/Gemini/);
  });
});

describe('when the machine cannot be asked', () => {
  it('claims nothing while the probe is still in flight', async () => {
    // An enabled-looking warning that appears and then corrects itself reads as
    // a glitch; claiming availability before checking is worse.
    (window as unknown as Record<string, unknown>).agenfkDesktop = {
      isDesktop: true, platform: 'darwin',
      versions: { electron: '40', chrome: '1', node: '24' },
      terminal: { listAgents: async () => [], sessionPersistence: () => new Promise(() => {}) },
    };
    renderShell();
    await openSettings();
    const row = (await screen.findByText(/enable tmux/i))
      .closest<HTMLElement>('[data-testid="setting-row"]')!;
    expect(row).not.toHaveTextContent(/not available/i);
  });

  it('claims nothing when the probe fails outright', async () => {
    (window as unknown as Record<string, unknown>).agenfkDesktop = {
      isDesktop: true, platform: 'darwin',
      versions: { electron: '40', chrome: '1', node: '24' },
      terminal: {
        listAgents: async () => [],
        sessionPersistence: async () => { throw new Error('ipc down'); },
      },
    };
    renderShell();
    await openSettings();
    const row = (await screen.findByText(/enable tmux/i))
      .closest<HTMLElement>('[data-testid="setting-row"]')!;
    expect(row).not.toHaveTextContent(/not available/i);
  });
});

/**
 * Reachability, which is the difference between a settings screen and none.
 *
 * An adversarial review found the entry rendered INSIDE the sidebar's
 * `open` guard, so collapsing the sidebar removed the only route to Settings —
 * and the sidebar state is persisted, so that was permanent across launches.
 * With both dialog toggles gone, that left a user with no way to change tmux or
 * auto-approve at all, ever.
 *
 * Worse than the bug was the shape of it: the button carried an icon-only
 * collapsed variant, written for a state it could never be rendered in. The
 * code looked like it handled the case it was breaking.
 */
describe('reachability', () => {
  it('is still reachable with the sidebar collapsed', async () => {
    // The persisted-collapsed user. This is not an edge case: the sidebar
    // remembers, so one click a month ago decides every launch since.
    // 'collapsed' is the stored value; anything else reads as open. Writing
    // 'false' here left the sidebar OPEN and the test passed without ever
    // exercising the case it is named for.
    localStorage.setItem('agenfk_shell_sidebar', 'collapsed');
    renderShell();
    expect(await screen.findByRole('button', { name: /^settings$/i })).toBeInTheDocument();
  });

  it('opens from the collapsed sidebar too, not just renders', async () => {
    // 'collapsed' is the stored value; anything else reads as open. Writing
    // 'false' here left the sidebar OPEN and the test passed without ever
    // exercising the case it is named for.
    localStorage.setItem('agenfk_shell_sidebar', 'collapsed');
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }));
    expect(await screen.findByText(/enable tmux/i)).toBeInTheDocument();
  });
});

describe('the warning has to be readable in both themes', () => {
  it('pairs the light and dark colour, like every other warning in this app', async () => {
    // text-amber-400 alone is ~1.6:1 on the light theme's near-white card. The
    // one message that says "sessions will not survive quitting" was the least
    // affordable thing on the screen to render illegible. Every other
    // amber text in this codebase is written as a light/dark pair.
    (window as unknown as Record<string, unknown>).agenfkDesktop = {
      isDesktop: true, platform: 'darwin',
      versions: { electron: '40', chrome: '1', node: '24' },
      terminal: {
        listAgents: async () => [],
        sessionPersistence: async () => ({ available: false, hint: 'brew install tmux' }),
      },
    };
    renderShell();
    await openSettings();
    const note = await screen.findByTestId('setting-note');
    expect(note.className).toMatch(/text-amber-600/);
    expect(note.className).toMatch(/dark:text-amber-400/);
  });
});

describe('a save that fails has to say so', () => {
  it('shows a message rather than a switch that quietly did not move', async () => {
    // Nothing is written optimistically, so a failed save does not "revert" —
    // it does nothing at all, which is indistinguishable from missing the hit
    // target. The old test asserted aria-checked stayed false, which is also
    // what a missed click produces, so it could not tell the two apart.
    vi.mocked(api.updateSettings).mockRejectedValue(new Error('server down'));
    renderShell();
    await openSettings();
    const row = (await screen.findByText(/enable tmux/i))
      .closest<HTMLElement>('[data-testid="setting-row"]')!;
    fireEvent.click(within(row).getByRole('switch'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not|failed|not saved/i);
  });

  it('does not claim a setting is off when it could not be read', async () => {
    // `settings?.x ?? false` renders both switches OFF on a failed read. For
    // tmux that means the app spawns non-persistent terminals for someone whose
    // stored preference is on; for auto-approve it means the screen asserts a
    // safety property it never verified.
    vi.mocked(api.getSettings).mockRejectedValue(new Error('offline'));
    renderShell();
    await openSettings();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not|failed|unavailable/i);
  });
});

describe('the shell is not an agent that "ignores" auto-approve', () => {
  it('never lists it, since it has no permission prompts to skip', async () => {
    // `shell` is ALWAYS_AVAILABLE and has no autoApproveArgs, so the naive
    // filter named it for every user, permanently — and said it "always asks",
    // which is nonsense about a login shell. The previous test passed only
    // because its fixture left shell out: a shape the real producer never
    // emits.
    (window as unknown as Record<string, unknown>).agenfkDesktop = {
      isDesktop: true, platform: 'darwin',
      versions: { electron: '40', chrome: '1', node: '24' },
      terminal: {
        listAgents: async () => [
          { id: 'claude-code', label: 'Claude Code', installed: true, supportsAutoApprove: true },
          { id: 'shell', label: 'Shell', installed: true, supportsAutoApprove: false },
        ],
        sessionPersistence: async () => ({ available: true }),
      },
    };
    renderShell();
    await openSettings();
    fireEvent.click(within(
      await screen.findByRole('navigation', { name: /settings sections/i }),
    ).getByRole('button', { name: /agents/i }));
    const row = (await screen.findByText(/auto-approve/i))
      .closest<HTMLElement>('[data-testid="setting-row"]')!;
    await waitFor(() => expect(row).toHaveTextContent(/auto-approve/i));
    expect(row).not.toHaveTextContent(/Shell/);
  });
});

describe('what the tmux note actually promises', () => {
  const withTmuxMissing = async (): Promise<string> => {
    (window as unknown as Record<string, unknown>).agenfkDesktop = {
      isDesktop: true, platform: 'darwin',
      versions: { electron: '40', chrome: '1', node: '24' },
      terminal: {
        listAgents: async () => [],
        sessionPersistence: async () => ({ available: false, hint: 'brew install tmux' }),
      },
    };
    renderShell();
    await openSettings();
    return (await screen.findByTestId('setting-note')).textContent ?? '';
  };

  it('does not say sessions are lost, because they are not', async () => {
    /*
     * THE test. The card that filed this said the warning claims too much -
     * the PROCESS does not survive quitting, the SESSION does - and the fix
     * corrected the console line, which almost nobody reads, while Settings
     * went on saying "sessions will not survive quitting". That is the screen
     * a person lands on when they wonder about tmux.
     *
     * Wrong in the harmful direction: it tells somebody their work is lost
     * when the session is recorded server-side and put back, which pushes them
     * into copying scrollback out by hand before quitting - the exact
     * behaviour the card was written to stop.
     */
    const note = await withTmuxMissing();
    expect(note, 'Settings still claims the session is lost').not.toMatch(/sessions will not survive/i);
  });

  it('says the terminals come back', async () => {
    const note = await withTmuxMissing();
    expect(note).toMatch(/reopened/i);
  });

  it('does not promise every agent resumes its conversation', async () => {
    // Only the agents that can be handed a session id do. Saying it flatly
    // would be the same overstatement one layer over.
    const note = await withTmuxMissing();
    expect(note).toMatch(/agents that support it/i);
  });
});
