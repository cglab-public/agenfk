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

/** Walk up from a project-name text element to the row div carrying aria-selected. */
function getProjectRow(name: string): HTMLElement | null {
  const textEl = screen.getByText(name);
  return (textEl as HTMLElement).closest('[aria-selected]') as HTMLElement | null;
}

/** Return the element whose aria-selected is "true", or null. */
function getHighlightedRow(): HTMLElement | null {
  return document.querySelector('[aria-selected="true"]') as HTMLElement | null;
}

describe('ProjectPickerKeyboardNav', () => {
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

  const projects = [
    makeProject('z-id', 'Zebra'),
    makeProject('a-id', 'apple'),
    makeProject('m-id', 'Mango'),
  ];

  /** Shared setup: seed three projects and render the board. */
  function setup() {
    vi.mocked(api.listProjects).mockResolvedValue(projects);
    renderKanbanBoard();
  }

  it('has no highlighted row before any arrow key is pressed', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));
    const highlighted = getHighlightedRow();
    expect(highlighted).toBeNull();
  });

  it('ArrowDown highlights the first project (alphabetically sorted)', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' });

    // "apple" is first in the sorted list
    const row = getProjectRow('apple');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('ArrowDown advances the highlight to the second project', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // apple (1st)
    fireEvent.keyDown(searchInput, { key: "ArrowDown" }); // Mango (2nd)

    const row = getProjectRow('Mango');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');

    // apple should now be un-highlighted
    const appleRow = getProjectRow('apple');
    expect(appleRow?.getAttribute('aria-selected')).toBe('false');
  });

  it('ArrowUp moves the highlight back up one position', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // apple
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // Mango
    fireEvent.keyDown(searchInput, { key: 'ArrowUp' });   // back to apple

    const row = getProjectRow('apple');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');

    const mangoRow = getProjectRow('Mango');
    expect(mangoRow?.getAttribute('aria-selected')).toBe('false');
  });

  it('clamps at the top — ArrowUp while first is highlighted keeps first highlighted', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // apple (first)
    fireEvent.keyDown(searchInput, { key: 'ArrowUp' });   // clamp — still apple

    const row = getProjectRow('apple');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('clamps at the bottom — ArrowDown while last is highlighted keeps last highlighted', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // apple
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // Mango
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // Zebra (last)
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // clamp — still Zebra

    const row = getProjectRow('Zebra');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('Enter selects the highlighted project', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // highlights apple
    fireEvent.keyDown(searchInput, { key: 'Enter' });     // selects it

    expect(localStorage.getItem('agenfk_project_id')).toBe('a-id');
  });

  it('keyboard navigation works with an active search filter', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');

    // Filter to only "Mango"
    fireEvent.change(searchInput, { target: { value: 'man' } });
    await waitFor(() => {
      expect(screen.queryByText('Zebra')).toBeNull();
      expect(screen.queryByText('apple')).toBeNull();
    });

    // ArrowDown highlights the first filtered result
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
    const row = getProjectRow('Mango');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');

    // Enter selects the filtered project
    fireEvent.keyDown(searchInput, { key: 'Enter' });
    expect(localStorage.getItem('agenfk_project_id')).toBe('m-id');
  });
});