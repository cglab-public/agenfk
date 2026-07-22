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

// Mock posthog
vi.mock('../posthog', () => ({ capture: vi.fn(), initPosthog: vi.fn() }));

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
    <ThemeProvider>
      {children}
    </ThemeProvider>
  </QueryClientProvider>
);

function makeProject(id: string, name: string) { return { id, name, createdAt: new Date(), updatedAt: new Date() }; }

describe('ProjectPickerDismiss', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    queryClient.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('first load with no selected project: picker shown, no close button', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([makeProject('p1','Alpha')]);
    render(<KanbanBoard />, { wrapper });
    await waitFor(() => screen.getByText(/Welcome to AgEnFK/i));
    expect(screen.queryByLabelText('Close project picker')).toBeNull();
  });

  it('first load: Escape does not dismiss the picker', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([makeProject('p1','Alpha')]);
    render(<KanbanBoard />, { wrapper });
    await waitFor(() => screen.getByText(/Welcome to AgEnFK/i));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByText(/Welcome to AgEnFK/i)).toBeDefined();
  });

  it('opening the picker from a selected project shows a close button', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([makeProject('p1','Alpha'), makeProject('p2','Beta')]);
    localStorage.setItem('agenfk_project_id','p1');
    render(<KanbanBoard />, { wrapper });
    await waitFor(() => screen.getByTitle('Switch Project'));
    fireEvent.click(screen.getByTitle('Switch Project'));
    await waitFor(() => screen.getByText(/Welcome to AgEnFK/i));
    expect(screen.getByLabelText('Close project picker')).toBeDefined();
  });

  it('Escape closes the picker and restores the board', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([makeProject('p1','Alpha'), makeProject('p2','Beta')]);
    localStorage.setItem('agenfk_project_id','p1');
    render(<KanbanBoard />, { wrapper });
    await waitFor(() => screen.getByTitle('Switch Project'));
    fireEvent.click(screen.getByTitle('Switch Project'));
    await waitFor(() => screen.getByText(/Welcome to AgEnFK/i));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText(/Welcome to AgEnFK/i)).toBeNull());
    expect(screen.getByTitle('Switch Project')).toBeDefined();
  });

  it('clicking the close button closes the picker and restores the board', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([makeProject('p1','Alpha'), makeProject('p2','Beta')]);
    localStorage.setItem('agenfk_project_id','p1');
    render(<KanbanBoard />, { wrapper });
    await waitFor(() => screen.getByTitle('Switch Project'));
    fireEvent.click(screen.getByTitle('Switch Project'));
    await waitFor(() => screen.getByLabelText('Close project picker'));
    fireEvent.click(screen.getByLabelText('Close project picker'));
    await waitFor(() => expect(screen.queryByText(/Welcome to AgEnFK/i)).toBeNull());
    expect(screen.getByTitle('Switch Project')).toBeDefined();
  });

  it('clicking the backdrop closes the picker', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([makeProject('p1','Alpha'), makeProject('p2','Beta')]);
    localStorage.setItem('agenfk_project_id','p1');
    render(<KanbanBoard />, { wrapper });
    await waitFor(() => screen.getByTitle('Switch Project'));
    fireEvent.click(screen.getByTitle('Switch Project'));
    await waitFor(() => screen.getByTestId('project-picker-backdrop'));
    fireEvent.click(screen.getByTestId('project-picker-backdrop'));
    await waitFor(() => expect(screen.queryByText(/Welcome to AgEnFK/i)).toBeNull());
  });

  it('clicking inside the panel does NOT close the picker', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([makeProject('p1','Alpha'), makeProject('p2','Beta')]);
    localStorage.setItem('agenfk_project_id','p1');
    render(<KanbanBoard />, { wrapper });
    await waitFor(() => screen.getByTitle('Switch Project'));
    fireEvent.click(screen.getByTitle('Switch Project'));
    await waitFor(() => screen.getByTestId('project-picker-panel'));
    fireEvent.click(screen.getByTestId('project-picker-panel'));
    expect(screen.getByText(/Welcome to AgEnFK/i)).toBeDefined();
  });

  it('dismiss restores the SAME previously-opened project', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([makeProject('p1','Alpha'), makeProject('p2','Beta')]);
    localStorage.setItem('agenfk_project_id','p1');
    render(<KanbanBoard />, { wrapper });
    await waitFor(() => screen.getByTitle('Switch Project'));
    fireEvent.click(screen.getByTitle('Switch Project'));
    await waitFor(() => screen.getByText(/Welcome to AgEnFK/i));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText(/Welcome to AgEnFK/i)).toBeNull());
    // The board header must show the restored project's name.
    expect(screen.getByText('Alpha')).toBeDefined();
  });

  it('can open the create-project form from the overlay', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([makeProject('p1','Alpha')]);
    localStorage.setItem('agenfk_project_id','p1');
    render(<KanbanBoard />, { wrapper });
    await waitFor(() => screen.getByTitle('Switch Project'));
    fireEvent.click(screen.getByTitle('Switch Project'));
    await waitFor(() => screen.getByText(/Create New Project/i));
    fireEvent.click(screen.getByText(/Create New Project/i));
    // Create form appears inside the still-open overlay.
    expect(screen.getByPlaceholderText(/My Awesome App/i)).toBeDefined();
    expect(screen.getByText(/Project Name/i)).toBeDefined();
  });
});