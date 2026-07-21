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

    // Collect all project name spans in DOM order
    const projectButtons = document.querySelectorAll(
      'button.flex.flex-1.items-center.gap-3.text-left'
    );
    const renderedNames = Array.from(projectButtons).map(
      btn => btn.querySelector('span.font-semibold')?.textContent ?? ''
    );

    expect(renderedNames).toEqual(['apple', 'Mango', 'Zebra']);
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
});