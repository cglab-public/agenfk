/**
 * @vitest-environment jsdom
 *
 * CGLAB-168: the desktop shell around the board.
 *
 * Two things this file exists to protect. First, the browser must not change
 * at all — the shell renders only when the preload says we are in the desktop
 * app, and everywhere else the board is what it always was. Second, switching
 * tabs must not remount the board: a Kanban that reloads and loses its scroll,
 * filters and expansion state every time you glance at a session is worse than
 * no tabs at all.
 */
import { render, screen, fireEvent, cleanup, act, within, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '../components/AppShell';
import { SocketProvider } from '../SocketContext';
import { LIVE_TTL_MS } from '../liveAgents';
import { api } from '../api';
import { ActiveProjectProvider, useActiveProject } from '../ActiveProject';
import { readPinned } from '../sidebarPrefs';

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(async () => []),
    listActiveItems: vi.fn(async () => []),
    getVersion: vi.fn(async () => ({ version: '1.1.18' })),
    getReadme: vi.fn(async () => ({ content: '# Readme' })),
    getLatestRelease: vi.fn(async () => ({ version: '1.1.18', tagName: 'v1.1.18', name: '', body: '', publishedAt: '', url: '', currentVersion: '1.1.18' })),
    // Was missing. Its absence made `api.updateItem(...)` throw a TypeError on
    // every terminal-opening test, swallowed by a catch that existed only to
    // tolerate this fixture — so nothing verified that the chosen agent is
    // written back to the card, in either direction.
    updateItem: vi.fn(async () => ({})),
    getSettings: vi.fn(async () => ({ tmuxByDefault: false })),
    updateSettings: vi.fn(async () => ({ tmuxByDefault: false })),
    listRuns: vi.fn(async () => []),
  },
}));

const socketHandlers: Record<string, (...args: unknown[]) => void> = {};
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connect: vi.fn(),
    on: (ev: string, cb: (...a: unknown[]) => void) => { socketHandlers[ev] = cb; },
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

/** Counts mounts so a remount is detectable, not merely assumed. */
let boardMounts = 0;
function FakeBoard() {
  React.useEffect(() => { boardMounts += 1; }, []);
  const [typed, setTyped] = React.useState('');
  return (
    <div>
      <span>THE BOARD</span>
      <input aria-label="board-state" value={typed} onChange={e => setTyped(e.target.value)} />
    </div>
  );
}

const renderShell = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ActiveProjectProvider>
        <SocketProvider>
          <AppShell><FakeBoard /></AppShell>
        </SocketProvider>
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
};

const renderedProjectNames = (): string[] =>
  Array.from(document.querySelectorAll('[data-testid="project-name"]'))
    .map(el => (el.textContent ?? '').trim());

