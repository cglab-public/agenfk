/**
 * @vitest-environment jsdom
 *
 * A place to change a preference without starting a task.
 *
 * Until now the only way to turn a preference on was the dialog that opens a
 * terminal, which means changing a PREFERENCE required beginning an ACTION.
 * Those are different things, and putting them in the same place makes the
 * preference hard to find and the action heavier than it should be.
 *
 * The tmux coverage that used to live here went with the General section, which
 * held that one toggle and is pulled while the persistence story is reworked.
 * The SETTING is untouched — still stored, still sent, still read when a
 * terminal is spawned — and packages/server/src/test/app-settings.test.ts still
 * covers it end to end. Only the screen lost its switch.
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

/**
 * What the server answers, which is not the same as what the screen defaults to.
 *
 * A fixture that omits a field the real route always sends lets a component
 * pass on `?? false` and fail in the app. Every key `DEFAULT_APP_SETTINGS`
 * defines is here.
 *
 * `vi.hoisted` because `vi.mock` factories are lifted above the file body, so
 * an ordinary const declared below is still in its temporal dead zone when the
 * factory runs.
 */
const STORED_DEFAULTS = vi.hoisted(() => ({
  tmuxByDefault: false,
  attentionAlerts: true,
  attentionSound: true,
  soundTiming: 'unfocused' as const,
  osNotifications: true,
}));

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
    getSettings: vi.fn(async () => ({ ...STORED_DEFAULTS })),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({
      ...STORED_DEFAULTS, ...patch,
    })),
    getGitHubAccount: vi.fn(async () => ({ connected: false, reason: 'not_authenticated' })),
    signOutGitHub: vi.fn(async () => ({ signedOut: true })),
    getTelemetryConfig: vi.fn(async () => ({ telemetryEnabled: true, installationId: 'i' })),
    setTelemetryConfig: vi.fn(async (enabled: boolean) => ({ telemetryEnabled: enabled })),
  },
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connected: true, connect: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn(),
  })),
}));

/**
 * The sound itself, stubbed at its own module boundary.
 *
 * jsdom has no Web Audio and no HTMLMediaElement that plays anything, so a
 * preview button tested through the real module would only ever prove that
 * nothing threw. What this screen is responsible for is ASKING for the sound;
 * whether the sound comes out is `attentionSound.test.ts`.
 */
const previewed = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../attentionSound', () => ({
  playAttentionSound: previewed,
  // The panel imports this alongside it. A partial module mock leaves
  // `browserSoundDeps` undefined, and the preview button then throws on click
  // rather than proving anything about the preview.
  browserSoundDeps: vi.fn(() => ({})),
}));

/**
 * The custom-sound half of the desktop bridge, per test.
 *
 * Typed as their real signatures rather than as a bare `Mock`, because
 * `ReturnType<typeof vi.fn>` is callable-or-constructable and TypeScript
 * refuses to call it — the build fails where vitest, which does not type-check,
 * is perfectly happy.
 */
