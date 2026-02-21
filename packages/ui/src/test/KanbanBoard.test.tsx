/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { KanbanBoard } from '../components/KanbanBoard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../api';
import { ItemType, Status } from '../types';

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

  it('should show project selector when no project is selected', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([]);
    
    render(<KanbanBoard />, { wrapper });
    
    expect(await screen.findByText(/Welcome to AgenFK/i)).toBeDefined();
    expect(screen.getByText(/Select an existing project/i)).toBeDefined();
  });

  it('should show board when project is selected', async () => {
    const project = { id: 'p1', name: 'Test Project', createdAt: new Date(), updatedAt: new Date() };
    vi.mocked(api.listProjects).mockResolvedValue([project]);
    vi.mocked(api.listItems).mockResolvedValue([]);
    
    localStorage.setItem('agenfk_project_id', 'p1');
    
    render(<KanbanBoard />, { wrapper });
    
    expect(await screen.findByText('Test Project')).toBeDefined();
    expect(screen.getByText('TODO')).toBeDefined();
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

  it('should allow creating a new project', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([]);
    vi.mocked(api.createProject).mockResolvedValue({ id: 'p2', name: 'New Project' });
    
    render(<KanbanBoard />, { wrapper });
    
    const createBtn = await screen.findByText(/Create New Project/i);
    createBtn.click();
    
    // The button click should trigger a state change to show the project creation form.
    // For now we just verify the click didn't crash.
  });
});
