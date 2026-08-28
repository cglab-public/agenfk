/**
 * @vitest-environment jsdom
 *
 * Dashboard deep-linking (CGLAB-100): `agenfk ui --open <itemId>` opens the
 * web UI at `/?item=<id>[&project=<projectId>]`. On load the KanbanBoard must
 * behave EXACTLY like the id had been typed into the Search Box:
 *  - `?project` selects (and persists) that project, like the project picker;
 *  - `?item` pre-fills the search box with the id and runs the search:
 *    drill down through the parent chain, highlight the card, scroll it into
 *    view, show the match counter;
 *  - an id that matches nothing flashes "NOT FOUND" in the search box, the
 *    same feedback a manual search gives;
 *  - with no `?item` param the board loads exactly as before (empty search).
 */
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { KanbanBoard } from '../components/KanbanBoard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { ItemType, Status } from '../types';

// Mock socket.io-client
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
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

// Mock scrollIntoView (jsdom has no layout)
window.HTMLElement.prototype.scrollIntoView = vi.fn();

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
    <ThemeProvider>
      {children}
    </ThemeProvider>
  </QueryClientProvider>
);

const NOW = new Date();
const projectP1 = { id: 'p1', name: 'P1', createdAt: NOW, updatedAt: NOW };
const projectP2 = { id: 'p2', name: 'P2', createdAt: NOW, updatedAt: NOW };

const EPIC_ONE = {
  id: 'epic-1', projectId: 'p2', type: ItemType.EPIC, title: 'Epic One',
  status: Status.TODO, createdAt: NOW, updatedAt: NOW,
};
const TASK_ONE = {
  id: 'task-1', projectId: 'p2', type: ItemType.TASK, title: 'Task One',
  status: Status.TODO, createdAt: NOW, updatedAt: NOW,
};
const TASK_CHILD = {
  id: 'task-2', projectId: 'p2', type: ItemType.TASK, title: 'Task Child',
  status: Status.TODO, parentId: 'epic-1', createdAt: NOW, updatedAt: NOW,
};

const SEARCH_PLACEHOLDER = 'Search Item ID or Name...';

// findByPlaceholderText is typed as HTMLElement; the element is the search input.
async function searchInput() {
  return (await screen.findByPlaceholderText(SEARCH_PLACEHOLDER)) as HTMLInputElement;
}

describe('KanbanBoard deep-link (?item / ?project)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    queryClient.clear();
    window.history.pushState({}, '', '/');
    vi.mocked(api.getProjectFlow).mockResolvedValue(DEFAULT_FLOW_MOCK as any);
    vi.mocked(api.listProjects).mockResolvedValue([projectP1, projectP2] as any);
    vi.mocked(api.listItems).mockImplementation((params: any) =>
      Promise.resolve(params?.projectId === 'p2' ? [EPIC_ONE, TASK_ONE, TASK_CHILD] : [])
    );
  });

  afterEach(() => {
    cleanup();
    window.history.pushState({}, '', '/');
  });

  it('opens the ?project project, pre-fills the search box and highlights the ?item card', async () => {
    // No localStorage: without ?project the board would sit on the project picker.
    window.history.pushState({}, '', '/?item=task-1&project=p2');
    render(<KanbanBoard />, { wrapper });

    const input = await searchInput();
    await waitFor(() => expect(input.value).toBe('task-1'));

    const card = document.getElementById('card-task-1');
    expect(card).not.toBeNull();
    expect(card!.className).toContain('search-highlight');
    // Match counter, same as a manual search with one hit.
    expect(screen.getByText('1/1')).toBeDefined();
  });

  it('persists the ?project param to localStorage, like the project picker does', async () => {
    window.history.pushState({}, '', '/?project=p2');
    render(<KanbanBoard />, { wrapper });

    await searchInput();
    await waitFor(() =>
      expect(localStorage.getItem('agenfk_project_id')).toBe('p2')
    );
  });

  it('lets ?project win over a different project already in localStorage', async () => {
    // A mutant that swaps the precedence (localStorage first) must not pass.
    localStorage.setItem('agenfk_project_id', 'p1');
    window.history.pushState({}, '', '/?project=p2');
    render(<KanbanBoard />, { wrapper });

    await searchInput();
    await waitFor(() =>
      expect(api.listItems).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p2' }))
    );
    expect(localStorage.getItem('agenfk_project_id')).toBe('p2');
  });

  it('strips the deep-link params from the URL once applied (reload honours the picker)', async () => {
    window.history.pushState({}, '', '/?item=task-1&project=p2');
    render(<KanbanBoard />, { wrapper });

    const input = await searchInput();
    await waitFor(() => expect(input.value).toBe('task-1'));
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('drills down through the parent chain for a nested item, like searching its id', async () => {
    window.history.pushState({}, '', '/?item=task-2&project=p2');
    render(<KanbanBoard />, { wrapper });

    const input = await searchInput();
    await waitFor(() => expect(input.value).toBe('task-2'));

    await waitFor(() => {
      const card = document.getElementById('card-task-2');
      expect(card).not.toBeNull();
      expect(card!.className).toContain('search-highlight');
    });
    // The parent EPIC appears in the breadcrumb (navPath), proving the drill-down.
    expect(screen.getAllByText('Epic One').length).toBeGreaterThan(0);
  });

  it('flashes NOT FOUND in the search box when the id matches nothing, like a manual search', async () => {
    window.history.pushState({}, '', '/?item=missing-999&project=p2');
    render(<KanbanBoard />, { wrapper });

    const input = await searchInput();
    await waitFor(() => expect(input.value).toBe('NOT FOUND'));
  });

  it('leaves the search box empty when no ?item param is present (baseline unchanged)', async () => {
    window.history.pushState({}, '', '/?project=p2');
    render(<KanbanBoard />, { wrapper });

    const input = await searchInput();
    expect(input.value).toBe('');
  });

  it('applies the deep-link only once: a later items refetch does not re-populate a cleared search', async () => {
    window.history.pushState({}, '', '/?item=task-1&project=p2');
    render(<KanbanBoard />, { wrapper });

    const input = await searchInput();
    await waitFor(() => expect(input.value).toBe('task-1'));

    // The user clears the search box (what clearSearch does on empty input).
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');

    // A socket-driven refetch re-creates the items array — the one-shot guard
    // must keep the deep-link from firing again.
    queryClient.invalidateQueries({ queryKey: ['items', 'p2'] });
    await new Promise((r) => setTimeout(r, 150));
    expect(input.value).toBe('');
    const card = document.getElementById('card-task-1');
    expect(card?.className ?? '').not.toContain('search-highlight');
  });
});