let chooseSound: ReturnType<typeof vi.fn<() => Promise<{ name: string | null; error?: string }>>>;
let clearSound: ReturnType<typeof vi.fn<() => Promise<{ name: string | null }>>>;
let chosenSound: { name: string | null } | null;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  previewed.mockResolvedValue(true);
  chosenSound = null;
  chooseSound = vi.fn(async () => ({ name: 'Picked.wav' }));
  clearSound = vi.fn(async () => ({ name: null }));
  vi.mocked(api.listProjects).mockResolvedValue([
    { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
  ] as never);
  vi.mocked(api.getSettings).mockResolvedValue({ ...STORED_DEFAULTS } as never);
  vi.mocked(api.updateSettings).mockImplementation(
    async (patch) => ({ ...STORED_DEFAULTS, ...patch }) as never,
  );
  vi.mocked(api.getGitHubAccount).mockResolvedValue(
    { connected: false, reason: 'not_authenticated' } as never,
  );
  vi.mocked(api.getTelemetryConfig).mockResolvedValue(
    { telemetryEnabled: true, installationId: 'i' } as never,
  );
  vi.mocked(api.setTelemetryConfig).mockImplementation(
    async (enabled) => ({ telemetryEnabled: enabled }) as never,
  );
  vi.mocked(api.getVersion).mockResolvedValue({ version: '1.1.18' } as never);
  vi.mocked(api.getLatestRelease).mockResolvedValue(null as never);
  Object.defineProperty(window, 'agenfkDesktop', {
    value: {
      isDesktop: true, platform: 'darwin',
      versions: { electron: '40', chrome: '1', node: '24' },
      terminal: {
        listAgents: async () => [],
        sessionPersistence: async () => ({ available: true }),
      },
      sounds: {
        // `chosenSound` is read at CALL time, so a test can set it before
        // rendering without rebuilding the whole bridge object.
        current: async () => chosenSound ?? { name: null },
        choose: () => chooseSound(),
        clear: () => clearSound(),
        read: async () => ({ dataUrl: null, name: null }),
      },
      notifications: { attention: async () => true },
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

/** Open the screen and stay on whatever section it chose to show first. */
const openSettingsRaw = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }));
};

/**
 * Open the screen AT a section.
 *
 * Defaulting to Agents rather than to whatever is first, because that is where
 * the preferences these tests are about now live. It was General, and General
 * is gone: it held only the tmux toggle, which is pulled while the persistence
 * story is reworked.
 */
const openSettings = async (section = 'Agents'): Promise<void> => {
  await openSettingsRaw();
  const rail = await screen.findByRole('navigation', { name: /settings sections/i });
  fireEvent.click(within(rail).getByRole('button', { name: new RegExp(`^${section}$`, 'i') }));
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
    await openSettingsRaw();
    // A region, not a tabpanel: nothing in the tablist owns this panel, and an
    // orphan tabpanel reports a tablist with nothing selected.
    const panel = await screen.findByRole('region', { name: /settings/i });
    expect(panel).toBeVisible();
    expect(screen.getByText('board')).toBeInTheDocument();
  });
});

describe('what it offers', () => {



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
    await openSettingsRaw();
    const panel = await screen.findByRole('region', { name: /settings/i });
    const sections = panel.querySelectorAll('[data-testid="settings-section"]');
    expect(sections.length).toBeGreaterThan(0);
    sections.forEach(section => {
      expect(section.querySelectorAll('[data-testid="setting-row"]').length).toBeGreaterThan(0);
    });
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
    await openSettingsRaw();
    const rail = await screen.findByRole('navigation', { name: /settings sections/i });
    const current = within(rail).getByRole('button', { current: 'page' });
    // Whatever the rail lists first is what the pane shows, and the mark has to
    // agree. Asserting the name of one section would make this a test about the
    // section ORDER, which is a different (and much weaker) claim.
    expect(current).toBe(within(rail).getAllByRole('button')[0]);
  });

  it('opens on the account, which is what the screen is about first', async () => {
    // The order is the reference design's, and it is the right one: "who am I
    // signed in as" is the question a settings screen gets opened for.
    renderShell();
    await openSettingsRaw();
    const rail = await screen.findByRole('navigation', { name: /settings sections/i });
    // Asserted as the EXACT list rather than a contains, so a section
    // appearing or vanishing is a decision somebody has to come here and make.
    // General is absent on purpose: it held only the tmux toggle.
    expect(within(rail).getAllByRole('button').map(b => b.textContent))
      .toEqual(['Account', 'App', 'Notifications', 'Terminal', 'Agents']);
  });

  it('lists only sections that have something in them', async () => {
    // Same rule as the panel. Copying a reference app's section list produces
    // entries that lead nowhere, and the user pays a click to discover it.
    //
    // Checked by VISITING each entry rather than counting: one section renders
    // at a time, so a count comparison would pass on any rail with one entry
    // and tell us nothing about the rest.
    renderShell();
    await openSettingsRaw();
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
    await openSettingsRaw();
    const panel = await screen.findByRole('region', { name: /settings/i });
    expect(panel.className).not.toMatch(/overflow-x-auto|overflow-x-scroll/);
    expect(panel.querySelector('[data-testid="settings-body"]')?.className)
      .toMatch(/min-w-0/);
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


/**
 * Reachability, which is the difference between a settings screen and none.
 *
 * An adversarial review found the entry rendered INSIDE the sidebar's
 * `open` guard, so collapsing the sidebar removed the only route to Settings —
 * and the sidebar state is persisted, so that was permanent across launches.
 * With both dialog toggles gone, that left a user with no way to reach any
 * preference at all, ever.
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
});

describe('a save that fails has to say so', () => {
  it('does not claim a setting is off when it could not be read', async () => {
    // `settings?.x ?? false` renders every switch OFF on a failed read, which
    // for auto-approve means the screen asserts a safety property it never
    // verified — so the read failure has to be said out loud instead.
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


/**
 * The account block.
 *
 * Everything here is READ from the GitHub CLI's existing credential. The app
 * does not hold a GitHub token, has no OAuth client and no callback URL, and
 * adding one would give the machine two GitHub identities that can disagree —
 * which is the failure the card names in its own words.
 *
 * So the interesting cases are the ones where the credential is not there, and
 * the rule for all of them is the same: say which of the two problems it is,
 * because "install the GitHub CLI" and "run gh auth login" are different
 * instructions and only one is useful at a time.
 */
/**
 * A row, found by WHAT IT IS rather than by its copy.
 *
 * Every row carries `data-testid="setting-row"` for the section-level checks,
 * so the individual rows are addressed by a second attribute. Matching on the
 * visible text instead would make each of these a test about the wording, and
 * the wording is the part most likely to change for good reasons.
 */
const settingRow = async (name: string): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(document.querySelector(`[data-row="${name}"]`), `no ${name} on screen`).not.toBeNull();
  });
  return document.querySelector(`[data-row="${name}"]`) as HTMLElement;
};

