/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { KanbanBoard } from '../components/KanbanBoard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { ItemType, Status } from '../types';
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
    createProject: vi.fn(() => Promise.resolve({ id: 'p-new', name: 'New' })),
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

describe('KanbanBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    queryClient.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('should show project selector when no project is selected', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([]);
    render(<KanbanBoard />, { wrapper });
    expect(await screen.findByText(/Welcome to AgenFK/i)).toBeDefined();
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
    
    const createBtn = await screen.findByText(/Create New Project/i);
    fireEvent.click(createBtn);
    
    const input = await screen.findByPlaceholderText(/e.g. My Awesome App/i);
    fireEvent.change(input, { target: { value: 'New Project' } });
    
    const submitBtn = screen.getByRole('button', { name: /Create Project/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(api.createProject).toHaveBeenCalled();
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
});
