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

/** The preload bridge, which is what tells the UI it is in the desktop app. */
const setBridge = (platform: string) => {
  Object.defineProperty(window, 'agenfkDesktop', {
    value: { isDesktop: true, platform, versions: { electron: '40.10.6', chrome: '130', node: '24' } },
    configurable: true, writable: true,
  });
};

beforeEach(() => {
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

  it('takes you to the work when a row is clicked', async () => {
    // The gap this closes: the rows used to be plain divs. The sidebar showed
    // what was in flight and gave you no way to reach any of it.
    const focused: string[] = [];
    function Spy() {
      const { focusedItemId } = useActiveProject();
      React.useEffect(() => { if (focusedItemId) focused.push(focusedItemId); }, [focusedItemId]);
      return null;
    }
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
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
    fireEvent.click(within(row).getByRole('button', { name: /expand horizon-lab/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Fix the login redirect/i }));

    expect(focused.at(-1)).toContain('i1');
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

    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /runs/i }).getAttribute('aria-selected')).toBe('true');

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

  it('comes back to the board when a card is clicked in the sidebar', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', type: 'TASK', title: 'Some work', status: 'IN_PROGRESS' },
    ] as never);
    await onRunsTab();
    // Open the project's folder so its work is listed.
    fireEvent.click(screen.getByRole('button', { name: 'Expand agenfk', hidden: true }));
    fireEvent.click(await screen.findByTitle('Some work'));
    await waitFor(() => expect(kanbanPanel().hasAttribute('hidden')).toBe(false));
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
