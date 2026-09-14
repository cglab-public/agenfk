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
const setBridge = (platform: string) => {
  Object.defineProperty(window, 'agenfkDesktop', {
    value: {
      isDesktop: true,
      platform,
      versions: { electron: '40.10.6', chrome: '130', node: '24' },
      terminal: {
        spawn: async (req: unknown) => {
          ptySeq += 1;
          const id = `sess-${ptySeq}`;
          ptyCalls.spawned.push(id);
          // Recorded so the multi-session wiring is checkable: a bug passing
          // one session's itemId to every pane would otherwise leave every
          // test in this file green.
          ptyCalls.requests.push(req);
          return id;
        },
        write: async () => true,
        resize: async () => true,
        kill: async (id: string) => { ptyCalls.killed.push(id); return true; },
        onData: () => () => {},
        onExit: () => () => {},
        listAgents: async () => [
          { id: 'claude', label: 'Claude Code', installed: true, supportsAutoApprove: true },
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

  it('makes every control inside a drag region opt back out', () => {
    // A drag region swallows pointer events, so a control left inside one
    // silently stops responding. The tab bar IS a drag region (it doubles as
    // the title bar), so this walks every region and every control in them —
    // an earlier version only looked at the first region, which was empty,
    // and therefore could never fail.
    const { container } = renderShell();
    const regions = container.querySelectorAll('[data-app-region="drag"]');
    expect(regions.length).toBeGreaterThan(0);

    let checked = 0;
    for (const region of Array.from(regions)) {
      for (const el of Array.from(region.querySelectorAll('button, a, input'))) {
        checked += 1;
        expect(el.closest('[data-app-region="no-drag"]'), `${el.textContent} would be unclickable`).not.toBeNull();
      }
    }
    // Proof the loop actually ran: the tabs are controls inside a drag region.
    expect(checked).toBeGreaterThan(0);
  });

  it('keeps a real drag handle when the sidebar is collapsed', async () => {
    // Collapsed, the rail is 40px and the traffic lights cover half of it.
    // The tab row has to be draggable or the window is moved by a ~20px sliver.
    const { container } = renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    const tablist = screen.getByRole('tablist');
    expect(tablist.getAttribute('data-app-region')).toBe('drag');
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

  it('shows a Kanban tab', () => {
    renderShell();
    expect(screen.getByRole('tab', { name: /kanban/i })).toBeDefined();
  });

  it('names the sessions area and says plainly that there are none yet', () => {
    renderShell();
    expect(screen.getByRole('heading', { name: /sessions/i })).toBeDefined();
    expect(screen.getByText(/none running/i)).toBeDefined();
  });
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
    // agenfk's item belongs to a different folder and must stay hidden.
    expect(screen.queryByText('Something in agenfk')).toBeNull();
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
    expect(screen.queryByText('Fix the login redirect')).toBeNull();
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
  it('keeps the tabs clear of the traffic lights when the sidebar is collapsed', async () => {
    // The collapsed rail is ~40px but macOS traffic lights occupy ~78px from
    // the window edge, so without reserving that space the first tab renders
    // UNDER the close/minimise/zoom buttons: unclickable, and the OS window
    // menu opens on top of it.
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));

    const tablist = screen.getByRole('tablist');
    expect(tablist.getAttribute('data-reserves-window-controls')).toBe('true');
  });

  it('reserves nothing while the sidebar is open — it already clears them', async () => {
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    expect(screen.getByRole('tablist').getAttribute('data-reserves-window-controls')).toBeNull();
  });

  it('reserves nothing off macOS, where the native title bar is still there', async () => {
    setBridge('win32');
    renderShell();
    await screen.findByRole('button', { name: 'horizon-lab' });
    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    expect(screen.getByRole('tablist').getAttribute('data-reserves-window-controls')).toBeNull();
  });
});

describe('AppShell — tabs', () => {
  it('mounts the board exactly once', () => {
    renderShell();
    expect(boardMounts).toBe(1);
  });

  it('does not remount or reset the board when another tab is selected', () => {
    // The point of tabs here: a session pane must not cost you the board's
    // React state — filters, expanded cards, a half-typed title. (Scroll
    // position is NOT preserved: `hidden` removes the layout box and with it
    // scrollTop. Claiming otherwise in this test would be a lie the assertions
    // never check.)
    renderShell();
    const input = screen.getByLabelText('board-state') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'unsaved work' } });

    const runsTab = screen.getByRole('tab', { name: /runs/i });
    fireEvent.click(runsTab);
    fireEvent.click(screen.getByRole('tab', { name: /kanban/i }));

    expect(boardMounts).toBe(1);
    expect((screen.getByLabelText('board-state') as HTMLInputElement).value).toBe('unsaved work');
  });

  it('moves between tabs with the arrow keys, wrapping at the ends', () => {
    renderShell();
    const first = screen.getByRole('tab', { name: /kanban/i });
    first.focus();

    // Written against the tab LIST rather than named tabs, so adding one does
    // not silently turn "wraps at the end" into "moves to the second tab" —
    // which is what happened when the Terminal tab landed (CGLAB-169).
    const tabs = screen.getAllByRole('tab');
    for (let i = 1; i < tabs.length; i += 1) {
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
      expect(screen.getAllByRole('tab')[i].getAttribute('aria-selected')).toBe('true');
    }

    // Wraps rather than dead-ending at the last tab.
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /kanban/i }).getAttribute('aria-selected')).toBe('true');
  });

  it('jumps to the first and last tab with Home and End', () => {
    renderShell();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' });
    expect(screen.getByRole('tab', { name: /runs/i }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Home' });
    expect(screen.getByRole('tab', { name: /kanban/i }).getAttribute('aria-selected')).toBe('true');
  });

  it('gives the tablist a single tab stop, not one per tab', () => {
    // Roving tabindex: without it Tab walks every tab one at a time, which is
    // the behaviour the ARIA pattern exists to avoid.
    renderShell();
    const stops = screen.getAllByRole('tab').filter(t => t.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
  });

  it('leaves other keys alone', () => {
    renderShell();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'a' });
    expect(screen.getByRole('tab', { name: /kanban/i }).getAttribute('aria-selected')).toBe('true');
  });

  it('marks exactly one tab selected at a time', () => {
    renderShell();
    fireEvent.click(screen.getByRole('tab', { name: /runs/i }));
    const selected = screen.getAllByRole('tab').filter(t => t.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toMatch(/runs/i);
  });

  it('hides the inactive panel from assistive tech rather than just visually', () => {
    renderShell();
    const panels = screen.getAllByRole('tabpanel', { hidden: true });
    const visible = panels.filter(p => !p.hasAttribute('hidden'));
    expect(visible).toHaveLength(1);
  });
});

