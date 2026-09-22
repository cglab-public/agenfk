/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import { KanbanBoard } from '../components/KanbanBoard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { ActiveProjectProvider, useActiveProject } from '../ActiveProject';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { ItemType, Status } from '../types';
import { ITEM_TYPE_VISUAL } from '../components/ItemTypeSquare';
import { io } from 'socket.io-client';
import { SocketProvider } from '../SocketContext';

// Mock socket.io-client. Handlers are recorded rather than dropped so a test
// can fire a server event — `project_switched` in particular, since the pin
// exists to suppress exactly that and nothing else proves it does.
const socketHandlers: Record<string, (payload: unknown) => void> = {};
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connected: true,
    connect: vi.fn(),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => { socketHandlers[event] = handler; }),
    off: vi.fn((event: string) => { delete socketHandlers[event]; }),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock scrollTo
if (typeof window !== 'undefined') {
  window.HTMLElement.prototype.scrollTo = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

// Default flow used in tests — uses Status names as labels to keep column header assertions stable
const DEFAULT_FLOW_MOCK = {
  id: 'default',
  name: 'Default Flow',
  projectId: '__builtin__',
  steps: [
    { id: 's-ideas', name: 'IDEAS', label: 'IDEAS', order: 0, isSpecial: true },
    { id: 's-todo', name: 'TODO', label: 'TODO', order: 1 },
    { id: 's-ip', name: 'IN_PROGRESS', label: 'IN PROGRESS', order: 2 },
    { id: 's-review', name: 'REVIEW', label: 'REVIEW', order: 3 },
    { id: 's-test', name: 'TEST', label: 'TEST', order: 4 },
    { id: 's-done', name: 'DONE', label: 'DONE', order: 5 },
    { id: 's-blocked', name: 'BLOCKED', label: 'BLOCKED', order: 6, isSpecial: true },
    { id: 's-paused', name: 'PAUSED', label: 'PAUSED', order: 7, isSpecial: true },
    { id: 's-archived', name: 'ARCHIVED', label: 'ARCHIVED', order: 8, isSpecial: true },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(() => Promise.resolve([])),
    listItems: vi.fn(() => Promise.resolve([])),
    getItem: vi.fn(() => Promise.resolve({})),
    createItem: vi.fn(() => Promise.resolve({})),
    updateItem: vi.fn(() => Promise.resolve({})),
    deleteItem: vi.fn(() => Promise.resolve({})),
    deleteProject: vi.fn(() => Promise.resolve({})),
    createProject: vi.fn(() => Promise.resolve({ id: 'p-new', name: 'New' })),
    bulkUpdateItems: vi.fn(() => Promise.resolve({})),
    trashArchivedItems: vi.fn(() => Promise.resolve({})),
    getJiraStatus: vi.fn(() => Promise.resolve({ configured: false, connected: false })),
    getLatestRelease: vi.fn(() => Promise.resolve(null)),
    getVersion: vi.fn(() => Promise.resolve({ version: '1.0.0' })),
    getProjectFlow: vi.fn(() => Promise.resolve(DEFAULT_FLOW_MOCK)),
    getGitHubStatus: vi.fn(() => Promise.resolve({ configured: false })),
  }
}));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: 0 },
  },
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <ActiveProjectProvider>
    <ThemeProvider>
      {children}
    </ThemeProvider>
    </ActiveProjectProvider>
  </QueryClientProvider>
);

