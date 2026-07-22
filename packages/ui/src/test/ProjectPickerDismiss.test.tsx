/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { KanbanBoard } from '../components/KanbanBoard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';

// Mock socket.io-client
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn() })),
}));

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

function renderKanbanBoard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
  render(<KanbanBoard />, { wrapper });
}

describe('ProjectSelection dismiss behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  // Renders the board with a project already open, then opens the picker overlay
  // via the header "Switch Project" button. Leaves the picker open.
  async function openBoardThenPicker() {
    localStorage.setItem('agenfk_project_id', 'p1');
    vi.mocked(api.listProjects).mockResolvedValue([makeProject('p1', 'Project One')]);
    renderKanbanBoard();
    // Board is shown (not the picker) because a project is already selected
    await waitFor(() => screen.getByTitle('Switch Project'));
    expect(screen.queryByText('Welcome to AgEnFK')).toBeNull();
    // Open the picker overlay
    fireEvent.click(screen.getByTitle('Switch Project'));
    await waitFor(() => screen.getByText('Welcome to AgEnFK'));
  }

  it('dismisses via ESC and restores the previously opened project', async () => {
    await openBoardThenPicker();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Welcome to AgEnFK')).toBeNull());
    // Board (previous project) is shown again
    expect(screen.getByTitle('Switch Project')).toBeDefined();
  });

  it('dismisses via the X (close) button and restores the previously opened project', async () => {
    await openBoardThenPicker();
    fireEvent.click(screen.getByLabelText('Close project picker'));
    await waitFor(() => expect(screen.queryByText('Welcome to AgEnFK')).toBeNull());
    expect(screen.getByTitle('Switch Project')).toBeDefined();
  });

  it('dismisses via clicking the backdrop outside the card', async () => {
    await openBoardThenPicker();
    fireEvent.click(screen.getByTestId('project-picker-backdrop'));
    await waitFor(() => expect(screen.queryByText('Welcome to AgEnFK')).toBeNull());
    expect(screen.getByTitle('Switch Project')).toBeDefined();
  });

  it('shows the X (close) button when a project is already open', async () => {
    await openBoardThenPicker();
    expect(screen.getByLabelText('Close project picker')).toBeDefined();
  });

  it('on first load with no previous project, keeps the picker open, hides the X, and ignores ESC', async () => {
    // No agenfk_project_id in localStorage -> first load
    vi.mocked(api.listProjects).mockResolvedValue([makeProject('p1', 'Project One')]);
    renderKanbanBoard();
    await waitFor(() => screen.getByText('Welcome to AgEnFK'));
    // No close (X) button, because there is no previous project to fall back to
    expect(screen.queryByLabelText('Close project picker')).toBeNull();
    // ESC must NOT dismiss the picker
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByText('Welcome to AgEnFK')).toBeDefined();
  });
});