const accountRow = async (): Promise<HTMLElement> => {
  await openSettings('Account');
  return settingRow('account-row');
};

describe('the account block', () => {
  it('shows the name, the login and the email of the connected account', async () => {
    vi.mocked(api.getGitHubAccount).mockResolvedValue({
      connected: true, login: 'leozin', name: 'Leonardo Rosa',
      email: 'leonardo.silva@cglab.com',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    } as never);
    renderShell();
    const row = await accountRow();
    await waitFor(() => expect(row).toHaveTextContent('Leonardo Rosa'));
    expect(row).toHaveTextContent('leonardo.silva@cglab.com');
    expect(row).toHaveTextContent('leozin');
  });

  it('shows the avatar the API gave it', async () => {
    vi.mocked(api.getGitHubAccount).mockResolvedValue({
      connected: true, login: 'leozin', name: 'Leonardo Rosa', email: null,
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    } as never);
    renderShell();
    const row = await accountRow();
    const img = await within(row).findByRole('img');
    expect(img).toHaveAttribute('src', 'https://avatars.githubusercontent.com/u/1?v=4');
  });

  it('falls back to initials rather than a broken image', async () => {
    // A packaged desktop app is opened offline, and an account with no avatar
    // answers null. A broken-image glyph beside somebody's name is worse than
    // the two letters that identify them.
    vi.mocked(api.getGitHubAccount).mockResolvedValue({
      connected: true, login: 'leozin', name: 'Leonardo Rosa', email: null, avatarUrl: null,
    } as never);
    renderShell();
    const row = await accountRow();
    await waitFor(() => expect(row).toHaveTextContent('Leonardo Rosa'));
    expect(within(row).queryByRole('img')).toBeNull();
  });

  it('does not print the word null where GitHub gave nothing', async () => {
    vi.mocked(api.getGitHubAccount).mockResolvedValue({
      connected: true, login: 'ghost', name: null, email: null, avatarUrl: null,
    } as never);
    renderShell();
    const row = await accountRow();
    await waitFor(() => expect(row).toHaveTextContent('ghost'));
    expect(row).not.toHaveTextContent(/null|undefined/);
  });

  it('offers a sign out, and does not perform it on the first click', async () => {
    // It logs the machine's GitHub CLI out, which is not scoped to this app and
    // not something to do by mis-click on a settings screen.
    vi.mocked(api.getGitHubAccount).mockResolvedValue({
      connected: true, login: 'leozin', name: 'Leonardo Rosa', email: null, avatarUrl: null,
    } as never);
    renderShell();
    const r = await accountRow();
    fireEvent.click(await within(r).findByRole('button', { name: /^sign out$/i }));
    expect(api.signOutGitHub).not.toHaveBeenCalled();
    fireEvent.click(await within(r).findByRole('button', { name: /yes, sign out/i }));
    await waitFor(() => expect(api.signOutGitHub).toHaveBeenCalled());
  });

  it('says what signing out actually affects', async () => {
    // Not "sign out of AgEnFK". The credential belongs to the GitHub CLI and is
    // shared with everything else on the machine that uses gh.
    vi.mocked(api.getGitHubAccount).mockResolvedValue({
      connected: true, login: 'leozin', name: 'Leonardo Rosa', email: null, avatarUrl: null,
    } as never);
    renderShell();
    const row = await accountRow();
    await waitFor(() => expect(row).toHaveTextContent(/github cli|gh\b/i));
  });

  it('reports a sign out that failed instead of showing "not connected"', async () => {
    vi.mocked(api.getGitHubAccount).mockResolvedValue({
      connected: true, login: 'leozin', name: 'Leonardo Rosa', email: null, avatarUrl: null,
    } as never);
    vi.mocked(api.signOutGitHub).mockResolvedValue(
      { signedOut: false, error: 'GH_TOKEN is being used for authentication' } as never,
    );
    renderShell();
    const r = await accountRow();
    fireEvent.click(await within(r).findByRole('button', { name: /^sign out$/i }));
    fireEvent.click(await within(r).findByRole('button', { name: /yes, sign out/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/GH_TOKEN/);
  });

  it('tells a logged-out user the command that connects them', async () => {
    // "the flow that already exists" is gh's own login, which is what
    // `agenfk github setup` already checks for. There is no second flow to build.
    vi.mocked(api.getGitHubAccount).mockResolvedValue(
      { connected: false, reason: 'not_authenticated' } as never,
    );
    renderShell();
    const row = await accountRow();
    await waitFor(() => expect(row).toHaveTextContent('gh auth login'));
  });

  it('tells a user without the CLI to install it, and not to log in', async () => {
    // Telling somebody to run `gh auth login` when they have no `gh` sends them
    // after a command that does not exist on their machine.
    vi.mocked(api.getGitHubAccount).mockResolvedValue(
      { connected: false, reason: 'gh_missing' } as never,
    );
    renderShell();
    const row = await accountRow();
    await waitFor(() => expect(row).toHaveTextContent(/install/i));
    expect(row).not.toHaveTextContent('gh auth login');
  });

  it('re-reads on demand, so a login in another window is picked up', async () => {
    // The user goes to a terminal, runs gh auth login, comes back. Without this
    // the only way to see it is to restart the app.
    renderShell();
    const row = await accountRow();
    await waitFor(() => expect(api.getGitHubAccount).toHaveBeenCalled());
    vi.mocked(api.getGitHubAccount).mockClear();
    fireEvent.click(within(row).getByRole('button', { name: /check again|refresh/i }));
    await waitFor(() => expect(api.getGitHubAccount).toHaveBeenCalled());
  });

  it('claims nothing while the first read is still in flight', async () => {
    // "Not connected" shown for half a second over an account that is connected
    // reads as a bug, and invites the user to go and re-authenticate.
    vi.mocked(api.getGitHubAccount).mockImplementation(() => new Promise(() => {}) as never);
    renderShell();
    const row = await accountRow();
    expect(row).not.toHaveTextContent(/not connected/i);
  });
});

/**
 * The app block: what version this is, and whether anything is being sent home.
 *
 * Both halves already exist and neither is re-implemented here. The version
 * comparison is `ReleaseReminder`'s, moved out of that file so there is one
 * comparator rather than two that can disagree about what "up to date" means.
 * The telemetry flag is the CLI's `agenfk config set telemetry`, reached
 * through the route rather than through a second copy of the rule.
 */
const appRow = async (name: string): Promise<HTMLElement> => {
  await openSettings('App');
  return settingRow(name);
};

describe('the app block', () => {
  it('says which version this is', async () => {
    renderShell();
    await waitFor(async () => expect(await appRow('update-row')).toHaveTextContent('1.1.18'));
  });

  it('says you are up to date when nothing newer exists', async () => {
    vi.mocked(api.getLatestRelease).mockResolvedValue(
      { version: '1.1.18', currentVersion: '1.1.18', tagName: 'v1.1.18', name: '', body: '', publishedAt: '', url: '' } as never,
    );
    renderShell();
    const row = await appRow('update-row');
    await waitFor(() => expect(row).toHaveTextContent(/up to date/i));
  });

  it('does not claim to be up to date when a newer release exists', async () => {
    // The screen would otherwise say "You're up to date" beside the reminder
    // rocket that is on screen at the same time saying the opposite.
    vi.mocked(api.getLatestRelease).mockResolvedValue(
      { version: '1.2.0', currentVersion: '1.1.18', tagName: 'v1.2.0', name: '', body: '', publishedAt: '', url: '' } as never,
    );
    renderShell();
    const row = await appRow('update-row');
    await waitFor(() => expect(row).toHaveTextContent(/1\.2\.0/));
    expect(row).not.toHaveTextContent(/up to date/i);
  });

  it('does not claim to be up to date before it has asked', async () => {
    // getLatestRelease is allowed to fail — it goes to the network. "Up to
    // date" over an unanswered question is a claim the app never verified.
    vi.mocked(api.getLatestRelease).mockRejectedValue(new Error('offline'));
    renderShell();
    const row = await appRow('update-row');
    await waitFor(() => expect(row).toHaveTextContent('1.1.18'));
    expect(row).not.toHaveTextContent(/up to date/i);
  });

  it('checks again when asked', async () => {
    renderShell();
    const row = await appRow('update-row');
    await waitFor(() => expect(api.getLatestRelease).toHaveBeenCalled());
    vi.mocked(api.getLatestRelease).mockClear();
    fireEvent.click(within(row).getByRole('button', { name: /check for updates/i }));
    await waitFor(() => expect(api.getLatestRelease).toHaveBeenCalled());
  });

  it('shows the stored telemetry choice rather than a fresh default', async () => {
    vi.mocked(api.getTelemetryConfig).mockResolvedValue(
      { telemetryEnabled: false, installationId: 'i' } as never,
    );
    renderShell();
    const row = await appRow('telemetry-row');
    await waitFor(() =>
      expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'false'));
  });

  it('writes the telemetry choice where the CLI reads it', async () => {
    renderShell();
    const row = await appRow('telemetry-row');
    await waitFor(() =>
      expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(within(row).getByRole('switch'));
    await waitFor(() => expect(api.setTelemetryConfig).toHaveBeenCalledWith(false));
  });

  it('says what the telemetry actually covers', async () => {
    // A privacy switch with no sentence under it is a switch nobody can make an
    // informed choice about.
    renderShell();
    const row = await appRow('telemetry-row');
    expect(row).toHaveTextContent(/anonymous|usage/i);
  });

  it('says so when the telemetry choice could not be saved', async () => {
    vi.mocked(api.setTelemetryConfig).mockRejectedValue(new Error('server down'));
    renderShell();
    const row = await appRow('telemetry-row');
    await waitFor(() =>
      expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(within(row).getByRole('switch'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not|failed|not saved/i);
  });
});

/**
 * The notifications block.
 *
 * The one rule this block is built around: a control here must change something
 * that actually happens. The signal behind it is real — `activity: 'blocked'`
 * from the main process, which is the agent saying in its own terminal title
 * that it is waiting for a person — and each switch gates a branch that
 * `attentionAlertWiring.test.tsx` drives end to end.
 *
 * The sub-controls are visibly subordinate to the master switch and disabled
 * while it is off, rather than hidden. Hiding them means a user who turns
 * alerts on gets whatever the last stored sub-setting was, with no way to have
 * seen it first.
 */
const notificationsRow = async (name: string): Promise<HTMLElement> => {
  await openSettings('Notifications');
  return settingRow(name);
};

describe('the notifications block', () => {
  it('offers the master switch, and names what it is about', async () => {
    renderShell();
    const row = await notificationsRow('attention-row');
    await waitFor(() =>
      expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    expect(row).toHaveTextContent(/waiting|needs you|attention/i);
  });

  it('stores the master switch where every client reads it', async () => {
    renderShell();
    const row = await notificationsRow('attention-row');
    await waitFor(() =>
      expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(within(row).getByRole('switch'));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ attentionAlerts: false }));
  });

  it('stores the sound switch', async () => {
    renderShell();
    const row = await notificationsRow('sound-row');
    fireEvent.click(within(row).getByRole('switch'));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ attentionSound: false }));
  });

  it('stores the OS banner switch', async () => {
    renderShell();
    const row = await notificationsRow('os-notifications-row');
    fireEvent.click(within(row).getByRole('switch'));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ osNotifications: false }));
  });

  it('stores the sound timing as one of the two documented values', async () => {
    // Not a free-text field and not a boolean. The server refuses anything
    // else, so a control that can emit anything else is a control that produces
    // a 400 the user cannot explain.
    renderShell();
    const r = await notificationsRow('sound-timing-row');
    fireEvent.change(within(r).getByRole('combobox'), { target: { value: 'always' } });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ soundTiming: 'always' }));
  });

  it('shows which timing is stored', async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...STORED_DEFAULTS, soundTiming: 'always' } as never);
    renderShell();
    const r = await notificationsRow('sound-timing-row');
    await waitFor(() => expect(within(r).getByRole('combobox')).toHaveValue('always'));
  });

  it('plays the sound when the preview is pressed', async () => {
    // The preview is the only way to find out what the sound IS before an agent
    // makes it at you in a meeting.
    renderShell();
    const row = await notificationsRow('sound-row');
    fireEvent.click(within(row).getByRole('button', { name: /preview|play/i }));
    await waitFor(() => expect(previewed).toHaveBeenCalled());
  });

  it('disables the sub-controls while alerts are off, rather than hiding them', async () => {
    // Hiding them means turning alerts on silently applies whatever was stored
    // last, which the user has had no chance to look at.
    vi.mocked(api.getSettings).mockResolvedValue(
      { ...STORED_DEFAULTS, attentionAlerts: false } as never,
    );
    renderShell();
    const sound = await notificationsRow('sound-row');
    await waitFor(() => expect(within(sound).getByRole('switch')).toBeDisabled());
    expect(within(await settingRow('os-notifications-row')).getByRole('switch')).toBeDisabled();
    expect(within(await settingRow('sound-timing-row')).getByRole('combobox')).toBeDisabled();
  });

  it('leaves the master switch itself usable when alerts are off', async () => {
    // Otherwise the off state is a trap.
    vi.mocked(api.getSettings).mockResolvedValue(
      { ...STORED_DEFAULTS, attentionAlerts: false } as never,
    );
    renderShell();
    const row = await notificationsRow('attention-row');
    await waitFor(() => expect(within(row).getByRole('switch')).not.toBeDisabled());
  });
});

