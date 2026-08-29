/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { KanbanBoard } from '../components/KanbanBoard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { io } from 'socket.io-client';

// Mock socket.io-client
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

// Default flow used in tests
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
}

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

function makeProject(id: string, name: string) {
  return { id, name, createdAt: new Date(), updatedAt: new Date() };
}

describe('ProjectSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  function renderKanbanBoard() {
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
    render(<KanbanBoard />, { wrapper });
  }

  it('renders projects in alphabetical order (case-insensitive)', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      makeProject('z', 'Zebra'),
      makeProject('a', 'apple'),
      makeProject('m', 'Mango'),
    ]);

    renderKanbanBoard();

    // Wait for at least one project name to appear
    await waitFor(() => screen.getByText('apple'));

    const names = screen.getAllByText(/^(apple|Mango|Zebra)$/).map(n => n.textContent);
    expect(names).toEqual(['apple', 'Mango', 'Zebra']);
  });

  it('filters projects by search query', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      makeProject('z', 'Zebra'),
      makeProject('a', 'apple'),
      makeProject('m', 'Mango'),
    ]);

    renderKanbanBoard();

    // Wait for project list to render
    await waitFor(() => screen.getByText('Zebra'));

    // Find the search input for filtering projects
    const searchInput = screen.getByRole('textbox');

    // Type a filter query
    fireEvent.change(searchInput, { target: { value: 'man' } });

    // Mango should be visible; Zebra and apple should be hidden
    expect(screen.getByText('Mango')).toBeDefined();
    expect(screen.queryByText('Zebra')).toBeNull();
    expect(screen.queryByText('apple')).toBeNull();
  });

  it('project list is inside a scrollable container', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      makeProject('z', 'Zebra'),
      makeProject('a', 'apple'),
      makeProject('m', 'Mango'),
    ]);

    renderKanbanBoard();

    // Wait for projects to render
    await waitFor(() => screen.getByText('apple'));

    // Find a rendered project name element and walk up to find the
    // scrollable container wrapping the project list.
    const appleElement = screen.getByText('apple');
    let el: HTMLElement | null = appleElement;

    // Walk up the DOM tree looking for the scroll container
    while (el && el !== document.body) {
      const className = el.className;
      const style = el.style;

      if (
        typeof className === 'string' &&
        (className.includes('overflow-y-auto') || className.includes('overflow-y-scroll'))
      ) {
        break;
      }

      if (
        style.maxHeight && style.maxHeight !== '' &&
        (style.overflow === 'auto' || style.overflow === 'scroll' ||
         style.overflowY === 'auto' || style.overflowY === 'scroll')
      ) {
        break;
      }

      el = el.parentElement;
    }

    // We should have found a scrollable ancestor (not document.body)
    expect(el).not.toBeNull();
    expect(el).not.toBe(document.body);
  });

  it('shows an empty state when no projects match the search', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      makeProject('z', 'Zebra'),
      makeProject('a', 'apple'),
      makeProject('m', 'Mango'),
    ]);

    renderKanbanBoard();

    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByRole('textbox');
    fireEvent.change(searchInput, { target: { value: 'zzz' } });

    expect(screen.queryByText('Zebra')).toBeNull();
    expect(screen.queryByText('apple')).toBeNull();
    expect(screen.queryByText('Mango')).toBeNull();
    expect(screen.getByText(/no projects match/i)).toBeDefined();
  });

  // ---- CGLAB-115 (2): the whole chip must be clickable, not just its name ----
  // Each row is a padded container holding an inner button; only the icon +
  // name were the button, so the padding ring, the gutter and the trailing
  // dead strip swallowed clicks.

  function rowOf(name: string): HTMLElement {
    return screen.getByText(name).closest('[role="option"]') as HTMLElement;
  }

  async function renderThreeProjects() {
    vi.mocked(api.listProjects).mockResolvedValue([
      makeProject('z', 'Zebra'),
      makeProject('a', 'apple'),
      makeProject('m', 'Mango'),
    ]);
    renderKanbanBoard();
    await waitFor(() => screen.getByText('apple'));
  }

  it('clicking the row padding (not the name) selects the project', async () => {
    await renderThreeProjects();

    fireEvent.click(rowOf('Zebra'));

    expect(localStorage.getItem('agenfk_project_id')).toBe('z');
  });

  it('clicking the project icon selects the project', async () => {
    await renderThreeProjects();

    const row = rowOf('Mango');
    const icon = row.querySelector('svg');
    fireEvent.click(icon!);

    expect(localStorage.getItem('agenfk_project_id')).toBe('m');
  });

  it('the whole row is the click target, not an inner sub-region', async () => {
    await renderThreeProjects();

    // The name/icon are no longer wrapped in their own button — that inner
    // button is what left the row's padding dead. The only button left in the
    // row is the trash action.
    const row = rowOf('Zebra');
    const buttons = row.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute('aria-label')).toBe('Delete project Zebra');

    // And the whole row, not just the name, performs the selection.
    fireEvent.click(row);
    expect(localStorage.getItem('agenfk_project_id')).toBe('z');
  });

  it('a row whose delete confirmation is armed does not advertise itself as clickable', async () => {
    await renderThreeProjects();

    const row = rowOf('Zebra');
    expect(row.className).toContain('cursor-pointer');

    fireEvent.click(screen.getByLabelText('Delete project Zebra'));
    await screen.findByText(/Delete "Zebra"\?/i);

    // Same row element, now the destructive prompt. It must stop looking
    // clickable, or it advertises a click the guard deliberately ignores.
    const armed = rowOf('Delete "Zebra"?');
    expect(armed.className).not.toContain('cursor-pointer');
    expect(armed.className).not.toContain('hover:bg-chip');
  });

  it('the trash button arms the delete confirm and does NOT select the project', async () => {
    await renderThreeProjects();

    const trash = screen.getByLabelText('Delete project Zebra');
    fireEvent.click(trash);

    expect(await screen.findByText(/Delete "Zebra"\?/i)).toBeDefined();
    expect(localStorage.getItem('agenfk_project_id')).toBeNull();
    expect(api.deleteProject).not.toHaveBeenCalled();
  });

  it('clicking the row padding while a delete confirm is armed does not delete', async () => {
    await renderThreeProjects();

    fireEvent.click(screen.getByLabelText('Delete project Zebra'));
    await screen.findByText(/Delete "Zebra"\?/i);

    // The confirm replaces the row's contents; clicking its padding must not
    // select the project nor confirm the deletion.
    fireEvent.click(rowOf('Delete "Zebra"?'));

    expect(api.deleteProject).not.toHaveBeenCalled();
    expect(localStorage.getItem('agenfk_project_id')).toBeNull();
  });
});