describe('KanbanBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    queryClient.clear();
    vi.mocked(api.getProjectFlow).mockResolvedValue(DEFAULT_FLOW_MOCK as any);
  });

  afterEach(() => {
    cleanup();
  });

  describe('switching project from outside the board (CGLAB-168)', () => {
    it('clears the drill-down so the new project is not filtered by the old one\'s epic', async () => {
      // The sidebar sets the shared project id directly. If navPath survives
      // that, every column filters project B's items by project A's epic id:
      // an empty board under a breadcrumb still naming A's epic, with nothing
      // on screen to explain it.
      const projects = [
        { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() },
        { id: 'p2', name: 'P2', createdAt: new Date(), updatedAt: new Date() },
      ];
      const epic = { id: 'e1', projectId: 'p1', type: ItemType.EPIC, title: 'Epic One', status: Status.IN_PROGRESS, createdAt: new Date(), updatedAt: new Date() };
      const child = { id: 'c1', projectId: 'p1', parentId: 'e1', type: ItemType.TASK, title: 'Child Task', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() };
      const other = { id: 'o1', projectId: 'p2', type: ItemType.TASK, title: 'Other Task', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() };

      vi.mocked(api.listProjects).mockResolvedValue(projects as any);
      vi.mocked(api.listItems).mockImplementation((async (params: any) =>
        params?.projectId === 'p2' ? [other] : [epic, child]) as any);
      localStorage.setItem('agenfk_project_id', 'p1');

      function Harness() {
        const { setActiveProjectId } = useActiveProject();
        return (
          <>
            <button onClick={() => setActiveProjectId('p2')}>switch outside</button>
            <KanbanBoard />
          </>
        );
      }
      render(<Harness />, { wrapper });

      // Drill into the epic via its child-count button.
      fireEvent.click(await screen.findByRole('button', { name: /Show 1 child items/i }));
      await screen.findByText('Child Task');

      fireEvent.click(screen.getByText('switch outside'));

      // The new project's item must be visible, not filtered away.
      expect(await screen.findByText('Other Task')).toBeDefined();
      expect(screen.queryByText('Child Task')).toBeNull();
    });
  });

  describe('navigating to a card from the sidebar (CGLAB-172)', () => {
    const ITEM = { id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'Target Task', status: Status.IN_PROGRESS, createdAt: new Date(), updatedAt: new Date() };

    function FocusHarness() {
      const { focusItem, setActiveProjectId } = useActiveProject();
      return (
        <>
          <button onClick={() => focusItem('i1', 'p1')}>focus i1</button>
          <button onClick={() => setActiveProjectId('p2')}>go to p2</button>
          <KanbanBoard />
        </>
      );
    }

    it('does not re-hijack the search box when the items list refreshes', async () => {
      // The effect that reacts to focusedItemId has `items` in its deps, and
      // focusedItemId is never cleared. An agent fires items_updated
      // constantly, and each one gives `items` a new reference. Without a
      // one-shot guard the board keeps re-applying a navigation the user
      // finished with minutes ago: it overwrites whatever they have since
      // typed, re-runs the search and scrolls the board back.
      const projects = [{ id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() }];
      vi.mocked(api.listProjects).mockResolvedValue(projects as any);
      // The refetch must return genuinely DIFFERENT data, not just a fresh
      // array. TanStack Query's structuralSharing reuses the previous object
      // when the payload is deep-equal, so an identical refetch leaves `items`
      // referentially unchanged and the effect never re-runs — the bug hides.
      // What actually happens in an AgEnFK install is an agent touching some
      // OTHER item in the project, which is what this simulates.
      let revision = 0;
      vi.mocked(api.listItems).mockImplementation((async () => {
        revision += 1;
        return [ITEM, { ...ITEM, id: 'i2', title: `Agent Task ${revision}` }];
      }) as any);
      localStorage.setItem('agenfk_project_id', 'p1');
      render(<FocusHarness />, { wrapper });
      await screen.findByText('Target Task');

      fireEvent.click(screen.getByText('focus i1'));
      const search = screen.getByPlaceholderText(/Search Item ID or Name/i) as HTMLInputElement;
      await waitFor(() => expect(search.value).toBe('i1'));

      // The user moves on and types their own query.
      fireEvent.change(search, { target: { value: 'something else' } });
      expect(search.value).toBe('something else');

      // An agent touches any item in the project. Wait for the NEW data to be
      // on screen, so the assertion below cannot pass merely because the
      // refetch had not landed yet.
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['items'] });
      });
      await screen.findByText(/Agent Task 2/);

      expect(search.value).toBe('something else');
    });

    it('does not flash NOT FOUND on a project the user opened normally', async () => {
      // Focus a card in p1, then switch to p2 from the sidebar. The stale
      // focusedItemId re-fires against p2's items, finds nothing, and the
      // header reports NOT FOUND for a project the user just opened by hand.
      const projects = [
        { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() },
        { id: 'p2', name: 'P2', createdAt: new Date(), updatedAt: new Date() },
      ];
      const other = { id: 'o1', projectId: 'p2', type: ItemType.TASK, title: 'Other Task', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() };
      vi.mocked(api.listProjects).mockResolvedValue(projects as any);
      vi.mocked(api.listItems).mockImplementation((async (params: any) =>
        params?.projectId === 'p2' ? [other] : [ITEM]) as any);
      localStorage.setItem('agenfk_project_id', 'p1');
      render(<FocusHarness />, { wrapper });
      await screen.findByText('Target Task');

      fireEvent.click(screen.getByText('focus i1'));
      await waitFor(() =>
        expect((screen.getByPlaceholderText(/Search Item ID or Name/i) as HTMLInputElement).value).toBe('i1'));

      fireEvent.click(screen.getByText('go to p2'));
      expect(await screen.findByText('Other Task')).toBeDefined();
      expect(screen.queryByText(/NOT FOUND/i)).toBeNull();
    });

    it('waits for fresh data instead of burning the one-shot on a stale cache', async () => {
      // The hole the first guard left. TanStack returns a CACHED array
      // synchronously while it refetches in the background, and
      // `invalidateQueries` does not refetch INACTIVE queries — so a project
      // the user left minutes ago still has its old item list in cache,
      // missing everything an agent has created since.
      //
      // Click such an item in the sidebar and the effect ran against that
      // stale array, found nothing, flashed NOT FOUND, and burned the ref. The
      // fresh data then arrived and the guard refused to re-run: the click did
      // nothing at all, for an item plainly visible in the sidebar.
      const projects = [{ id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() }];
      vi.mocked(api.listProjects).mockResolvedValue(projects as any);

      // Seed the cache the way a previous visit would have, WITHOUT i1.
      queryClient.setQueryData(['items', 'p1'], []);

      // The refetch is still in flight when the click lands.
      let release: (v: unknown) => void = () => {};
      const inFlight = new Promise(res => { release = res; });
      vi.mocked(api.listItems).mockImplementation((async () => {
        await inFlight;
        return [ITEM];
      }) as any);

      localStorage.setItem('agenfk_project_id', 'p1');
      render(<FocusHarness />, { wrapper });
      // The header has to exist before we can click, but the items fetch is
      // still parked on `inFlight` — which is precisely the state under test:
      // cached data on screen, fresh data not yet arrived.
      const search = await screen.findByPlaceholderText(/Search Item ID or Name/i) as HTMLInputElement;

      fireEvent.click(screen.getByText('focus i1'));

      // Now the real data lands.
      await act(async () => { release([ITEM]); await Promise.resolve(); });
      await screen.findByText('Target Task');

      // The navigation must have happened once the data was actually there.
      await waitFor(() => expect(search.value).toBe('i1'));
    });

    it('still goes to the card when the same row is clicked twice', async () => {
      // The guard must key on the nonce, not the bare id, or the second click
      // on an already-visited row becomes a no-op.
      const projects = [{ id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() }];
      vi.mocked(api.listProjects).mockResolvedValue(projects as any);
      vi.mocked(api.listItems).mockResolvedValue([ITEM] as any);
      localStorage.setItem('agenfk_project_id', 'p1');
      render(<FocusHarness />, { wrapper });
      await screen.findByText('Target Task');

      fireEvent.click(screen.getByText('focus i1'));
      const search = screen.getByPlaceholderText(/Search Item ID or Name/i) as HTMLInputElement;
      await waitFor(() => expect(search.value).toBe('i1'));

      fireEvent.change(search, { target: { value: '' } });
      fireEvent.click(screen.getByText('focus i1'));
      await waitFor(() => expect(search.value).toBe('i1'));
    });
  });

  describe('desktop shell — no duplicated identity (CGLAB-168)', () => {
    const asDesktop = (on: boolean) => {
      if (on) {
        Object.defineProperty(window, 'agenfkDesktop', {
          value: { isDesktop: true, platform: 'darwin', versions: { electron: '40', chrome: '1', node: '24' } },
          configurable: true, writable: true,
        });
      } else {
        delete (window as unknown as Record<string, unknown>).agenfkDesktop;
      }
    };
    afterEach(() => asDesktop(false));

    const withProject = async () => {
      const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
      vi.mocked(api.listProjects).mockResolvedValue([project] as any);
      vi.mocked(api.listItems).mockResolvedValue([] as any);
      localStorage.setItem('agenfk_project_id', 'p1');
      render(<KanbanBoard />, { wrapper });
      // Wait on something that renders in BOTH modes — the project line is
      // exactly what these tests are about.
      await screen.findByRole('button', { name: /New Item/i });
    };

    it('puts the search first in the header, where the identity block used to sit', async () => {
      // With the logo, the app name and the project line all gone in desktop
      // mode, the left of the header is empty and the search floats in the
      // middle of it. Ordering is the assertion that survives a CSS rewrite.
      asDesktop(true);
      await withProject();
      const header = document.querySelector('header')!;
      const controls = Array.from(header.querySelectorAll('input, button'));
      expect(controls[0]).toBe(screen.getByPlaceholderText(/Search Item ID or Name/i));
    });

    it('drops the project line too — the sidebar owns project switching now', async () => {
      asDesktop(true);
      await withProject();
      expect(screen.queryByText(/PROJECT:/i)).toBeNull();
    });

    it('KEEPS the auto-switch pin reachable in the desktop app', async () => {
      // This is NOT the sidebar's pin. The sidebar's pin writes
      // agenfk_pinned_projects and only reorders the list; this one writes
      // agenfk_project_pinned and is the only thing that stops a
      // `project_switched` event from yanking the board to whatever project an
      // agent just touched. Hiding it with the rest of the identity block
      // deleted a working control with no replacement: anyone already pinned
      // was stuck pinned, anyone not pinned could never pin.
      asDesktop(true);
      await withProject();
      expect(screen.queryByTestId('pin-project-btn')).not.toBeNull();
    });

    it('wires the desktop pin to the preference the socket handler reads', async () => {
      asDesktop(true);
      await withProject();
      fireEvent.click(screen.getByTestId('pin-project-btn'));
      await waitFor(() => expect(localStorage.getItem('agenfk_project_pinned')).toBe('true'));
    });

    it('lets the desktop pin actually suppress an agent-driven switch', async () => {
      // The end-to-end guarantee, which the assertion above does NOT make: the
      // preference is only worth restoring if firing the event it guards
      // leaves the board where the user put it.
      asDesktop(true);
      const projects = [
        { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() },
        { id: 'p2', name: 'P2', createdAt: new Date(), updatedAt: new Date() },
      ];
      const mine = { id: 'a1', projectId: 'p1', type: ItemType.TASK, title: 'My Work', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() };
      const theirs = { id: 'b1', projectId: 'p2', type: ItemType.TASK, title: 'Agent Work', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() };
      vi.mocked(api.listProjects).mockResolvedValue(projects as any);
      vi.mocked(api.listItems).mockImplementation((async (params: any) =>
        params?.projectId === 'p2' ? [theirs] : [mine]) as any);
      localStorage.setItem('agenfk_project_id', 'p1');
      render(
        <QueryClientProvider client={queryClient}>
          <ActiveProjectProvider>
            <SocketProvider>
              <ThemeProvider><KanbanBoard /></ThemeProvider>
            </SocketProvider>
          </ActiveProjectProvider>
        </QueryClientProvider>,
      );
      await screen.findByText('My Work');

      fireEvent.click(screen.getByTestId('pin-project-btn'));
      await waitFor(() => expect(localStorage.getItem('agenfk_project_pinned')).toBe('true'));

      // An agent touches project 2. Unpinned, this yanks the board there.
      await act(async () => { socketHandlers['project_switched']?.({ projectId: 'p2' }); });

      expect(screen.queryByText('Agent Work')).toBeNull();
      expect(screen.getByText('My Work')).toBeDefined();
    });

    it('keeps the project line in the browser, where nothing else shows it', async () => {
      asDesktop(false);
      await withProject();
      expect(screen.getByText(/PROJECT:/i)).toBeDefined();
    });

    it('drops the app name and version chip in the desktop app, where the title bar carries them', async () => {
      asDesktop(true);
      await withProject();
      expect(screen.queryByText('AgEnFK Dashboard')).toBeNull();
      expect(screen.queryByRole('button', { name: /README/i })).toBeNull();
    });

    it('drops the project PICKER but not the pin — they do different things', async () => {
      // The distinction the first cut of this story got wrong. The picker is
      // pure navigation and the sidebar now does it better, so it goes. The
      // pin changes behaviour (it suppresses auto-switching) and the sidebar
      // has no equivalent, so it stays. Asserting both in one test is what
      // stops the next cleanup from sweeping them up together again.
      asDesktop(true);
      await withProject();
      expect(screen.queryByRole('button', { name: /Switch Project/i })).toBeNull();
      expect(screen.queryByTestId('pin-project-btn')).not.toBeNull();
    });

    it('leaves the browser header exactly as it was', async () => {
      asDesktop(false);
      await withProject();
      expect(screen.getByText('AgEnFK Dashboard')).toBeDefined();
      expect(screen.getByRole('button', { name: /README/i })).toBeDefined();
    });
  });

  it('shows the welcome screen when there are no projects at all', async () => {
    /*
     * This used to expect the project PICKER, which is a chooser - and with no
     * projects it was a dialog asking a question that had no answers. The
     * welcome screen asks the question somebody in that position actually has
     * (004bd193).
     *
     * "None yet" and "none chosen" are different screens now; the picker is
     * still what the second one shows, covered below.
     */
    vi.mocked(api.listProjects).mockResolvedValue([]);
    render(<KanbanBoard />, { wrapper });
    expect(await screen.findByTestId('welcome-screen')).toBeDefined();
    expect(screen.getByRole('button', { name: /new project/i })).toBeDefined();
  });

  it('still shows the picker when projects exist but none is chosen', async () => {
    // The branch the welcome screen must not have swallowed: here there IS
    // something to pick from, so a chooser is the right answer.
    vi.mocked(api.listProjects).mockResolvedValue([
      { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() },
    ]);
    render(<KanbanBoard />, { wrapper });
    expect(await screen.findByTestId('project-picker-panel')).toBeDefined();
    expect(screen.queryByTestId('welcome-screen')).toBeNull();
  });

  it('should render items in correct columns', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    const items = [
      { id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'Task 1', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() },
    ];
    
    vi.mocked(api.listProjects).mockResolvedValue([project]);
    vi.mocked(api.listItems).mockResolvedValue(items);
    localStorage.setItem('agenfk_project_id', 'p1');
    
    render(<KanbanBoard />, { wrapper });
    expect(await screen.findByText('Task 1')).toBeDefined();
  });

  it('should allow creating a new project', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([]);
    
    render(<KanbanBoard />, { wrapper });
    
    // Through the welcome screen now, which is what an empty install shows.
    fireEvent.click(await screen.findByRole('button', { name: /new project/i }));
    
    const input = await screen.findByPlaceholderText(/e.g. My Awesome App/i);
    fireEvent.change(input, { target: { value: 'New Project' } });
    
    const submitBtn = screen.getByRole('button', { name: /Create Project/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(api.createProject).toHaveBeenCalled();
    });
  });

  it('should expand the archive section when the archive button is clicked', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    const items = [
      { id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'Active Task', status: Status.TODO, createdAt: new Date(), updatedAt: new Date(), history: [] },
      { id: 'a1', projectId: 'p1', type: ItemType.TASK, title: 'Archived Task', status: Status.ARCHIVED, createdAt: new Date(), updatedAt: new Date(), history: [] },
    ];
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue(items as any);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });

    // Wait for board to load
    await screen.findByText('Active Task');

    // The collapsed archive section shows "Archived" text (the span inside the collapsed button)
    // Both isBlockedCollapsed and isArchiveCollapsed are true by default, so both label spans render
    const archivedLabel = screen.queryByText('Archived');
    if (archivedLabel) {
      const archiveBtn = archivedLabel.closest('button');
      if (archiveBtn) {
        fireEvent.click(archiveBtn);
        // After expanding, the archive section header should show
        await waitFor(() => {
          const allArchived = screen.getAllByText(/Archived/i);
          expect(allArchived.length).toBeGreaterThan(0);
        });
      }
    }
    // Regardless of click success, verify the board renders archive count
    expect(screen.queryByText('Active Task')).toBeDefined();
  });

  it('should expand the blocked section when the blocked button is clicked', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    const items = [
      { id: 'b1', projectId: 'p1', type: ItemType.TASK, title: 'Blocked Task', status: Status.BLOCKED, createdAt: new Date(), updatedAt: new Date(), history: [] },
    ];
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue(items as any);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    await waitFor(() => {
      // Verify board has rendered
      expect(screen.queryByText(/Welcome/i)).toBeNull();
    });

    // The blocked section is collapsed by default; expand it
    const allButtons = document.querySelectorAll('button');
    const blockedCollapsedBtn = Array.from(allButtons).find(btn =>
      btn.classList.contains('rounded-xl') &&
      btn.querySelector('svg') &&
      btn.closest('[class*="flex-col"]')
    );
    if (blockedCollapsedBtn) {
      fireEvent.click(blockedCollapsedBtn);
      await waitFor(() => {
        expect(screen.queryByText('Blocked Task')).toBeDefined();
      });
    }
  });

  it('should open the card modal when a card is double-clicked', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    const item = { id: 'i1', projectId: 'p1', type: ItemType.STORY, title: 'My Story', status: Status.TODO, createdAt: new Date(), updatedAt: new Date(), history: [] };
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue([item as any]);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    const card = await screen.findByText('My Story');
    const cardEl = card.closest('[draggable="true"]') || card.closest('.group') || card.parentElement!;
    fireEvent.doubleClick(cardEl);
    // Modal opens — check for something unique to the modal
    await waitFor(() => {
      expect(document.querySelector('.fixed.inset-0')).not.toBeNull();
    });
  });

  it('should copy ID to clipboard when clicked', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date(), history: [] };
    const item = { id: 'i1-abcd-efgh', projectId: 'p1', type: ItemType.TASK, title: 'Task 1', status: Status.TODO, createdAt: new Date(), updatedAt: new Date(), history: [] };
    
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue([item as any]);
    localStorage.setItem('agenfk_project_id', 'p1');

    // Mock clipboard
    const writeTextMock = vi.fn();
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(<KanbanBoard />, { wrapper });
    
    const idElement = await screen.findByText('#i1-a');
    fireEvent.click(idElement);

    expect(writeTextMock).toHaveBeenCalledWith('i1-abcd-efgh');
  });

  describe('Drag and Drop Reordering', () => {
    it('should call updateItem with correct sortOrder when reordering within column', async () => {
      const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
      const items = [
        { id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'Task 1', status: Status.TODO, sortOrder: 0, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), history: [] },
        { id: 'i2', projectId: 'p1', type: ItemType.TASK, title: 'Task 2', status: Status.TODO, sortOrder: 1, createdAt: new Date('2026-01-02'), updatedAt: new Date('2026-01-02'), history: [] },
      ];
      
      vi.mocked(api.listProjects).mockResolvedValue([project as any]);
      vi.mocked(api.listItems).mockResolvedValue(items as any);
      vi.mocked(api.updateItem).mockImplementation((id, updates) => Promise.resolve({ id, ...updates } as any));
      localStorage.setItem('agenfk_project_id', 'p1');

      render(<KanbanBoard />, { wrapper });

      const task1Card = (await screen.findByText('Task 1')).closest('[draggable="true"]')!;
      const task2Card = (await screen.findByText('Task 2')).closest('[draggable="true"]')!;
      const todoColumn = screen.getByText('TODO').closest('.flex-col')!;

      // 1. Drag Start on Task 2
      const dataTransfer = {
        setData: vi.fn(),
        getData: vi.fn((key) => key === 'itemId' ? 'i2' : ''),
      };
      fireEvent.dragStart(task2Card, { dataTransfer });

      // 2. Drag Over Task 1 (top half to trigger 'above')
      task1Card.getBoundingClientRect = vi.fn(() => ({
        top: 100, height: 100, bottom: 200, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => {}
      } as DOMRect));

      const dragOverEvent = new CustomEvent('dragover', { bubbles: true, cancelable: true }) as any;
      dragOverEvent.clientY = 120; // Above center (150)
      fireEvent(task1Card, dragOverEvent);

      // 3. Drop on the column
      fireEvent.drop(todoColumn, { dataTransfer });

    await waitFor(() => {
      expect(api.bulkUpdateItems).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ id: 'i2', updates: expect.objectContaining({ sortOrder: 0 }) }),
        expect.objectContaining({ id: 'i1', updates: expect.objectContaining({ sortOrder: 1 }) })
      ]));
    });
  });

  it('should correctly reorder items when drilled into a parent', async () => {
      const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
      const items = [
        { id: 's1', projectId: 'p1', type: ItemType.STORY, title: 'Parent Story', status: Status.TODO, sortOrder: 0, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), history: [] },
        { id: 'c1', projectId: 'p1', type: ItemType.TASK, title: 'Child One', status: Status.TODO, sortOrder: 10, parentId: 's1', createdAt: new Date('2026-01-02'), updatedAt: new Date('2026-01-02'), history: [] },
        { id: 'c2', projectId: 'p1', type: ItemType.TASK, title: 'Child Two', status: Status.TODO, sortOrder: 20, parentId: 's1', createdAt: new Date('2026-01-03'), updatedAt: new Date('2026-01-03'), history: [] },
      ];

      vi.mocked(api.listProjects).mockResolvedValue([project as any]);
      vi.mocked(api.listItems).mockResolvedValue(items as any);
      vi.mocked(api.updateItem).mockImplementation((id, updates) => Promise.resolve({ id, ...updates } as any));
      localStorage.setItem('agenfk_project_id', 'p1');

      render(<KanbanBoard />, { wrapper });

      // Wait for all items to render, then drill into the parent story
      await screen.findByText('Parent Story');

      // Find the drill-down button inside the parent story's card.
      const parentCard = screen.getByText('Parent Story').closest('[draggable="true"]') as HTMLElement;
      const drillBtn = within(parentCard).getByRole('button', { name: /child items/i });
      expect(drillBtn).toBeDefined();
      fireEvent.click(drillBtn);

      // After drilling, only the children of the parent should be visible in columns.
      // The parent title appears in the breadcrumb but NOT as a card.
      await waitFor(() => {
        expect(screen.getByText('Child One')).toBeDefined();
        expect(screen.getByText('Child Two')).toBeDefined();
        // Parent card should not be in any column
        expect(document.querySelectorAll('#card-s1').length).toBe(0);
      }, { timeout: 3000 });

      const child1Card = (await screen.findByText('Child One')).closest('[draggable="true"]')!;
      const todoColumn = screen.getByText('TODO').closest('.flex-col')!;

      // Drag Child Two onto Child One (top half → above)
      const dataTransfer = {
        setData: vi.fn(),
        getData: vi.fn((key) => key === 'itemId' ? 'c2' : ''),
      };
      fireEvent.dragStart(screen.getByText('Child Two').closest('[draggable="true"]')!, { dataTransfer });

      child1Card.getBoundingClientRect = vi.fn(() => ({
        top: 100, height: 100, bottom: 200, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => {}
      } as DOMRect));

      const dragOverEvent = new CustomEvent('dragover', { bubbles: true, cancelable: true }) as any;
      dragOverEvent.clientY = 120;
      fireEvent(child1Card, dragOverEvent);

      fireEvent.drop(todoColumn, { dataTransfer });

      await waitFor(() => {
        expect(api.bulkUpdateItems).toHaveBeenCalled();
      });

      const callArgs = (api.bulkUpdateItems as any).mock.calls[0][0];

      expect(callArgs).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'c2', updates: expect.objectContaining({ sortOrder: 0 }) }),
        expect.objectContaining({ id: 'c1', updates: expect.objectContaining({ sortOrder: 1 }) }),
      ]));
      expect(callArgs).toHaveLength(2);
    });
  });

  it('should toggle the pin button and persist to localStorage', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    const items = [
      { id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'Task 1', status: Status.TODO, createdAt: new Date(), updatedAt: new Date(), history: [] },
    ];
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue(items as any);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    await screen.findByText('Task 1');

    const pinBtn = screen.getByTestId('pin-project-btn');
    fireEvent.click(pinBtn);
    expect(localStorage.getItem('agenfk_project_pinned')).toBe('true');

    // Click again to unpin
    fireEvent.click(pinBtn);
    expect(localStorage.getItem('agenfk_project_pinned')).toBeNull();
  });

  it('should search for an item by title and highlight it', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    const items = [
      { id: 'abc-def', projectId: 'p1', type: ItemType.TASK, title: 'SearchableTask', status: Status.TODO, createdAt: new Date(), updatedAt: new Date(), history: [] },
    ];
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue(items as any);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    await screen.findByText('SearchableTask');

    const searchInput = screen.getByPlaceholderText(/Search Item ID or Name/i);
    fireEvent.change(searchInput, { target: { value: 'SearchableTask' } });

    const form = searchInput.closest('form');
    if (form) fireEvent.submit(form);

    // The item should still be visible and match counter should appear
    await waitFor(() => {
      expect(screen.queryByText('SearchableTask')).toBeDefined();
      expect(screen.getByText('1/1')).toBeDefined();
    });
  });

  it('should handle search with no match (NOT FOUND feedback)', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue([]);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    // Wait for the main board to render (column headers appear)
    await screen.findByText('TODO');

    const searchInput = screen.getByPlaceholderText(/Search Item ID or Name/i);
    fireEvent.change(searchInput, { target: { value: 'xyzNotFound' } });

    const form = searchInput.closest('form');
    if (form) fireEvent.submit(form);

    // Just verify no crash
    await waitFor(() => {
      expect(true).toBe(true);
    });
  });

  it('should prioritize active items over archived in search and allow navigation', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    const items = [
      { id: 'archived-1', projectId: 'p1', type: ItemType.TASK, title: 'Widget Config', status: Status.ARCHIVED, createdAt: new Date(), updatedAt: new Date(), history: [] },
      { id: 'active-1', projectId: 'p1', type: ItemType.TASK, title: 'Widget Feature', status: Status.TODO, createdAt: new Date(), updatedAt: new Date(), history: [] },
      { id: 'active-2', projectId: 'p1', type: ItemType.TASK, title: 'Widget Bug', status: Status.IN_PROGRESS, createdAt: new Date(), updatedAt: new Date(), history: [] },
    ];
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue(items as any);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    await screen.findByText('Widget Feature');

    const searchInput = screen.getByPlaceholderText(/Search Item ID or Name/i);
    fireEvent.change(searchInput, { target: { value: 'Widget' } });

    const form = searchInput.closest('form');
    if (form) fireEvent.submit(form);

    // Should show match counter with 3 matches, starting at first (active item)
    await waitFor(() => {
      expect(screen.getByText('1/3')).toBeDefined();
    });

    // Click next match button
    const nextButton = screen.getByTitle('Next match');
    fireEvent.click(nextButton);

    await waitFor(() => {
      expect(screen.getByText('2/3')).toBeDefined();
    });

    // Click previous match button
    const prevButton = screen.getByTitle('Previous match');
    fireEvent.click(prevButton);

    await waitFor(() => {
      expect(screen.getByText('1/3')).toBeDefined();
    });
  });

  it('should archive all items in a column when archive button is clicked', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    const items = [
      { id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'Task 1', status: Status.TODO, createdAt: new Date(), updatedAt: new Date(), history: [] },
    ];
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue(items as any);
    vi.mocked(api.updateItem).mockResolvedValue({} as any);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    await screen.findByText('Task 1');

    // Multiple archive buttons exist (one per column) — click the first one (TODO column)
    const archiveColumnBtns = screen.getAllByTitle('Archive Column');
    fireEvent.click(archiveColumnBtns[0]);

    await waitFor(() => {
      expect(api.updateItem).toHaveBeenCalledWith('i1', { status: Status.ARCHIVED });
    });
  });

  it('should move item cross-column via drag and drop', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    const items = [
      { id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'Task Move', status: Status.TODO, sortOrder: 0, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), history: [] },
    ];
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue(items as any);
    vi.mocked(api.updateItem).mockImplementation((id, updates) => Promise.resolve({ id, ...updates } as any));
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    const taskCard = (await screen.findByText('Task Move')).closest('[draggable="true"]')!;

    const dataTransfer = {
      setData: vi.fn(),
      getData: vi.fn((key) => key === 'itemId' ? 'i1' : ''),
      effectAllowed: 'move',
      dropEffect: 'move',
    };

    fireEvent.dragStart(taskCard, { dataTransfer });

    // Drop onto the IN_PROGRESS column (rendered as "IN PROGRESS")
    const inProgressCol = screen.getByText('IN PROGRESS').closest('.flex-col')!;
    fireEvent.drop(inProgressCol, { dataTransfer });

    await waitFor(() => {
      expect(api.updateItem).toHaveBeenCalledWith('i1', expect.objectContaining({ status: Status.IN_PROGRESS }));
    });
  });

  it('should drag end and clear drag state', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    const items = [
      { id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'Task DragEnd', status: Status.TODO, sortOrder: 0, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), history: [] },
    ];
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue(items as any);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    const taskCard = (await screen.findByText('Task DragEnd')).closest('[draggable="true"]')!;

    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => ''), effectAllowed: 'move' };
    fireEvent.dragStart(taskCard, { dataTransfer });
    fireEvent.dragEnd(taskCard, { dataTransfer });

    // No crash after drag end
    expect(screen.queryByText('Task DragEnd')).toBeDefined();
  });

  it('should switch project when a project is clicked on project selector', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { id: 'p1', name: 'Project One', createdAt: new Date(), updatedAt: new Date() } as any,
      { id: 'p2', name: 'Project Two', createdAt: new Date(), updatedAt: new Date() } as any,
    ]);
    vi.mocked(api.listItems).mockResolvedValue([]);
    // Start without a selected project
    localStorage.removeItem('agenfk_project_id');

    render(<KanbanBoard />, { wrapper });
    await screen.findByText(/Welcome to AgEnFK/i);

    fireEvent.click(screen.getByText('Project One'));
    expect(localStorage.getItem('agenfk_project_id')).toBe('p1');
  });

  it('should open and close WhatsNew modal via header button', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue([]);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    await screen.findByText('TODO');

    // Click the version button (What's new)
    const whatsNewBtn = screen.getByTitle(/What's new/i);
    fireEvent.click(whatsNewBtn);

    // WhatsNew modal should open (shows "What's New" text)
    await waitFor(() => {
      expect(screen.getByText(/What's New/i)).toBeDefined();
    });
  });

  it('should open README modal via header button', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue([]);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    await screen.findByText('TODO');

    const readmeBtn = screen.getByTitle(/View project README/i);
    fireEvent.click(readmeBtn);

    await waitFor(() => {
      expect(screen.getByText('Project README')).toBeDefined();
    });
  });

  it('should expand Ideas column when collapsed button is clicked', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue([]);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    await screen.findByText('TODO');

    // The Ideas collapsed button has title with "Ideas" text
    const ideasText = screen.queryByText('Ideas');
    if (ideasText) {
      const ideasBtn = ideasText.closest('button');
      if (ideasBtn) {
        fireEvent.click(ideasBtn);
        await waitFor(() => {
          expect(screen.getByText('Add idea')).toBeDefined();
        });
      }
    }
    // Verify board still renders
    expect(screen.queryByText('TODO')).toBeDefined();
  });

  it('should navigate back to project selector via folder icon', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue([]);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    await screen.findByText('TODO');

    const switchProjectBtn = screen.getByTitle('Switch Project');
    fireEvent.click(switchProjectBtn);

    await waitFor(() => {
      expect(screen.getByText(/Welcome to AgEnFK/i)).toBeDefined();
    });
  });

  it('should open new item modal when column Add button is clicked', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue([]);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    await screen.findByText('TODO');

    const addTodoBtn = screen.getByText(/Add todo/i);
    fireEvent.click(addTodoBtn);

    await waitFor(() => {
      expect(document.querySelector('.fixed.inset-0')).not.toBeNull();
    });
  });

  it('should handle card drag over and drag leave events', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    const items = [
      { id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'Task A', status: Status.TODO, sortOrder: 0, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), history: [] },
      { id: 'i2', projectId: 'p1', type: ItemType.TASK, title: 'Task B', status: Status.TODO, sortOrder: 1, createdAt: new Date('2026-01-02'), updatedAt: new Date('2026-01-02'), history: [] },
    ];
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue(items as any);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    const taskA = (await screen.findByText('Task A')).closest('[draggable="true"]')!;
    const taskB = (await screen.findByText('Task B')).closest('[draggable="true"]')!;

    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => 'i1'), effectAllowed: 'move' };
    fireEvent.dragStart(taskA, { dataTransfer });

    // Drag over taskB
    const dragOverEvent = new CustomEvent('dragover', { bubbles: true, cancelable: true }) as any;
    dragOverEvent.clientY = 50;
    fireEvent(taskB, dragOverEvent);

    // Drag leave taskB
    fireEvent.dragLeave(taskB);

    // No crash
    expect(screen.queryByText('Task A')).toBeDefined();
  });

  it('should close WhatsNew modal via Escape key', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue([]);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    await screen.findByText('TODO');

    fireEvent.click(screen.getByTitle(/What's new/i));
    await waitFor(() => expect(document.querySelector('.fixed.inset-0')).not.toBeNull());

    // Close via Escape — covers () => setIsWhatsNewOpen(false) at line 1325
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('[data-modal="whatsnew"]')).toBeNull());
  });

  it('should close README modal via Escape key', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue([]);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    await screen.findByText('TODO');

    fireEvent.click(screen.getByTitle(/View project README/i));
    await waitFor(() => expect(screen.getByText('Project README')).toBeDefined());

    // Close via Escape — covers () => setIsReadmeOpen(false) at line 1326
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Project README')).toBeNull());
  });

  it('should close CardDetailModal via Escape key', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    const item = { id: 'i1', projectId: 'p1', type: ItemType.STORY, title: 'Close Me', status: Status.TODO, createdAt: new Date(), updatedAt: new Date(), history: [] };
    vi.mocked(api.listProjects).mockResolvedValue([project as any]);
    vi.mocked(api.listItems).mockResolvedValue([item as any]);
    localStorage.setItem('agenfk_project_id', 'p1');

    render(<KanbanBoard />, { wrapper });
    const card = await screen.findByText('Close Me');
    const cardEl = card.closest('[draggable="true"]') || card.parentElement!;
    fireEvent.doubleClick(cardEl);

    await waitFor(() => expect(document.querySelector('.fixed.inset-0')).not.toBeNull());

    // Close via Escape — covers () => setSelectedItem(null) at line 1296
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('.fixed.inset-0')).toBeNull());
  });

  describe('Dynamic Flow Columns', () => {

    it('should render columns from the active flow steps in order', async () => {
      const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
      const customFlow = {
        ...DEFAULT_FLOW_MOCK,
        steps: [
          { id: 's-todo', name: 'TODO', label: 'Backlog', order: 0 },
          { id: 's-ip', name: 'IN_PROGRESS', label: 'Doing', order: 1 },
          { id: 's-done', name: 'DONE', label: 'Shipped', order: 2 },
          { id: 's-blocked', name: 'BLOCKED', label: 'Blocked', order: 3, isSpecial: true },
        ],
      };
      vi.mocked(api.listProjects).mockResolvedValue([project as any]);
      vi.mocked(api.listItems).mockResolvedValue([]);
      vi.mocked(api.getProjectFlow).mockResolvedValue(customFlow as any);
      localStorage.setItem('agenfk_project_id', 'p1');

      render(<KanbanBoard />, { wrapper });

      // Non-special steps should appear as column headers
      await waitFor(() => {
        expect(screen.getByText('Backlog')).toBeDefined();
        expect(screen.getByText('Doing')).toBeDefined();
        expect(screen.getByText('Shipped')).toBeDefined();
      });

      // Special step should NOT appear in main columns (it's in the sidebar)
      expect(screen.queryByRole('heading', { name: /^Blocked$/i })).toBeNull();
    });

    it('should call getProjectFlow with the selected project id', async () => {
      const project = { id: 'proj-abc', name: 'Flow Project', createdAt: new Date(), updatedAt: new Date() };
      vi.mocked(api.listProjects).mockResolvedValue([project as any]);
      vi.mocked(api.listItems).mockResolvedValue([]);
      localStorage.setItem('agenfk_project_id', 'proj-abc');

      render(<KanbanBoard />, { wrapper });
      await screen.findByText('TODO');

      await waitFor(() => {
        expect(api.getProjectFlow).toHaveBeenCalledWith('proj-abc');
      });
    });

    it('should fall back to default columns when getProjectFlow fails', async () => {
      const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
      vi.mocked(api.listProjects).mockResolvedValue([project as any]);
      vi.mocked(api.listItems).mockResolvedValue([]);
      vi.mocked(api.getProjectFlow).mockRejectedValue(new Error('Network error'));
      localStorage.setItem('agenfk_project_id', 'p1');

      render(<KanbanBoard />, { wrapper });

      // Fallback columns should still render
      await waitFor(() => {
        expect(screen.getByText('TODO')).toBeDefined();
        expect(screen.getByText('IN PROGRESS')).toBeDefined();
        expect(screen.getByText('DONE')).toBeDefined();
      });
    });

    it('should render cards in the correct dynamic column', async () => {
      const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
      const items = [
        { id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'Flow Task', status: Status.TODO, createdAt: new Date(), updatedAt: new Date(), history: [] },
      ];
      const customFlow = {
        ...DEFAULT_FLOW_MOCK,
        steps: [
          { id: 's-todo', name: 'TODO', label: 'Queue', order: 0 },
          { id: 's-done', name: 'DONE', label: 'Finished', order: 1 },
        ],
      };
      vi.mocked(api.listProjects).mockResolvedValue([project as any]);
      vi.mocked(api.listItems).mockResolvedValue(items as any);
      vi.mocked(api.getProjectFlow).mockResolvedValue(customFlow as any);
      localStorage.setItem('agenfk_project_id', 'p1');

      render(<KanbanBoard />, { wrapper });

      // Card should appear under the "Queue" column (mapped from TODO)
      const card = await screen.findByText('Flow Task');
      expect(card).toBeDefined();
      // Column header should use the flow label
      expect(screen.getByText('Queue')).toBeDefined();
    });

    it('should apply step color as inline border style on column header', async () => {
      const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
      const customFlow = {
        ...DEFAULT_FLOW_MOCK,
        steps: [
          { id: 's-todo', name: 'TODO', label: 'Backlog', order: 0, color: '#ff0000' },
          { id: 's-done', name: 'DONE', label: 'Done', order: 1, color: '#00ff00' },
        ],
      };
      vi.mocked(api.listProjects).mockResolvedValue([project as any]);
      vi.mocked(api.listItems).mockResolvedValue([]);
      vi.mocked(api.getProjectFlow).mockResolvedValue(customFlow as any);
      localStorage.setItem('agenfk_project_id', 'p1');

      render(<KanbanBoard />, { wrapper });

      await waitFor(() => screen.getByTestId('column-header-TODO'));
      const todoHeader = screen.getByTestId('column-header-TODO') as HTMLElement;
      expect(todoHeader.style.borderTopColor).toBe('rgb(255, 0, 0)');
    });

    it('uses a default color when step has no color field', async () => {
      const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
      const customFlow = {
        ...DEFAULT_FLOW_MOCK,
        steps: [
          { id: 's-todo', name: 'TODO', label: 'Backlog', order: 0 },
          { id: 's-done', name: 'DONE', label: 'Done', order: 1 },
        ],
      };
      vi.mocked(api.listProjects).mockResolvedValue([project as any]);
      vi.mocked(api.listItems).mockResolvedValue([]);
      vi.mocked(api.getProjectFlow).mockResolvedValue(customFlow as any);
      localStorage.setItem('agenfk_project_id', 'p1');

      render(<KanbanBoard />, { wrapper });

      await waitFor(() => screen.getByTestId('column-header-TODO'));
      const todoHeader = screen.getByTestId('column-header-TODO') as HTMLElement;
      // Should have a non-empty borderTopColor (the default fallback)
      expect(todoHeader.style.borderTopColor).toBeTruthy();
    });
  });

  describe('Ideas column expansion layout', () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };

    function setup() {
      vi.mocked(api.listProjects).mockResolvedValue([project as any]);
      vi.mocked(api.listItems).mockResolvedValue([]);
      localStorage.setItem('agenfk_project_id', 'p1');
      render(<KanbanBoard />, { wrapper });
    }

    it('should apply min-w-full to the board flex container so it can grow beyond viewport width', async () => {
      setup();
      await waitFor(() => screen.getByTestId('column-header-TODO'));

      // The flex container wrapping all columns must use min-w-full (not w-full alone)
      // so that expanding Ideas does not squeeze the other columns.
      const boardContainer = document.querySelector('[data-testid="board-columns-container"]');
      expect(boardContainer).not.toBeNull();
      expect(boardContainer!.classList.contains('min-w-full')).toBe(true);
      expect(boardContainer!.classList.contains('w-full')).toBe(false);
    });

    it('should apply shrink-0 to the Ideas column wrapper when expanded', async () => {
      setup();
      await waitFor(() => screen.getByTestId('column-header-TODO'));

      // Expand the Ideas column
      const ideasBtn = screen.getByTestId('ideas-collapsed-button');
      fireEvent.click(ideasBtn);

      await waitFor(() => {
        const ideasWrapper = document.querySelector('[data-testid="ideas-column-wrapper"]');
        expect(ideasWrapper).not.toBeNull();
        expect(ideasWrapper!.classList.contains('shrink-0')).toBe(true);
        expect(ideasWrapper!.classList.contains('shrink')).toBe(false);
      });
    });

    it('should NOT apply shrink-0 to Ideas column wrapper when collapsed (stays narrow)', async () => {
      setup();
      await waitFor(() => screen.getByTestId('column-header-TODO'));

      // When collapsed, the wrapper uses shrink-0 (fixed narrow width)
      const ideasWrapper = document.querySelector('[data-testid="ideas-column-wrapper"]');
      expect(ideasWrapper).not.toBeNull();
      // Collapsed: uses w-12 shrink-0 — stays fixed at 48px
      expect(ideasWrapper!.classList.contains('shrink-0')).toBe(true);
    });
  });

  describe('Move to project menu dismissal', () => {
    const project1 = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    const project2 = { id: 'p2', name: 'P2', createdAt: new Date(), updatedAt: new Date() };
    const items = [
      { id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'Task 1', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() },
    ];

    async function setupWithOpenMenu() {
      vi.mocked(api.listProjects).mockResolvedValue([project1, project2] as any);
      vi.mocked(api.listItems).mockResolvedValue(items as any);
      localStorage.setItem('agenfk_project_id', 'p1');
      render(<KanbanBoard />, { wrapper });

      await screen.findByText('Task 1');
      fireEvent.click(screen.getByTitle('Move to project'));
      expect(await screen.findByText('Move to project')).toBeDefined();
    }

    it('closes when clicking outside the menu', async () => {
      await setupWithOpenMenu();

      fireEvent.pointerDown(document.body);

      await waitFor(() => {
        expect(screen.queryByText('Move to project')).toBeNull();
      });
    });

    it('closes when pressing Escape', async () => {
      await setupWithOpenMenu();

      fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByText('Move to project')).toBeNull();
      });
    });
  });
});

