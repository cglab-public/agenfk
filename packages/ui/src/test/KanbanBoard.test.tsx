/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { KanbanBoard } from '../components/KanbanBoard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(),
    listItems: vi.fn(),
    getItem: vi.fn(),
    createItem: vi.fn(),
    updateItem: vi.fn(),
    deleteItem: vi.fn(),
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
    
    expect(await screen.findByText(/Select a Project/i)).toBeDefined();
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
});