const PROJECTS = [
  { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
  { id: 'p2', name: 'horizon-lab', createdAt: new Date(), updatedAt: new Date() },
];

const manyProjects = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`, name: `project-${i}`, createdAt: new Date(), updatedAt: new Date(),
  }));

/** Sessions the fake bridge has been asked to open, and which were killed. */
const ptyCalls: { spawned: string[]; killed: string[]; requests: unknown[] } = {
  spawned: [], killed: [], requests: [],
};

/**
 * Module scope, deliberately. Scoped inside setBridge, every test would reuse
 * `sess-1` — and a spawn still in flight when cleanup runs resolves into the
 * pane's cancelled-branch kill, which could land AFTER the next test's reset.
 * Colliding ids would then fail that test for something the previous one did.
 */
let ptySeq = 0;

/**
 * The preload bridge, which is what tells the UI it is in the desktop app.
 *
 * It carries a `terminal` surface. Without one, TerminalPane's own
 * defaultBridge() returns null and EVERY pane short-circuits to "Terminals are
 * only available in the desktop app" — so spawn and kill are never called and a
 * test claiming a session stayed alive is really only reading tab labels.
 */
const setBridge = (platform: string, prefs: { autoApprove: boolean } = { autoApprove: false }) => {
  Object.defineProperty(window, 'agenfkDesktop', {
    value: {
      isDesktop: true,
      platform,
      versions: { electron: '40.10.6', chrome: '130', node: '24' },
      prefs: {
        get: async () => prefs,
        setAutoApprove: async (value: boolean) => ({ autoApprove: value }),
      },
      terminal: {
        spawn: async (req: unknown) => {
          ptySeq += 1;
          const id = `sess-${ptySeq}`;
          ptyCalls.spawned.push(id);
          // Recorded so the multi-session wiring is checkable: a bug passing
          // one session's itemId to every pane would otherwise leave every
          // test in this file green.
          ptyCalls.requests.push(req);
          // Both ids, as the real bridge does: the pty handle addresses a live
          // process, the conversation id addresses a conversation. A bare
          // string was ambiguous enough that the handle could be sent to
          // `--resume` and silently start a fresh conversation.
          return { sessionId: id, agentSessionId: `conv-${ptySeq}` };
        },
        write: async () => true,
        resize: async () => true,
        kill: async (id: string) => { ptyCalls.killed.push(id); return true; },
        onData: () => () => {},
        onExit: () => () => {},
        listAgents: async () => [
          { id: 'claude-code', label: 'Claude Code', installed: true, supportsAutoApprove: true },
          { id: 'gemini', label: 'Gemini CLI', installed: true, supportsAutoApprove: false },
        ],
        refreshAgents: async () => [],
      },
    },
    configurable: true, writable: true,
  });
};

beforeEach(() => {
  ptyCalls.spawned = [];
  ptyCalls.killed = [];
  ptyCalls.requests = [];
  // Call history accumulates across the file otherwise, so an assertion can
  // pass on a call another test made.
  vi.mocked(api.updateItem).mockClear();
  setBridge('darwin');
  localStorage.clear();
  vi.mocked(api.getVersion).mockResolvedValue({ version: '1.1.18' });
  vi.mocked(api.listProjects).mockResolvedValue(PROJECTS as never);
  vi.mocked(api.listActiveItems).mockResolvedValue([] as never);
  boardMounts = 0;
  for (const k of Object.keys(socketHandlers)) delete socketHandlers[k];
});
afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).agenfkDesktop;
});

describe('AppShell — chrome', () => {
  it('renders the board it is given', () => {
    renderShell();
    expect(screen.getByText('THE BOARD')).toBeDefined();
  });

  it('gives the title bar a draggable region', () => {
    // titleBarStyle: 'hiddenInset' removes the OS bar, so without an explicit
    // drag region the window cannot be moved at all.
    const { container } = renderShell();
    const drag = container.querySelector('[data-app-region="drag"]');
    expect(drag).not.toBeNull();
  });

  it('traps no control inside a drag region', () => {
    /*
     * A drag region swallows pointer events, so a control left inside one
     * silently stops responding.
     *
     * Walked from the CONTROLS rather than from the regions, which is the
     * change the tab strip's removal forced. The old version listed every
     * control inside a drag region and asserted each had opted out, guarded by
     * "at least one was checked" — and the tabs were what made that guard
     * true. With the strip gone both drag regions are empty, so the old loop
     * would have checked nothing and passed for the wrong reason, which is the
     * exact defect its own comment says an earlier version had.
     *
     * This asks the question of every control in the app instead: whichever
     * region encloses it most tightly must not be a drag one. That has teeth
     * today, and it fails the moment a control is put in the title bar.
     */
    const { container } = renderShell();
    const controls = Array.from(container.querySelectorAll('button, a, input'));
    expect(controls.length).toBeGreaterThan(0);

    for (const el of controls) {
      const nearest = el.closest('[data-app-region="drag"], [data-app-region="no-drag"]');
      expect(
        nearest?.getAttribute('data-app-region'),
        `${el.getAttribute('aria-label') ?? el.textContent} would be unclickable`,
      ).not.toBe('drag');
    }
  });

  it('gives the main column no row of its own while the sidebar is open', async () => {
    /*
     * The 36px this change is about. Open, the sidebar is wider than the
     * traffic lights, so a row in the main column reserves space for buttons
     * that are not above it - dead chrome directly over the terminal, which is
     * the thing the user wanted more of.
     *
     * Asserted together with the second half, because dropping the row is only
     * safe while the sidebar still carries a handle. Checking the absence
     * alone would pass just as happily on a window that cannot be moved at all.
     */
    setBridge('darwin');
    const { container } = renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });

    const sidebar = container.querySelector('aside')!;
    const regions = [...container.querySelectorAll('[data-app-region="drag"]')];
    expect(regions.length, 'no drag handle at all - the window cannot be moved').toBeGreaterThan(0);
    expect(
      regions.every(r => sidebar.contains(r)),
      'the main column still draws a title bar of its own while the sidebar is open',
    ).toBe(true);
  });

  it('keeps a real drag handle when the sidebar is collapsed', async () => {
    // Collapsed, the rail is 40px and the traffic lights cover half of it.
    // The main column's top row has to be draggable or the window is moved by
    // a ~20px sliver. That row used to be the tab strip; the tabs are gone and
    // the row stays, because it is the title bar.
    const { container } = renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    expect(container.querySelector('main > [data-app-region="drag"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-app-region="drag"]').length).toBeGreaterThan(1);
  });

  it('draws no title bar off macOS, where the native one is still there', () => {
    // Electron only hides the native bar with titleBarStyle 'hiddenInset' on
    // darwin. Rendering ours anyway would stack a second bar under the real
    // one, with 80px of dead space reserved for traffic lights that do not
    // exist on Windows or Linux.
    setBridge('win32');
    const { container } = renderShell();
    expect(container.querySelector('[data-app-region="drag"]')).toBeNull();
    expect(screen.getByText('THE BOARD')).toBeDefined();
  });

  it('reports the Electron version it is running on', async () => {
    renderShell();
    expect(await screen.findByText(/Electron 40\.10\.6/)).toBeDefined();
  });

  it('reaches the board without a tab, and names it for a screen reader', () => {
    /*
     * Was "shows a Kanban tab". The tab is gone - the sidebar's Tasks opens
     * the board now - and this asserts what replaced it rather than being
     * deleted, because the board still has to be reachable and still has to be
     * announced.
     *
     * The NAME is the point. The panel was a tabpanel labelled by `tab-kanban`,
     * and with that button gone the reference dangled: a region with no
     * accessible name, claiming a role that requires a tab it no longer had.
     */
    renderShell();
    expect(screen.queryByRole('tab', { name: /kanban/i })).toBeNull();
    expect(screen.getByRole('region', { name: 'Tasks' })).toBeDefined();
  });

  /*
   * A test asserting the SESSIONS heading and its "none running" sentence sat
   * here. Both are gone with the section (1a1b8df6): processes are drawn under
   * the card they belong to, so there is no flat list to head or to describe
   * as empty. The sentence taught the feature to somebody seeing it for the
   * first time, and losing it is recorded on that card as an accepted cost
   * rather than an oversight.
   *
   * Deleted rather than adjusted because there is nothing left to assert. Left
   * as a note because "this was removed deliberately" and "somebody dropped a
   * test to make a change pass" look identical in a diff a year from now.
   */
});

describe('AppShell — live connection state', () => {
  it('reports the connection as offline until the socket connects', () => {
    renderShell();
    expect(screen.getByTestId('connection-state').textContent).toMatch(/connecting|offline/i);
  });

  it('reports connected once the socket says so', () => {
    renderShell();
    act(() => socketHandlers['connect']?.());
    expect(screen.getByTestId('connection-state').textContent).toMatch(/connected/i);
  });

  it('goes back to offline when the socket drops', () => {
    renderShell();
    act(() => socketHandlers['connect']?.());
    act(() => socketHandlers['disconnect']?.());
    expect(screen.getByTestId('connection-state').textContent).toMatch(/offline|disconnected/i);
  });
});

describe('AppShell — sidebar', () => {
  it('lists the real projects, not a placeholder', async () => {
    renderShell();
    expect(await screen.findByRole('button', { name: 'horizon-lab' })).toBeDefined();
  });

  it('marks the open project so you can see where you are', async () => {
    localStorage.setItem('agenfk_project_id', 'p2');
    renderShell();
    const active = await screen.findByRole('button', { name: 'horizon-lab' });
    expect(active.getAttribute('aria-current')).toBe('true');
  });

  it('switches project when one is picked', async () => {
    renderShell();
    const target = await screen.findByRole('button', { name: 'horizon-lab' });
    fireEvent.click(target);
    expect(localStorage.getItem('agenfk_project_id')).toBe('p2');
    expect((await screen.findByRole('button', { name: 'horizon-lab' })).getAttribute('aria-current')).toBe('true');
  });

  it('puts the collapse control with the projects it collapses, not in the drag strip', async () => {
    const { container } = renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    const toggle = screen.getByRole('button', { name: /collapse sidebar/i });
    // In the sidebar — and outside the drag region, which would swallow clicks.
    expect(container.querySelector('aside')?.contains(toggle)).toBe(true);
    expect(container.querySelector('[data-app-region="drag"]')?.contains(toggle)).toBe(false);
  });

  it('runs the sidebar the full height, with no banner above it', () => {
    // The window reads as two columns, not a strip stacked on a split: nothing
    // spans the full width above the sidebar, so the board keeps that row.
    const { container } = renderShell();
    const aside = container.querySelector('aside');
    const drag = container.querySelector('[data-app-region="drag"]');
    expect(aside).not.toBeNull();
    // The drag strip belongs to the sidebar now, not to a full-width header.
    expect(aside!.contains(drag!)).toBe(true);
  });

  it('leaves a way back: the expand control stays in the sidebar rail', async () => {
    // A toggle that disappears with the thing it hides is a one-way door.
    // Assert it is still reachable AND still in the sidebar, not that it
    // merely exists somewhere — which is what getByRole already guarantees.
    const { container } = renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));

    const expand = screen.getByRole('button', { name: /expand sidebar/i });
    expect(container.querySelector('aside')?.contains(expand)).toBe(true);
    expect(expand.hasAttribute('disabled')).toBe(false);
  });

  it('keeps keyboard focus on the toggle across a collapse', () => {
    // Collapsing rebuilt the button in a different DOM position, so React
    // destroyed it and focus fell back to <body> — a keyboard user was thrown
    // to the top of the document by their own click.
    renderShell();
    const toggle = screen.getByRole('button', { name: /collapse sidebar/i });
    toggle.focus();
    fireEvent.click(toggle);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /expand sidebar/i }));
  });

  it('collapses and expands, and says which it will do', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });

    const toggle = screen.getByRole('button', { name: /collapse sidebar/i });
    fireEvent.click(toggle);
    expect(screen.queryByRole('button', { name: 'horizon-lab' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /expand sidebar/i }));
    expect(await screen.findByRole('button', { name: 'horizon-lab' })).toBeDefined();
  });

  it('remembers the collapsed state across launches', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    cleanup();

    renderShell();
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeDefined();
  });

  it('keeps the board visible while the sidebar is collapsed', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    expect(screen.getByText('THE BOARD')).toBeDefined();
  });
});

describe('AppShell — pinning, folders and overflow (CGLAB-172)', () => {
  it('pins a project to the top and keeps it there next launch', async () => {
    renderShell();
    const target = await screen.findByRole('button', { name: 'horizon-lab' });
    fireEvent.click(within(target.closest('li')!).getByRole('button', { name: 'Pin project horizon-lab' }));

    const names = screen.getAllByTestId('project-name').map(n => n.textContent);
    expect(names[0]).toBe('horizon-lab');
    expect(localStorage.getItem('agenfk_pinned_projects')).toContain('p2');

    cleanup();
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    expect(screen.getAllByTestId('project-name').map(n => n.textContent)[0]).toBe('horizon-lab');
  });

  it('unpins without losing which project is open', async () => {
    localStorage.setItem('agenfk_pinned_projects', '["p2"]');
    localStorage.setItem('agenfk_project_id', 'p2');
    renderShell();
    const row = (await screen.findByRole('button', { name: 'horizon-lab' })).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Unpin project horizon-lab' }));

    expect(readPinned()).toEqual([]);
    expect((await screen.findByRole('button', { name: 'horizon-lab' })).getAttribute('aria-current')).toBe('true');
  });

  it('keeps every project reachable rather than dropping any from the list', async () => {
    // What the old test here asserted — that the list carries an
    // `overflow-y-auto` class and that a Sessions heading exists — matched
    // with zero projects as readily as with forty, and jsdom has no layout to
    // say whether Sessions was pushed off screen. It could not fail for the
    // reason it named. This asserts the thing that actually varies with input:
    // a long list is scrolled, never truncated.
    vi.mocked(api.listProjects).mockResolvedValue(manyProjects(40) as never);
    const { container } = renderShell();
    await screen.findByRole('button', { name: 'project-0' });

    const list = container.querySelector('[data-testid="project-list"]') as HTMLElement;
    expect(list.querySelectorAll(':scope > li')).toHaveLength(40);
    expect(screen.getByRole('button', { name: 'project-39' })).toBeDefined();
  });

  it('tells assistive tech whether a folder is open, not just that it is a button', async () => {
    // A disclosure without aria-expanded reads as a plain button: a screen
    // reader user cannot tell an open folder from a closed one, and the
    // aria-label flipping between "Expand"/"Collapse" is not a substitute —
    // it names the ACTION, never the state.
    vi.mocked(api.listActiveItems).mockResolvedValue([
      { id: 'i1', projectId: 'p2', type: 'TASK', title: 'Some work', status: 'IN_PROGRESS' },
    ] as never);
    renderShell();
    const toggle = await screen.findByRole('button', { name: /expand horizon-lab/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const controlled = toggle.getAttribute('aria-controls');
    expect(controlled).toBeTruthy();

    fireEvent.click(toggle);
    const open = await screen.findByRole('button', { name: /collapse horizon-lab/i });
    expect(open.getAttribute('aria-expanded')).toBe('true');
    // And the id must actually point at the list it toggles.
    expect(document.getElementById(controlled!)).not.toBeNull();
  });

  it('marks each project row with a folder icon', async () => {
    const { container } = renderShell();
    const row = (await screen.findByRole('button', { name: 'horizon-lab' })).closest('li')!;
    expect(row.querySelector('[data-folder-icon]')).not.toBeNull();
  });

  it('offers a + on a project row that creates a card in it', async () => {
    const requests: string[] = [];
    function Spy() {
      const { newItemRequest } = useActiveProject();
      React.useEffect(() => { if (newItemRequest) requests.push(newItemRequest); }, [newItemRequest]);
      return null;
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ActiveProjectProvider>
          <SocketProvider>
            <Spy />
            <AppShell><FakeBoard /></AppShell>
          </SocketProvider>
        </ActiveProjectProvider>
      </QueryClientProvider>,
    );

    const row = (await screen.findByRole('button', { name: 'horizon-lab' })).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: /new card in horizon-lab/i }));

    expect(requests).toHaveLength(1);
    // Which project the request NAMES is the whole point — a + that always
    // drafted into the selected project would satisfy the count and the side
    // effect below while being the wrong feature.
    expect(requests[0]).toContain('p2');
    expect(localStorage.getItem('agenfk_project_id')).toBe('p2');
  });

  it('offers a new-project control in the sidebar', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    expect(screen.getByRole('button', { name: /new project/i })).toBeDefined();
  });
});

describe('AppShell — folders of in-flight work (CGLAB-172)', () => {
  const ACTIVE = [
    { id: 'i1', projectId: 'p2', title: 'Fix the login redirect', status: 'IN_PROGRESS', type: 'TASK', updatedAt: new Date().toISOString() },
    { id: 'i2', projectId: 'p2', title: 'Port the deploy workflow', status: 'REVIEW', type: 'STORY', updatedAt: new Date().toISOString() },
    { id: 'i3', projectId: 'p1', title: 'Something in agenfk', status: 'IN_PROGRESS', type: 'TASK', updatedAt: new Date().toISOString() },
  ];

  it('shows how much is in flight without being expanded', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    renderShell();
    const row = (await screen.findByRole('button', { name: 'horizon-lab' })).closest('li')!;
    expect(within(row).getByTestId('in-flight-count').textContent).toBe('2');
  });

  it('expands to show that project\'s work, and only that project\'s', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    renderShell();
    const row = (await screen.findByRole('button', { name: 'horizon-lab' })).closest('li')!;

    fireEvent.click(within(row).getByRole('button', { name: /expand horizon-lab/i }));

    expect(await screen.findByText('Fix the login redirect')).toBeDefined();
    expect(screen.getByText('Port the deploy workflow')).toBeDefined();
    // agenfk's item belongs to a different folder. Its rows exist in the DOM
    // (the folders animate, so they are collapsed rather than unmounted), but
    // that folder must be closed and not exposed.
    const otherFolder = document.getElementById('work-p1')!;
    expect(otherFolder.getAttribute('aria-hidden')).toBe('true');
    expect(otherFolder.parentElement!.className).toMatch(/grid-rows-\[0fr\]/);
  });

  it('remembers which folders were open, per project', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    renderShell();
    const row = (await screen.findByRole('button', { name: 'horizon-lab' })).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: /expand horizon-lab/i }));
    await screen.findByText('Fix the login redirect');

    cleanup();
    renderShell();
    expect(await screen.findByText('Fix the login redirect')).toBeDefined();
  });

  it('offers no expander for a project with nothing in flight', async () => {
    // An empty folder is a row that costs space and answers nothing.
    vi.mocked(api.listActiveItems).mockResolvedValue([] as never);
    renderShell();
    const row = (await screen.findByRole('button', { name: 'horizon-lab' })).closest('li')!;
    expect(within(row).queryByRole('button', { name: /expand/i })).toBeNull();
    expect(within(row).queryByTestId('in-flight-count')).toBeNull();
  });

  it('collapses again, hiding the work', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    renderShell();
    const row = (await screen.findByRole('button', { name: 'horizon-lab' })).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: /expand horizon-lab/i }));
    await screen.findByText('Fix the login redirect');

    fireEvent.click(within(row).getByRole('button', { name: /collapse horizon-lab/i }));
    // The rows stay in the DOM now, because the folder ANIMATES closed —
    // removing them would make the collapse instant and defeat the point. What
    // must be true is that they take no space and are not exposed: the grid
    // row collapses to 0fr and the list is aria-hidden.
    const list = document.getElementById('work-p2')!;
    expect(list.getAttribute('aria-hidden')).toBe('true');
    expect(list.parentElement!.className).toMatch(/grid-rows-\[0fr\]/);
  });

  it('opens a terminal on the card when its row is clicked', async () => {
    // Changed deliberately (CGLAB-169). The sidebar lists work in FLIGHT, and
    // what you want from work in flight is a shell in its worktree — not a
    // scroll to a card you already know about. The board is still one tab away.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    fireEvent.click(await screen.findByTitle('Something in agenfk'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toMatch(/something in agenfk/i);
  });

  it('carries the stored settings into the spawn, not a fresh default', async () => {
    // The dialog used to ask both of these and now asks neither — they are
    // preferences, answered the same way every time. That makes THIS the only
    // place the answer can be checked: what actually reaches the main process.
    //
    // Checked through the shell rather than by handing a component a prop.
    // Three times in this epic a value was produced in one place and consumed
    // in another, each tested against its own fixture and agreeing with
    // nobody; a stored setting nothing reads is that bug wearing a column.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.getSettings).mockResolvedValue({ tmuxByDefault: true } as never);
    // Auto-approve is DESKTOP-owned, not a server setting: it disables an
    // agent's permission prompts, and the server's settings route is
    // unauthenticated. So the fixture has to come through the bridge, which is
    // also the only place the real app reads it from.
    setBridge('darwin', { autoApprove: true });
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    fireEvent.click(await screen.findByTitle('Something in agenfk'));
    fireEvent.click(await screen.findByRole('button', { name: /^create/i }));
    await waitFor(() => expect(ptyCalls.requests.length).toBeGreaterThan(0));
    expect(ptyCalls.requests[0]).toMatchObject({ persist: true, autoApprove: true });
  });

  it('spawns with the rails ON when nobody has changed the settings', async () => {
    // The default that matters most. An install nobody has configured must
    // start agents with their permission prompts intact, and terminals that
    // behave the way they always did.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.getSettings).mockResolvedValue({ tmuxByDefault: false } as never);
    setBridge('darwin', { autoApprove: false });
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    fireEvent.click(await screen.findByTitle('Something in agenfk'));
    fireEvent.click(await screen.findByRole('button', { name: /^create/i }));
    await waitFor(() => expect(ptyCalls.requests.length).toBeGreaterThan(0));
    expect(ptyCalls.requests[0]).toMatchObject({ persist: false, autoApprove: false });
  });

  it('switches to the project the card belongs to before opening it', async () => {
    // The terminal resolves the worktree from the item, but everything else on
    // screen — the board behind, the counts — must not still be showing another
    // project.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    fireEvent.click(await screen.findByTitle('Something in agenfk'));
    await waitFor(() => expect(localStorage.getItem('agenfk_project_id')).toBe('p1'));
  });

  it('shows each item\'s step, which is what says where it is stuck', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    renderShell();
    const row = (await screen.findByRole('button', { name: 'horizon-lab' })).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: /expand horizon-lab/i }));
    await screen.findByText('Fix the login redirect');
    expect(screen.getByText(/REVIEW/)).toBeDefined();
  });
});

describe('AppShell — sort order (CGLAB-172)', () => {
  it('offers a sort control in the Projects header', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    expect(screen.getByRole('button', { name: /sort projects/i })).toBeDefined();
  });

  it('opens a menu with both orders and marks the current one', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    fireEvent.click(screen.getByRole('button', { name: /sort projects/i }));

    const lastUsed = screen.getByRole('menuitemradio', { name: /last used/i });
    expect(screen.getByRole('menuitemradio', { name: /created/i })).toBeDefined();
    expect(lastUsed.getAttribute('aria-checked')).toBe('true');
  });

  it('changes the order and remembers it', async () => {
    // The preference alone proves nothing: with the fixtures all sharing one
    // timestamp, this passed with `orderProjects` removed from the component
    // entirely. Give the two projects orders that DISAGREE between the two
    // sorts, then assert what is actually on screen.
    vi.mocked(api.listProjects).mockResolvedValue([
      { id: 'p1', name: 'agenfk', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z' },
      { id: 'p2', name: 'horizon-lab', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ] as never);
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });

    // Default is last-used; neither has been opened here, so updatedAt decides
    // and agenfk (Sept) leads.
    expect(renderedProjectNames()).toEqual(['agenfk', 'horizon-lab']);

    fireEvent.click(screen.getByRole('button', { name: /sort projects/i }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /created/i }));

    // By creation date horizon-lab (June) leads — the opposite order.
    await waitFor(() => expect(renderedProjectNames()).toEqual(['horizon-lab', 'agenfk']));
    expect(localStorage.getItem('agenfk_project_sort')).toContain('created');
    // And the menu closes, rather than sitting over the list it just changed.
    expect(screen.queryByRole('menuitemradio', { name: /created/i })).toBeNull();
  });

  it('closes on Escape without changing anything', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    fireEvent.click(screen.getByRole('button', { name: /sort projects/i }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menuitemradio', { name: /created/i })).toBeNull();
    expect(localStorage.getItem('agenfk_project_sort')).toBeNull();
  });
});

describe('AppShell — footer chrome', () => {
  it('carries the README, which the board header no longer duplicates', () => {
    renderShell();
    expect(screen.getByRole('button', { name: /readme/i })).toBeDefined();
  });

  it('opens the README from the footer', () => {
    renderShell();
    expect(screen.queryByRole('heading', { name: /project readme/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /readme/i }));
    expect(screen.getByRole('heading', { name: /project readme/i })).toBeDefined();
  });

  it('shows the running version', () => {
    renderShell();
    expect(screen.getByTestId('app-version').textContent).toMatch(/v/i);
  });

  it('keeps the footer out of the way of the drag region', () => {
    // Footer controls sit at the bottom, not in the title bar, so they must
    // not inherit a drag region that would swallow their clicks.
    const { container } = renderShell();
    const readme = screen.getByRole('button', { name: /readme/i });
    const drag = container.querySelector('[data-app-region="drag"]');
    expect(drag?.contains(readme)).toBe(false);
  });
});

describe('AppShell — window controls (CGLAB-168)', () => {
  it('keeps the main column clear of the traffic lights when the sidebar is collapsed', async () => {
    // The collapsed rail is ~40px but macOS traffic lights occupy ~78px from
    // the window edge, so without reserving that space anything in this
    // column's top row renders UNDER the close/minimise/zoom buttons:
    // unclickable, and the OS window menu opens on top of it.
    const { container } = renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));

    /*
     * Asked of the column's FIRST element. The row is empty now that the tab
     * strip is gone, so there is no control to find the reserve through — but
     * the reserve is a property of the element sitting against the window
     * edge, which is what this asserts, and it is what makes the row safe to
     * put a control back into.
     */
    const reserving = document.querySelector('[data-reserves-window-controls="true"]');
    expect(reserving, 'nothing reserves the space the window buttons occupy').not.toBeNull();
    const main = container.querySelector('main')!;
    expect(main.firstElementChild, 'the reserve is not on the element against the window edge')
      .toBe(reserving);
  });

  it('reserves nothing while the sidebar is open — it already clears them', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    expect(document.querySelector('[data-reserves-window-controls="true"]')).toBeNull();
  });

  it('reserves nothing off macOS, where the native title bar is still there', async () => {
    setBridge('win32');
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    expect(document.querySelector('[data-reserves-window-controls="true"]')).toBeNull();
  });
});

describe('AppShell — tabs', () => {
  it('mounts the board exactly once', () => {
    renderShell();
    expect(boardMounts).toBe(1);
  });

  it('does not remount or reset the board when another view is selected', async () => {
    // The point of the panels here: another view must not cost you the board's
    // React state — filters, expanded cards, a half-typed title. (Scroll
    // position is NOT preserved: `hidden` removes the layout box and with it
    // scrollTop. Claiming otherwise in this test would be a lie the assertions
    // never check.)
    renderShell();
    const input = screen.getByLabelText('board-state') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'unsaved work' } });

    // Away to another view and back, both through the sidebar. Neither is a
    // tab any more; what matters here is the mount count, which is the same
    // question whichever route is taken.
    fireEvent.click(await screen.findByRole('button', { name: /^agents$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^tasks$/i }));

    expect(boardMounts).toBe(1);
    expect((screen.getByLabelText('board-state') as HTMLInputElement).value).toBe('unsaved work');
  });

  /*
   * DELETED: the five tablist tests - arrow keys wrapping at the ends,
   * Home/End, the roving tabindex that gave the list a single tab stop,
   * "leaves other keys alone", and "marks exactly one tab selected at a time".
   *
   * All five are the ARIA tabs keyboard pattern, and the pattern needs a
   * tablist. There is none: Kanban left the strip for the sidebar's Tasks,
   * Terminal followed, and Runs became the Agents screen. The sidebar rows
   * that replaced them are ordinary buttons in a <nav>, where Tab reaches each
   * one and no roving index is wanted.
   *
   * Two of them were written defensively, against the bug CGLAB-169 hit when
   * the Terminal tab landed and "wraps at the end" quietly became "moves to
   * the second tab" - they read the tab list rather than naming tabs. That
   * care is why they are being deleted rather than rewritten: there is nothing
   * left for them to read.
   *
   * Restore them with the strip if one ever returns. What replaces them for
   * now is "marks which WORK view you are on, and only that one", further
   * down, which holds the same one-destination-at-a-time rule over the sidebar.
   */

  it('hides the inactive panel from assistive tech rather than just visually', async () => {
    /*
     * `hidden` and not merely off-screen: a panel that is only visually hidden
     * is still read out and still focusable, so a screen reader walks a view
     * nobody is looking at.
     *
     * Counted over REGIONS, not tabpanels. Every panel was a tabpanel once;
     * each became a region as its tab was deleted, because a tabpanel whose
     * `aria-labelledby` points at a button that no longer exists has no
     * accessible name at all and claims a role whose whole contract is to be
     * paired with a tab.
     */
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: /^agents$/i }));
    const panels = ['kanban', 'terminal', 'settings', 'agents']
      .map(id => document.getElementById(`panel-${id}`)!);
    expect(panels.every(Boolean)).toBe(true);
    const visible = panels.filter(p => !p.hasAttribute('hidden'));
    expect(visible.map(p => p.id)).toEqual(['panel-agents']);
  });
});

describe('sidebar navigation has to reach the board (CGLAB-172)', () => {
  // The board lives in a panel with `hidden`, and the card-detail modal is
  // rendered inside the board tree — so it is hidden too. Navigating from the
  // sidebar while another view is showing therefore opens a draft nobody can
  // see, scrolls a board nobody is looking at, and burns the 3s highlight
  // off-screen. From the user's side the sidebar is simply broken.

  /*
   * Parked on ANOTHER view first, which is the state the defect needs.
   *
   * It used to be the Runs tab. Runs is the Agents screen now and there is no
   * tab to click, so the route is the sidebar row that replaced it — the same
   * destination, reached the only way there is.
   */
  const onAnotherView = async () => {
    renderShell();
    await screen.findByText('agenfk');
    fireEvent.click(screen.getByRole('button', { name: /^agents$/i }));
    expect(document.getElementById('panel-agents')!.hasAttribute('hidden')).toBe(false);
  };

  const kanbanPanel = () => document.getElementById('panel-kanban')!;

  it('goes to the Terminal view when a card is opened from the sidebar', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', type: 'TASK', title: 'Some work', status: 'IN_PROGRESS' },
    ] as never);
    await onAnotherView();
    fireEvent.click(screen.getByRole('button', { name: 'Expand agenfk', hidden: true }));
    fireEvent.click(await screen.findByTitle('Some work'));

    // Create in the dialog, then the Terminal panel is the visible one.
    fireEvent.click(await screen.findByRole('button', { name: /^create$/i }));
    await waitFor(() =>
      expect(document.getElementById('panel-terminal')!.hasAttribute('hidden')).toBe(false));
  });

  it('comes back to the board when + creates a card from the sidebar', async () => {
    await onAnotherView();
    fireEvent.click(screen.getByRole('button', { name: /New card in agenfk/i }));
    await waitFor(() => expect(kanbanPanel().hasAttribute('hidden')).toBe(false));
  });

  it('does not steal the view on its own', async () => {
    // The effect must react to a navigation, not to mounting — otherwise the
    // Agents screen becomes unusable, snapping back on every render.
    await onAnotherView();
    await new Promise(r => setTimeout(r, 20));
    expect(kanbanPanel().hasAttribute('hidden')).toBe(true);
  });
});

describe('the Terminal tab must not kill the agent (CGLAB-169)', () => {
  // The first cut of this mounted the terminal only while its tab was
  // selected, reasoning that a live child process should not be held open for
  // a card the user has moved on from. That trades a small resource concern
  // for a catastrophic one: switching to Kanban to look something up kills the
  // agent mid-run and loses the whole scrollback. Holding a shell open is the
  // cheaper mistake by a wide margin.
  it('does not start a shell before the user ever opens the tab', async () => {
    // The other half of the trade. Keeping the panel mounted must not mean
    // launching an agent CLI the moment a card is focused in the sidebar —
    // that is a heavyweight process the user did not ask for, started
    // invisibly.
    renderShell();
    await screen.findByText('agenfk');
    expect(document.getElementById('panel-terminal')!.childElementCount).toBe(0);
  });

  it('keeps the terminal panel mounted when another view is selected', async () => {
    /*
     * Reached by OPENING a terminal rather than by clicking a Terminal tab,
     * which no longer exists. That is not a workaround: opening one is the
     * only thing that puts a session in the panel, and a panel with no session
     * has nothing to lose on a switch, so this is the honest setup for what
     * the test claims.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', type: 'TASK', title: 'Some work', status: 'IN_PROGRESS' },
    ] as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    fireEvent.click(await screen.findByTitle('Some work'));
    fireEvent.click(await screen.findByRole('button', { name: /^create$/i }));

    const panel = document.getElementById('panel-terminal')!;
    await waitFor(() => expect(panel.hasAttribute('hidden')).toBe(false));
    expect(panel.childElementCount, 'terminal panel rendered nothing').toBeGreaterThan(0);

    // Away to the board, which is the sidebar's job now that it is not a tab.
    // The switch is what matters here, not the route taken to it.
    fireEvent.click(screen.getByRole('button', { name: /^tasks$/i }));
    expect(panel.hasAttribute('hidden')).toBe(true);
    expect(
      panel.childElementCount,
      'the terminal was unmounted on a view switch — the session dies and the scrollback goes with it',
    ).toBeGreaterThan(0);
  });
});

describe('several terminals at once (CGLAB-169)', () => {
  const TWO = [
    { id: 'i1', projectId: 'p1', type: 'TASK', title: 'First card', status: 'IN_PROGRESS', branchName: 'feat/first' },
    { id: 'i2', projectId: 'p1', type: 'TASK', title: 'Second card', status: 'IN_PROGRESS', branchName: 'feat/second' },
  ];

  /** The sidebar row, not the terminal tab — both carry the card's title. */
  const sidebarCard = async (title: string) => {
    const list = document.querySelector('[data-testid="project-list"]') as HTMLElement;
    return within(list).findByTitle(title);
  };

  const openTerminalOn = async (title: string) => {
    fireEvent.click(await sidebarCard(title));
    fireEvent.click(await screen.findByRole('button', { name: /^create$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  };

  it('keeps the first card’s terminal alive when a second is opened', async () => {
    // The catastrophe this replaced: one session slot meant opening a terminal
    // on card B unmounted card A's pane, which killed its agent mid-run and
    // destroyed the scrollback — two clicks through the supported path.
    //
    // The earlier version of this test read tab LABELS, which would have been
    // identical if the first pane had been torn down and rebuilt. The session
    // that must survive is a process, so the assertion is about kill.
    vi.mocked(api.listActiveItems).mockResolvedValue(TWO as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));

    await openTerminalOn('First card');
    await waitFor(() => expect(ptyCalls.spawned).toHaveLength(1));
    const first = ptyCalls.spawned[0];

    await openTerminalOn('Second card');
    await waitFor(() => expect(ptyCalls.spawned).toHaveLength(2));

    expect(ptyCalls.killed, 'the first card’s agent was killed by opening a second').not.toContain(first);
  });

  it('gives each pane its OWN card, not the first one twice', async () => {
    // NIT from review, and a real hole: the fake spawn discarded its request,
    // so a bug passing sessions[0].itemId to every pane would have left every
    // test in this block green.
    vi.mocked(api.listActiveItems).mockResolvedValue(TWO as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    await openTerminalOn('First card');
    await openTerminalOn('Second card');
    await waitFor(() => expect(ptyCalls.requests).toHaveLength(2));

    const items = ptyCalls.requests.map(r => (r as { itemId: string }).itemId);
    expect(items).toEqual(['i1', 'i2']);
  });

  it('kills only the session whose tab was closed', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(TWO as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    await openTerminalOn('First card');
    await openTerminalOn('Second card');
    await waitFor(() => expect(ptyCalls.spawned).toHaveLength(2));
    const [first, second] = ptyCalls.spawned;

    fireEvent.click(screen.getByRole('button', { name: /close terminal on second card/i }));

    await waitFor(() => expect(ptyCalls.killed).toContain(second));
    expect(ptyCalls.killed, 'closing one tab killed another card’s agent').not.toContain(first);
  });

  it('selects another tab when the active one is closed', async () => {
    // Otherwise the tab bar still shows terminals while the panel below is
    // blank, which reads as a crash.
    vi.mocked(api.listActiveItems).mockResolvedValue(TWO as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    await openTerminalOn('First card');
    await openTerminalOn('Second card');

    fireEvent.click(screen.getByRole('button', { name: /close terminal on second card/i }));

    // Located by the CARD, through the close button's label, rather than by
    // the tab's own text: tabs are titled by agent and position now, because a
    // set of tabs is usually on one card and repeating its name distinguished
    // nothing. The claim here is unchanged — the surviving tab is the selected
    // one — only the way to find it is.
    await waitFor(() => {
      // Scoped to the terminal strip: the shell's own Kanban/Terminal/Runs bar
      // is also a tablist, so an unscoped query counts four tabs and passes or
      // fails for reasons that have nothing to do with terminals.
      const strip = screen.getByRole('tablist', { name: /open terminals/i });
      const remaining = within(strip).getAllByRole('tab');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].getAttribute('aria-selected')).toBe('true');
    });
    expect(screen.getByRole('button', { name: /close terminal on first card/i })).toBeInTheDocument();
  });

  it('goes back to the empty state when the last tab is closed', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(TWO as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    await openTerminalOn('First card');

    fireEvent.click(screen.getByRole('button', { name: /close terminal on first card/i }));

    expect(await screen.findByText(/no terminal open/i)).toBeDefined();
    expect(screen.queryAllByTestId('terminal-host')).toHaveLength(0);
  });

  it('remembers the chosen agent on the card itself', async () => {
    // The seam the api mock was hiding: without updateItem in the fixture this
    // threw on every run and a catch ate it, so nothing verified the write.
    vi.mocked(api.listActiveItems).mockResolvedValue(TWO as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    fireEvent.click(await sidebarCard('First card'));

    fireEvent.click(await screen.findByRole('button', { name: /claude code/i }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /gemini/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(api.updateItem).toHaveBeenCalledWith('i1', { agentId: 'gemini' }));
  });

  it('opens the dialog on the agent the card was last worked with', async () => {
    // The read side of the same seam.
    vi.mocked(api.listActiveItems).mockResolvedValue([
      { ...TWO[0], agentId: 'gemini' },
    ] as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    fireEvent.click(await sidebarCard('First card'));

    expect(await screen.findByRole('button', { name: /gemini/i })).toBeDefined();
  });

  it('goes to the existing terminal instead of opening another on the same card', async () => {
    // Clicking a card means "take me to my work". Spawning a duplicate agent in
    // the same worktree would be the opposite of helpful.
    vi.mocked(api.listActiveItems).mockResolvedValue(TWO as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));

    await openTerminalOn('First card');
    fireEvent.click(await sidebarCard('First card'));

    // No dialog: it was a selection, not a spawn.
    expect(screen.queryByRole('dialog')).toBeNull();
    // One terminal tab, scoped to the terminal strip — tabs are titled by
    // agent and position now, so the card is identified by its close button.
    const strip = screen.getByRole('tablist', { name: /open terminals/i });
    expect(within(strip).getAllByRole('tab')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /close terminal on first card/i })).toHaveLength(1);
  });

  it('shows which branch the visible terminal is typing into', async () => {
    // With several open, this is the only thing distinguishing them, and a
    // command sent to the wrong branch is expensive.
    vi.mocked(api.listActiveItems).mockResolvedValue(TWO as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    await openTerminalOn('First card');
    expect((await screen.findByTestId('session-branch')).textContent).toContain('feat/first');
  });

  it('keeps every pane mounted, so switching tabs does not kill a session', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(TWO as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    await openTerminalOn('First card');
    await openTerminalOn('Second card');

    // Two hosts in the DOM, one of them hidden — not one host being reused.
    expect(screen.getAllByTestId('terminal-host')).toHaveLength(2);
  });
});

describe('the Sessions rail (CGLAB-170)', () => {
  it('replaces the hardcoded placeholder with real runs', async () => {
    // The footer used to be one sentence in JSX. If this regresses, the rail
    // silently becomes decoration again.
    vi.mocked(api.listRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', projectId: 'p1', harness: 'claude-code', status: 'running', startedAt: new Date().toISOString() },
    ] as never);
    renderShell();
    expect(await screen.findByTestId('session-dot')).toBeDefined();
  });

  /* The empty sentence went with the section - see the note above. */

  it('lights a row when a run event arrives for its card', async () => {
    // Liveness is recency of run:event, never AgentRun.status — the hook never
    // closes a run, so status would light every card that ever had one.
    vi.mocked(api.listRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', projectId: 'p1', harness: 'claude-code', status: 'running', startedAt: new Date().toISOString() },
    ] as never);
    renderShell();
    await screen.findByTestId('session-dot');
    expect(screen.getByTestId('session-dot').getAttribute('data-state')).toBe('idle');

    act(() => { socketHandlers['run:event']?.({ itemId: 'i1' }); });
    await waitFor(() =>
      expect(screen.getByTestId('session-dot').getAttribute('data-state')).toBe('running'));
  });

  it('takes you to the terminal, never to a log', async () => {
    // Corrected after use: an earlier version sent rows with no PTY of ours to
    // the read-only Runs view. Technically defensible, wrong in practice —
    // you clicked a running agent and landed on a log. Clicking an agent means
    // take me to it, so the destination is always a terminal.
    vi.mocked(api.listRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', projectId: 'p1', harness: 'claude-code', status: 'running', startedAt: new Date().toISOString() },
    ] as never);
    renderShell();
    fireEvent.click(await screen.findByTestId('process-open'));

    // No terminal exists for that card yet, so it offers to open one there
    // rather than doing nothing.
    expect(await screen.findByRole('dialog')).toBeDefined();
    // The run feed is the Agents screen now; `panel-runs` was its tab's panel
    // and went with the tab. Same assertion, same view, current id.
    expect(document.getElementById('panel-agents')!.hasAttribute('hidden')).toBe(true);
  });

  /*
   * Two tests about the open-terminal badge sat here and below. The badge was
   * part of the SESSIONS header and went with it: with processes drawn under
   * their cards there is no one place left that could carry a total, and the
   * terminal's own tab strip already says how many are open.
   *
   * Recorded on 1a1b8df6 as an accepted cost. If a total is ever wanted again
   * it belongs on the PROJECTS header, counting processes rather than tabs.
   */
  it('shows a terminal you just opened, even with no run recorded', async () => {
    // The gap the user hit: the rail was fed only by GET /agent-runs, and those
    // are written by the Claude Code hook. Opening a terminal here creates a
    // PTY and no run at all, so the session the user had just started was
    // invisible in the panel named Sessions.
    vi.mocked(api.listRuns).mockResolvedValue([] as never);
    vi.mocked(api.listActiveItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', type: 'TASK', title: 'First card', status: 'IN_PROGRESS' },
    ] as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    expect(screen.queryByTestId('session-dot')).toBeNull();

    const list = document.querySelector('[data-testid="project-list"]') as HTMLElement;
    fireEvent.click(await within(list).findByTitle('First card'));
    fireEvent.click(await screen.findByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getAllByTestId('session-dot').length).toBeGreaterThan(0));
    /*
     * Which card it belongs to is no longer read off the row - the row sits
     * UNDER the card, so the card's own title is the line above it, and the
     * terminal tab carries the name too. What this still has to prove is that
     * the process appears at all, which is the gap the test was written for.
     */
    expect(screen.getAllByTestId('process-row').length).toBeGreaterThan(0);
  });

  it('shows a card once when it has both a terminal and a recorded run', async () => {
    // Two sources, one card. Listing it twice would make the rail look like
    // two agents are working where there is one.
    vi.mocked(api.listRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', projectId: 'p1', harness: 'claude-code', status: 'running', startedAt: new Date().toISOString() },
    ] as never);
    vi.mocked(api.listActiveItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', type: 'TASK', title: 'First card', status: 'IN_PROGRESS' },
    ] as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    const list = document.querySelector('[data-testid="project-list"]') as HTMLElement;
    fireEvent.click(await within(list).findByTitle('First card'));
    fireEvent.click(await screen.findByRole('button', { name: /^create$/i }));

    // ONE row, not two. Listing it twice would say two agents are working on
    // the card where there is one - and now that the row sits directly under
    // that card, the double would be unmistakable.
    await waitFor(() => expect(screen.getAllByTestId('session-dot')).toHaveLength(1));
    expect(screen.getAllByTestId('process-row')).toHaveLength(1);
  });

  it('ignores an event for a card it is not showing', async () => {
    vi.mocked(api.listRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', projectId: 'p1', harness: 'claude-code', status: 'running', startedAt: new Date().toISOString() },
    ] as never);
    renderShell();
    await screen.findByTestId('session-dot');
    act(() => { socketHandlers['run:event']?.({ itemId: 'someone-else' }); });
    expect(screen.getByTestId('session-dot').getAttribute('data-state')).toBe('idle');
  });
});

/**
 * The dot under a project (CGLAB-183).
 *
 * It used to be drawn for every card in the list, one colour, always. That
 * distinguishes nothing, which makes it decoration rather than information.
 * The ask was plain: green only when an agent is working on that card right
 * now, and nothing at all otherwise.
 *
 * The obvious implementation is the wrong one and the card says why:
 * `AgentRun.status === 'running'` never becomes anything else, because the hook
 * never issues the closing PATCH (BUG df4b3343). A dot on that field goes green
 * the first time a card ever has a run and stays green forever — trading one
 * uninformative dot for another. So liveness is the RECENCY of `run:event`,
 * which is truer anyway ("an agent touched this 90 seconds ago") and lets a
 * wedged agent stop glowing on its own.
 */
describe('the working dot in the sidebar', () => {
  const oneCard = [{ id: 'i1', projectId: 'p2', type: 'TASK', title: 'Some work', status: 'IN_PROGRESS' }];

  const openTheFolder = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /expand horizon-lab/i }));
  };

  it('draws nothing when no agent is working', async () => {
    // "If nothing is happening, do not draw anything" — the absence is the
    // answer. Kept alongside the wrong-card test below even though that one
    // has more discriminating power, because this is the literal ask and the
    // one a future change is most likely to undo by accident.
    vi.mocked(api.listActiveItems).mockResolvedValue(oneCard as never);
    renderShell();
    await openTheFolder();
    await screen.findByTitle('Some work');
    expect(screen.queryByTestId('live-dot')).toBeNull();
  });

  it('appears when a run event arrives for that card', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(oneCard as never);
    renderShell();
    await openTheFolder();
    await screen.findByTitle('Some work');

    act(() => { socketHandlers['run:event']?.({ itemId: 'i1' }); });
    await waitFor(() => expect(screen.getByTestId('live-dot')).toBeTruthy());
  });

  it('stays dark for a card the event was not about', async () => {
    // The whole point of the change: the dot has to mean something about THIS
    // card, or it is the old always-on dot with extra steps.
    vi.mocked(api.listActiveItems).mockResolvedValue(oneCard as never);
    renderShell();
    await openTheFolder();
    await screen.findByTitle('Some work');

    act(() => { socketHandlers['run:event']?.({ itemId: 'some-other-card' }); });
    await waitFor(() => expect(screen.queryByTestId('live-dot')).toBeNull());
  });

  it('leaves the step label alone, because the dot does not repeat it', async () => {
    // Two things, two jobs: the dot says an agent is here now, the label says
    // which step the card is sitting in.
    vi.mocked(api.listActiveItems).mockResolvedValue(oneCard as never);
    renderShell();
    await openTheFolder();
    const row = await screen.findByTitle('Some work');
    expect(row.textContent).toMatch(/IN_PROGRESS/);
  });

  it('says it in words too, not only in colour', async () => {
    /*
     * Replaces an assertion that checked the element carried the literal class
     * string 'motion-reduce:animate-none'. That is a Tailwind spelling test: no
     * CSS is applied in jsdom, so it passed whether or not the variant worked,
     * and it would have failed on a cosmetic rename. The reduced-motion class
     * is still there — it is simply not something a unit test can observe.
     *
     * What IS worth asserting is that the state reaches someone not looking at
     * a 6px green dot. A `title` on a non-focusable span never reaches
     * assistive tech at all.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue(oneCard as never);
    renderShell();
    await openTheFolder();
    const row = await screen.findByTitle('Some work');
    expect(row.textContent).not.toMatch(/an agent is working/i);

    act(() => { socketHandlers['run:event']?.({ itemId: 'i1' }); });
    await waitFor(() => expect(row.textContent).toMatch(/an agent is working/i));
  });

  it('goes out on its own when the agent stops', async () => {
    /*
     * The half of the feature that had no coverage at all, and the reason
     * recency beats AgentRun.status: a wedged agent stops glowing without
     * anyone closing a run.
     *
     * Driven past the TTL plus the sweep interval, because expiry is swept on
     * a timer rather than computed on read — so the dot can linger for up to
     * one sweep, which is inherent and worth pinning rather than hiding.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue(oneCard as never);
    renderShell();
    await openTheFolder();
    await screen.findByTitle('Some work');
    // Installed BEFORE the event, because the sweep interval is created by
    // `touch()` — fake timers installed afterwards cannot drive a timer that
    // was already scheduled with the real ones.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      act(() => { socketHandlers['run:event']?.({ itemId: 'i1' }); });
      await waitFor(() => expect(screen.getByTestId('live-dot')).toBeTruthy());
      await act(async () => { vi.advanceTimersByTime(LIVE_TTL_MS + 10_000); });
      await waitFor(() => expect(screen.queryByTestId('live-dot')).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Sidebar rows that stopped overlapping (CGLAB-186).
 *
 * Two reports from use, with screenshots, and they are the same defect in two
 * places: a control positioned absolutely, drawn on top of text that never got
 * out of its way. Overlapping text reads as a broken app rather than a crowded
 * one, so this is legibility, not polish.
 */
describe('the projects row when a project is pinned', () => {
  const oneCard = [{ id: 'i1', projectId: 'p2', type: 'TASK', title: 'Some work', status: 'IN_PROGRESS' }];

  it('leaves room for the pin, instead of letting it sit on the age', async () => {
    /*
     * The hover case already worked — the age hides and the pin and + take the
     * corner. A PINNED project keeps its pin at full opacity always, and
     * rightly: otherwise there is no way to see it is pinned nor to reach the
     * control by keyboard. With no hover to hide behind, the pin was simply
     * drawn over the age.
     *
     * Asserting the reserved space rather than the absence of the age: losing
     * information to fix a layout would be the wrong trade, and the age is why
     * the column exists.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue(oneCard as never);
    renderShell();
    const pin = await screen.findByRole('button', { name: /pin project horizon-lab/i });
    fireEvent.click(pin);

    await waitFor(() => expect(screen.getByRole('button', { name: /unpin project horizon-lab/i })).toBeTruthy());
    // Scoped to the row whose pin was clicked — the fixture has several
    // projects — and to the age itself rather than "a span with a digit in
    // it", which matched the in-flight count first.
    const row = screen.getByRole('button', { name: /unpin project horizon-lab/i }).parentElement!;
    const age = row.querySelector('[data-testid="project-age"]')!;
    expect(age.className, 'the age has no room reserved for the pin').toMatch(/mr-5/);
  });
});

describe('right-clicking a card in the projects tree', () => {
  const oneCard = [{ id: 'i1', projectId: 'p2', type: 'TASK', title: 'Some work', status: 'IN_PROGRESS' }];

  const openMenu = async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(oneCard as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: /expand horizon-lab/i }));
    fireEvent.contextMenu(await screen.findByTitle('Some work'));
    return screen.findByRole('menu', { name: /actions for Some work/i });
  };

  it('offers Show in board, which a left click does not', async () => {
    // A left click opens a TERMINAL — the thing you want from work in flight.
    // The board had no route from here at all, and the row is far too narrow
    // for a second button.
    const menu = await openMenu();
    expect(within(menu).getByRole('menuitem', { name: /show in board/i })).toBeTruthy();
  });

  it('does not open a terminal when the menu is opened', async () => {
    // The gesture is secondary; it must not also fire the primary action.
    await openMenu();
    expect(screen.queryByRole('dialog', { name: /open a terminal/i })).toBeNull();
  });

  it('closes when you click away, not only when you choose', async () => {
    // A menu that can only be dismissed by picking something is a trap.
    const menu = await openMenu();
    fireEvent.click(menu.previousElementSibling!);
    await waitFor(() => expect(screen.queryByRole('menu', { name: /actions for/i })).toBeNull());
  });
});

/**
 * The projects tree in the new drawing, and the WORK group above it (CGLAB-164).
 *
 * Three separate claims, and they are worth keeping separate:
 *
 *  1. The row got bigger and gained a second line. The type was 11px and the
 *     branch was nowhere, which meant the one fact that tells two cards in the
 *     same step apart was invisible in the list built to scan them.
 *  2. The row carries exactly ONE dot, and it is about the AGENT, never the
 *     flow step. The app has a Sessions rail as well as this tree, and two
 *     lists repeating one status is the failure mode the design avoids.
 *  3. View selection moved into the sidebar as a WORK group. The tab strip is
 *     still there — retiring it is a separate card with its own test churn —
 *     so what matters here is that the new route works and that reaching it
 *     does not unmount anything.
 */
describe('the projects tree row in the new drawing (CGLAB-164)', () => {
  const CARDS = [
    { id: 'i1', projectId: 'p2', type: 'TASK', title: 'Some work', status: 'IN_PROGRESS', branchName: 'feat/CGLAB-1_some-work' },
    { id: 'i2', projectId: 'p2', type: 'BUG', title: 'Other work', status: 'REVIEW' },
  ];

  const openTheFolder = async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(CARDS as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: /expand horizon-lab/i }));
    return screen.findByTitle('Some work');
  };

  /** The px in a Tailwind arbitrary text size — the only size jsdom can see. */
  const sizeOf = (el: Element): number => {
    const found = /text-\[(\d+(?:\.\d+)?)px\]/.exec(el.className);
    expect(found, `no arbitrary text size on ${el.getAttribute('data-testid')}`).not.toBeNull();
    return Number(found![1]);
  };

  it('shows the branch on a second line, under the title', async () => {
    const row = await openTheFolder();
    const branch = within(row).getByTestId('card-branch');
    expect(branch.textContent).toBe('feat/CGLAB-1_some-work');
    // Under it, not beside it: the title is its own element and the branch
    // follows it in the row.
    const title = within(row).getByTestId('card-title');
    expect(title.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says a card has no branch rather than leaving the line blank', async () => {
    // A blank second line reads as a rendering bug, and the absence of a
    // branch is itself worth knowing — it is the card nobody has started.
    await openTheFolder();
    const row = await screen.findByTitle('Other work');
    expect(within(row).getByTestId('card-branch').textContent).toMatch(/no branch yet/i);
  });

  it('keeps a real branch readable to assistive tech but does not repeat the placeholder', async () => {
    /*
     * Review found this change arguing both sides of one rule. The dot
     * suppresses its "nothing running" label precisely because saying it on
     * every row of a thirty-card list is noise — and then the branch line
     * announced "no branch yet" on every branchless row for the same reason it
     * should not have.
     *
     * A REAL branch is the opposite case: it is the single thing that tells
     * two cards sitting in the same step apart, so it stays in the row's
     * accessible name. Only the placeholder is hidden.
     */
    await openTheFolder();
    const withBranch = await screen.findByTitle('Some work');
    const without = await screen.findByTitle('Other work');

    expect(within(withBranch).getByTestId('card-branch').getAttribute('aria-hidden')).toBeNull();
    expect(within(without).getByTestId('card-branch').getAttribute('aria-hidden')).toBe('true');
  });

  it('draws the branch in mono, dimmer and smaller than the title', async () => {
    // A branch name is an identifier. Proportional type makes l/1 and rn/m
    // ambiguous in exactly the strings you have to compare by eye.
    const row = await openTheFolder();
    const branch = within(row).getByTestId('card-branch');
    expect(branch.className).toMatch(/font-mono/);
    expect(sizeOf(branch)).toBeLessThan(sizeOf(within(row).getByTestId('card-title')));
  });

  it('sets the card title bigger than the 11px it used to be', async () => {
    // The literal ask. The rows were 11px and cramped.
    const row = await openTheFolder();
    expect(sizeOf(within(row).getByTestId('card-title'))).toBeGreaterThan(11);
  });

  it('orders the row type: title, then branch, then step', async () => {
    // One hierarchy, three sizes. The step is the smallest because it is the
    // thing you filter by, not the thing you read.
    const row = await openTheFolder();
    const title = sizeOf(within(row).getByTestId('card-title'));
    const branch = sizeOf(within(row).getByTestId('card-branch'));
    const step = sizeOf(within(row).getByTestId('card-step'));
    expect(title).toBeGreaterThan(branch);
    expect(branch).toBeGreaterThan(step);
  });

  it('keeps the flow step as plain text, and gives it no colour of its own', async () => {
    /*
     * The alignment half of this test is gone, and deliberately. The step used
     * to be the row's last COLUMN, sized to its content and pushed right - and
     * a flow may name a step CREATE_UNIT_TESTS, which left roughly 90px for a
     * title in a 224px rail and cut real ones to two words. The title has the
     * row now and the step sits with the branch on the second line, so
     * "right-aligned" no longer describes anything.
     *
     * The COLOUR half is untouched and is the half that was load-bearing: an
     * earlier version of this test checked only `textContent` and `uppercase`,
     * and passed with the step rendered in bright red.
     */
    const row = await openTheFolder();
    const step = within(row).getByTestId('card-step');
    expect(step.textContent).toBe('IN_PROGRESS');

    // With the branch, not with the title. Structure rather than geometry:
    // jsdom has no layout, so measuring here would be theatre.
    expect(step.parentElement).toBe(within(row).getByTestId('card-branch').parentElement);

    // No colour: it must carry no background, no hue-bearing text class, and
    // no state attribute. The dot is the only thing on this row allowed to
    // mean something in colour, and the step is not a second copy of it.
    expect(step.getAttribute('data-card-state'), 'the step became a state mark').toBeNull();
    expect(step.className, 'the step was given a colour of its own')
      .not.toMatch(/(^|\s)(bg-|text-[a-z]+-\d)/);
  });

  it('draws exactly one state dot per row', async () => {
    // ONE. The row is 224px wide and a second signal is a second thing to
    // learn; the point of the redesign is that the tree says one thing well.
    const row = await openTheFolder();
    expect(row.querySelectorAll('[data-card-state]')).toHaveLength(1);
  });

  it('gives two cards in different flow steps the same dot when neither is running', async () => {
    /*
     * The decision the user took, deliberately, against the first version of
     * the study: the dot does NOT carry the flow step's colour. IN_PROGRESS
     * and REVIEW are different steps; with no agent on either card they are
     * the same dot, because the dot is about agents.
     */
    await openTheFolder();
    const inProgress = await screen.findByTitle('Some work');
    const inReview = await screen.findByTitle('Other work');
    const dot = (row: HTMLElement) => row.querySelector('[data-card-state]') as HTMLElement;
    expect(dot(inProgress).getAttribute('data-card-state')).toBe('quiet');
    expect(dot(inReview).getAttribute('data-card-state')).toBe('quiet');
    expect(dot(inProgress).className).toBe(dot(inReview).className);
  });

  it('turns the dot to working for the card an agent is actually on', async () => {
    const row = await openTheFolder();
    expect(row.querySelector('[data-card-state]')!.getAttribute('data-card-state')).toBe('quiet');

    act(() => { socketHandlers['run:event']?.({ itemId: 'i1' }); });
    await waitFor(() =>
      expect(row.querySelector('[data-card-state]')!.getAttribute('data-card-state')).toBe('working'));
    // And only that card.
    const other = await screen.findByTitle('Other work');
    expect(other.querySelector('[data-card-state]')!.getAttribute('data-card-state')).toBe('quiet');
  });
});

describe('the WORK group in the sidebar (CGLAB-164)', () => {
  const workNav = () => screen.getByRole('navigation', { name: /work/i });
  const workRow = (name: RegExp) => within(workNav()).getByRole('button', { name });

  it('sits above Projects, with Tasks, Flows and Agents', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });

    // Positioned by the landmark rather than by a heading: the group's visible
    // "Work" title is gone and its name lives on the <nav> now.
    const projects = screen.getByRole('heading', { name: /^projects$/i });
    expect(workNav().compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(workRow(/tasks/i)).toBeDefined();
    expect(workRow(/flows/i)).toBeDefined();
    expect(workRow(/agents/i)).toBeDefined();
  });

  it('shows the board when Tasks is picked', async () => {
    renderShell();
    await screen.findByText('agenfk');
    // Away first, so "shows the board" is a change rather than the state the
    // shell already opens in. Agents, because it is the only other view a
    // sidebar row reaches without opening a terminal.
    fireEvent.click(workRow(/agents/i));
    expect(document.getElementById('panel-kanban')!.hasAttribute('hidden')).toBe(true);

    fireEvent.click(workRow(/tasks/i));
    expect(document.getElementById('panel-kanban')!.hasAttribute('hidden')).toBe(false);
  });

  it('marks which WORK view you are on, and only that one', async () => {
    renderShell();
    await screen.findByText('agenfk');
    expect(workRow(/tasks/i).getAttribute('aria-current')).toBe('page');

    fireEvent.click(workRow(/agents/i));
    expect(workRow(/agents/i).getAttribute('aria-current')).toBe('page');
    expect(workRow(/tasks/i).getAttribute('aria-current')).toBeNull();
  });

  it('opens the run feed on Agents, which is what it was a placeholder for', async () => {
    /*
     * Agents used to say the run feed "is not here yet" while a Runs TAB
     * showed the feed - one destination described two ways, and the user got
     * the same "No agent runs open" sentence twice on one screen. The tab is
     * gone and this row is the feed.
     *
     * It is also THE way to open Runs, and the only one: with no tab to click,
     * a run feed reachable only from a control inside itself would be a view
     * with no way in.
     *
     * This used to cover the Inbox panel too. Inbox was removed in favour of
     * Flows, which opens the flow editor and has no panel at all, so the Inbox
     * half of this test became unreachable rather than merely unasserted. Its
     * replacement lives in sidebarFlows.test.tsx, which pins that Flows opens a
     * window WITHOUT changing the view. Nothing here needs restoring.
     */
    renderShell();
    await screen.findByText('agenfk');

    fireEvent.click(workRow(/agents/i));
    const agents = document.getElementById('panel-agents')!;
    expect(agents.hasAttribute('hidden')).toBe(false);
    // The feed itself, not a note about a feed that does not exist yet.
    expect(agents.textContent).toMatch(/no agent runs open/i);
    expect(agents.textContent, 'Agents is still describing itself as unbuilt')
      .not.toMatch(/not here yet/i);

    fireEvent.click(workRow(/tasks/i));
    expect(agents.hasAttribute('hidden')).toBe(true);
  });

  it('hides the board for Agents — never unmounts it', async () => {
    /*
     * The invariant AppShell is built on. Conditional rendering here would
     * throw away the board's filters and anything half-typed, and the same
     * mistake on the terminal panel kills a live agent and its scrollback.
     * Asserted by the board's own React state surviving the round trip, not
     * by reading a class.
     */
    renderShell();
    await screen.findByText('agenfk');
    const input = screen.getByLabelText('board-state') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'unsaved work' } });
    const mountsBefore = boardMounts;

    fireEvent.click(workRow(/agents/i));
    expect(document.getElementById('panel-kanban')!.hasAttribute('hidden')).toBe(true);
    expect(screen.getByText('THE BOARD')).toBeDefined();

    fireEvent.click(workRow(/tasks/i));

    expect(boardMounts).toBe(mountsBefore);
    expect((screen.getByLabelText('board-state') as HTMLInputElement).value).toBe('unsaved work');
  });

  it('leaves a live terminal alone when a WORK view is selected', async () => {
    // Unmounting the terminal panel kills the agent running in it. The tab
    // strip already guarantees this; the sidebar is a second route to the same
    // switch and has to guarantee it too.
    vi.mocked(api.listActiveItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', type: 'TASK', title: 'Some work', status: 'IN_PROGRESS' },
    ] as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    fireEvent.click(await screen.findByTitle('Some work'));
    fireEvent.click(await screen.findByRole('button', { name: /^create$/i }));
    await waitFor(() =>
      expect(document.getElementById('panel-terminal')!.hasAttribute('hidden')).toBe(false));

    fireEvent.click(workRow(/agents/i));
    const terminal = document.getElementById('panel-terminal');
    expect(terminal, 'the terminal panel was unmounted, which kills the agent').not.toBeNull();
    expect(terminal!.hasAttribute('hidden')).toBe(true);
    expect(terminal!.childElementCount, 'the terminal pane itself was torn down').toBeGreaterThan(0);
  });

  it('is gone with the sidebar when it is collapsed, and comes back with it', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    expect(screen.queryByRole('navigation', { name: /work/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /expand sidebar/i }));
    expect(screen.getByRole('navigation', { name: /work/i })).toBeDefined();
  });
});
