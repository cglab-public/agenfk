/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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
    listProjects: vi.fn(),
    listItems: vi.fn(),
    getItem: vi.fn(),
    createItem: vi.fn(),
    updateItem: vi.fn(),
    deleteItem: vi.fn(),
    createProject: vi.fn(),
  }
}));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
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
      { id: 'i2', projectId: 'p1', type: ItemType.TASK, title: 'Task 2', status: Status.IN_PROGRESS, createdAt: new Date(), updatedAt: new Date() },
    ];
    
    vi.mocked(api.listProjects).mockResolvedValue([project]);
    vi.mocked(api.listItems).mockResolvedValue(items);
    localStorage.setItem('agenfk_project_id', 'p1');
    
    render(<KanbanBoard />, { wrapper });
    
    expect(await screen.findByText('Task 1')).toBeDefined();
    expect(screen.getByText('Task 2')).toBeDefined();
  });

  it('should handle drill down', async () => {
    const project = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
    const epic = { id: 'e1', projectId: 'p1', type: ItemType.EPIC, title: 'Epic 1', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() };
    const story = { id: 's1', parentId: 'e1', projectId: 'p1', type: ItemType.STORY, title: 'Story 1', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() };
    
    vi.mocked(api.listProjects).mockResolvedValue([project]);
    vi.mocked(api.listItems).mockResolvedValue([epic, story]);
    localStorage.setItem('agenfk_project_id', 'p1');
    
    render(<KanbanBoard />, { wrapper });
    
    const drillBtn = await screen.findByText(/Drill/i);
    fireEvent.click(drillBtn);
    
    expect(await screen.findByText('Epic 1')).toBeDefined();
  });

  it('should allow creating a new project', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([]);
    (api.createProject as any).mockResolvedValue({ id: 'p2', name: 'New Project' });
    
    render(<KanbanBoard />, { wrapper });
    
    const createBtn = await screen.findByText(/Create New Project/i);
    fireEvent.click(createBtn);
    
    const input = screen.getByPlaceholderText(/Project Name/i);
    fireEvent.change(input, { target: { value: 'New Project' } });
    fireEvent.click(screen.getByText(/Create Project/i));

    expect(api.createProject).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Project' }));
  });

  it('should connect to WebSocket on mount', () => {
    render(<KanbanBoard />, { wrapper });
    expect(io).toHaveBeenCalled();
  });
});