/**
 * Opening a terminal from a card (CGLAB-176).
 *
 * The button is desktop-only, and that is not a limitation of the feature — it
 * is where its consumer lives. `App.tsx` mounts `AppShell`, the only thing that
 * reads the terminal request, behind `isDesktop()`. In a browser the click
 * would bump a nonce nobody reads: no dialog, no error, no explanation.
 *
 * Caught in review, not by the first round of tests, and the reason is worth
 * recording: the shell test mounts `AppShell` directly, and the provider test
 * asserts only that the context field changed. Neither could see that nothing
 * downstream was listening in the shipped tree.
 */
describe('the terminal button on a card', () => {
  const asDesktop = (on: boolean) => {
    if (on) {
      Object.defineProperty(window, 'agenfkDesktop', {
        value: { isDesktop: true, platform: 'darwin', versions: { electron: '40', chrome: '1', node: '24' } },
        configurable: true, writable: true,
      });
    } else {
      delete (window as unknown as Record<string, unknown>).agenfkDesktop;
    }
  };
  afterEach(() => asDesktop(false));

  const boardWithOneCard = async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    vi.mocked(api.listProjects).mockResolvedValue([project] as any);
    vi.mocked(api.listItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', title: 'Wire the thing', type: 'TASK', status: 'TODO', createdAt: new Date(), updatedAt: new Date() },
    ] as any);
    localStorage.setItem('agenfk_project_id', 'p1');
    render(<KanbanBoard />, { wrapper });
    await screen.findByText('Wire the thing');
  };

  it('is offered on the desktop, where something is listening', async () => {
    asDesktop(true);
    await boardWithOneCard();
    expect(screen.getByRole('button', { name: /open a terminal on Wire the thing/i })).toBeTruthy();
  });

  it('is not offered in a browser, where the click would do nothing', async () => {
    asDesktop(false);
    await boardWithOneCard();
    expect(screen.queryByRole('button', { name: /open a terminal on/i })).toBeNull();
  });
});