describe('sidebar navigation has to reach the board (CGLAB-172)', () => {
  // The board lives in a tabpanel with `hidden`, and the card-detail modal is
  // rendered inside the board tree — so it is hidden too. Navigating from the
  // sidebar while another tab is selected therefore opens a draft nobody can
  // see, scrolls a board nobody is looking at, and burns the 3s highlight
  // off-screen. From the user's side the sidebar is simply broken.

  const onRunsTab = async () => {
    renderShell();
    await screen.findByText('agenfk');
    fireEvent.click(screen.getByRole('tab', { name: /runs/i }));
    expect(screen.getByRole('tab', { name: /runs/i }).getAttribute('aria-selected')).toBe('true');
  };

  const kanbanPanel = () => document.getElementById('panel-kanban')!;

  it('goes to the Terminal tab when a card is opened from the sidebar', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', type: 'TASK', title: 'Some work', status: 'IN_PROGRESS' },
    ] as never);
    await onRunsTab();
    fireEvent.click(screen.getByRole('button', { name: 'Expand agenfk', hidden: true }));
    fireEvent.click(await screen.findByTitle('Some work'));

    // Create in the dialog, then the Terminal panel is the visible one.
    fireEvent.click(await screen.findByRole('button', { name: /^create$/i }));
    await waitFor(() =>
      expect(document.getElementById('panel-terminal')!.hasAttribute('hidden')).toBe(false));
  });

  it('comes back to the board when + creates a card from the sidebar', async () => {
    await onRunsTab();
    fireEvent.click(screen.getByRole('button', { name: /New card in agenfk/i }));
    await waitFor(() => expect(kanbanPanel().hasAttribute('hidden')).toBe(false));
  });

  it('does not steal the tab on its own', async () => {
    // The effect must react to a navigation, not to mounting — otherwise the
    // Runs tab becomes unusable, snapping back on every render.
    await onRunsTab();
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

  it('keeps the terminal panel mounted when another tab is selected', async () => {
    renderShell();
    await screen.findByText('agenfk');

    fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));
    const panel = document.getElementById('panel-terminal')!;
    expect(panel.hasAttribute('hidden')).toBe(false);
    expect(panel.childElementCount, 'terminal panel rendered nothing').toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: /kanban/i }));
    expect(panel.hasAttribute('hidden')).toBe(true);
    expect(
      panel.childElementCount,
      'the terminal was unmounted on tab switch — the session dies and the scrollback goes with it',
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

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /First card/i }).getAttribute('aria-selected')).toBe('true'));
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
    expect(screen.getAllByRole('tab', { name: /First card/i })).toHaveLength(1);
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