/**
 * The custom sound, which only exists where there is a main process to pick it.
 *
 * A browser cannot open a native file dialog, cannot read the file it is given
 * and has nowhere to keep it. Rendering the row there would be a control that
 * does nothing, which is the failure this card was written to stop repeating.
 */
describe('the custom sound', () => {
  it('offers a chooser in the desktop app', async () => {
    renderShell();
    const row = await notificationsRow('custom-sound-row');
    expect(within(row).getByRole('button', { name: /choose/i })).toBeInTheDocument();
  });

  it('names the file that is in use', async () => {
    chosenSound = { name: 'Gentle Chime.wav' };
    renderShell();
    const row = await notificationsRow('custom-sound-row');
    await waitFor(() => expect(row).toHaveTextContent('Gentle Chime.wav'));
  });

  it('says it is using the built-in sound when nothing has been chosen', async () => {
    // Blank is ambiguous: it reads as "no sound" as easily as "the default one".
    renderShell();
    const row = await notificationsRow('custom-sound-row');
    await waitFor(() => expect(row).toHaveTextContent(/built-in|default/i));
  });

  it('asks the main process to open the picker', async () => {
    renderShell();
    const row = await notificationsRow('custom-sound-row');
    fireEvent.click(within(row).getByRole('button', { name: /choose/i }));
    await waitFor(() => expect(chooseSound).toHaveBeenCalled());
  });

  it('says so when the chosen file was refused', async () => {
    chooseSound.mockResolvedValue({ name: null, error: 'Choose a .wav, .mp3, .ogg, .m4a, .aac or .flac file.' });
    renderShell();
    const row = await notificationsRow('custom-sound-row');
    fireEvent.click(within(row).getByRole('button', { name: /choose/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/\.wav/);
  });

  it('can be put back to the built-in sound', async () => {
    chosenSound = { name: 'Gentle Chime.wav' };
    renderShell();
    const row = await notificationsRow('custom-sound-row');
    await waitFor(() => expect(row).toHaveTextContent('Gentle Chime.wav'));
    fireEvent.click(within(row).getByRole('button', { name: /use the built-in|clear|remove/i }));
    await waitFor(() => expect(clearSound).toHaveBeenCalled());
  });

  it('is not offered at all in a browser', async () => {
    // No main process, no picker, nowhere to keep the file.
    delete (window as unknown as Record<string, unknown>).agenfkDesktop;
    renderShell();
    await openSettings('Notifications');
    // The sibling rows ARE there, so this is not passing on an unrendered pane.
    await settingRow('sound-row');
    expect(document.querySelector('[data-row="custom-sound-row"]')).toBeNull();
  });
});

/**
 * An icon per section, and a name that is still just the label.
 *
 * The icon is the easy half. The half worth a test is that adding one did not
 * change what the rail SAYS: an `<svg>` dropped inside the button without
 * `aria-hidden` contributes to the accessible name, and the rail stops
 * answering to "Account" — so `getByRole('button', { name: 'Account' })`, which
 * is how a person and every test in this file navigate, finds nothing.
 *
 * `icon` is a required field on `SettingsSection` rather than an optional one,
 * so a section cannot be added without deciding on its mark. That is the same
 * reason the rail is generated from the section list at all.
 */
describe('the section menu carries an icon', () => {
  it('draws one on every entry', async () => {
    renderShell();
    await openSettingsRaw();
    const rail = await screen.findByRole('navigation', { name: /settings sections/i });
    const entries = within(rail).getAllByRole('button');
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.querySelector('svg'), `${entry.textContent} has no icon`).not.toBeNull();
    }
  });

  it('leaves the accessible name as the label alone', async () => {
    // The regression an icon introduces. Asserted by NAME lookup rather than by
    // reading `aria-hidden` off the svg, because the name is what actually
    // breaks and the attribute is only one way of getting it wrong.
    renderShell();
    await openSettingsRaw();
    const rail = await screen.findByRole('navigation', { name: /settings sections/i });
    for (const label of ['Account', 'App', 'Notifications', 'Terminal', 'Agents']) {
      expect(
        within(rail).getByRole('button', { name: label }),
        `the rail no longer answers to "${label}"`,
      ).toBeInTheDocument();
    }
  });

  it('keeps the icon out of the row text', async () => {
    // A mark that leaks into textContent would also break the exact-list
    // assertion further up, and that failure reads as a section list problem.
    renderShell();
    await openSettingsRaw();
    const rail = await screen.findByRole('navigation', { name: /settings sections/i });
    expect(within(rail).getAllByRole('button').map(b => b.textContent))
      .toEqual(['Account', 'App', 'Notifications', 'Terminal', 'Agents']);
  });
});