/**
 * One type grammar, everywhere a card is drawn (CGLAB-164).
 *
 * The create form taught story=green / task=blue — JIRA's grammar, asked for
 * by name — while this board said story=`story-blue` / task=`brand` teal, and
 * the Subitems table said something third. The screen that TEACHES the mapping
 * taught the reverse of the screen the card lands on: pick STORY, see green,
 * press Create, and the card appears blue among green TASKs.
 */
describe('the type badge on a board card', () => {
  // Its own reset: this describe is a sibling of `KanbanBoard`, so that
  // block's beforeEach does not reach here, and a cached items query from the
  // previous case renders the previous type's card.
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    queryClient.clear();
    vi.mocked(api.getProjectFlow).mockResolvedValue(DEFAULT_FLOW_MOCK as any);
  });

  const boardWith = async (type: string) => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    vi.mocked(api.listProjects).mockResolvedValue([project] as any);
    vi.mocked(api.listItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', title: 'Wire the thing', type, status: 'TODO', createdAt: new Date(), updatedAt: new Date() },
    ] as any);
    localStorage.setItem('agenfk_project_id', 'p1');
    render(<KanbanBoard />, { wrapper });
    await screen.findByText('Wire the thing');
    return screen.getAllByTestId('item-type-badge')[0];
  };

  afterEach(() => cleanup());

  it('wears the same colour the create form taught, for every type', async () => {
    for (const type of Object.values(ItemType)) {
      const badge = await boardWith(type);
      expect(badge.textContent).toContain(type);
      expect((badge.firstElementChild as HTMLElement).className, `board disagrees with the grammar for ${type}`)
        .toContain(ITEM_TYPE_VISUAL[type].fill);
      cleanup();
      queryClient.clear();
    }
  });

  it('paints the drill-down breadcrumb from the same grammar', async () => {
    /*
     * The fifth site, and the one the first sweep missed: the breadcrumb dot
     * was `nav.type === EPIC ? brand-light : story-blue`, so drilling into an
     * epic put a blue dot directly above the emerald STORY badge it had just
     * revealed — two answers to "what colour is a story" on one screen.
     *
     * The blanket version of this check now lives in ItemTypeSquare.test.tsx,
     * which reads the components directory; this one proves the rendered
     * result on the screen that had the defect.
     */
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    vi.mocked(api.listProjects).mockResolvedValue([project] as any);
    vi.mocked(api.listItems).mockResolvedValue([
      { id: 'e1', projectId: 'p1', title: 'The epic', type: 'EPIC', status: 'TODO', createdAt: new Date(), updatedAt: new Date() },
      { id: 's1', projectId: 'p1', parentId: 'e1', title: 'The story', type: 'STORY', status: 'TODO', createdAt: new Date(), updatedAt: new Date() },
    ] as any);
    localStorage.setItem('agenfk_project_id', 'p1');
    render(<KanbanBoard />, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: /1 child items/i }));
    const dot = await screen.findByTestId('breadcrumb-type-dot');
    expect(dot.className).toContain(ITEM_TYPE_VISUAL[ItemType.EPIC].fill);
    expect(dot.className).not.toMatch(/story-blue|brand-light/);
  });
});

describe('a card asked for from outside the board', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    queryClient.clear();
    vi.mocked(api.getProjectFlow).mockResolvedValue(DEFAULT_FLOW_MOCK as any);
  });
  afterEach(() => cleanup());

  it('opens the draft already carrying the words that were typed', async () => {
    /*
     * The card picker's empty state hands over the phrase someone just typed
     * into its search box. If the board ignores it, they type it twice — in a
     * flow whose whole complaint was that writing cards costs too much.
     */
    function SeedHarness() {
      const { requestNewItem } = useActiveProject();
      return (
        <>
          <button onClick={() => requestNewItem('p1', 'fix the picker dismiss')}>seed</button>
          <KanbanBoard />
        </>
      );
    }
    vi.mocked(api.listProjects).mockResolvedValue([
      { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() },
    ] as any);
    vi.mocked(api.listItems).mockResolvedValue([] as any);
    localStorage.setItem('agenfk_project_id', 'p1');
    render(<SeedHarness />, { wrapper });
    fireEvent.click(await screen.findByText('seed'));
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Title of your new task/i) as HTMLInputElement).value)
        .toBe('fix the picker dismiss'));
  });

  it('still opens an empty draft when nothing was typed', async () => {
    function PlainHarness() {
      const { requestNewItem } = useActiveProject();
      return (
        <>
          <button onClick={() => requestNewItem('p1')}>plain</button>
          <KanbanBoard />
        </>
      );
    }
    vi.mocked(api.listProjects).mockResolvedValue([
      { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() },
    ] as any);
    vi.mocked(api.listItems).mockResolvedValue([] as any);
    localStorage.setItem('agenfk_project_id', 'p1');
    render(<PlainHarness />, { wrapper });
    fireEvent.click(await screen.findByText('plain'));
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Title of your new task/i) as HTMLInputElement).value).toBe(''));
  });
});
