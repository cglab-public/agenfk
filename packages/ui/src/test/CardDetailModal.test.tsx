/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { CardDetailModal } from '../components/CardDetailModal';
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
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.mock('../api', () => ({
  api: {
    getItem: vi.fn(),
    updateItem: vi.fn(),
    listItems: vi.fn(),
  }
}));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
  },
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      {children}
    </ThemeProvider>
  </QueryClientProvider>
);

describe('CardDetailModal', () => {
  const mockItem = {
    id: 'i1',
    projectId: 'p1',
    type: ItemType.TASK,
    title: 'Test Task',
    description: 'Test Description',
    status: Status.TODO,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
  });

  it('should render item details', async () => {
    vi.mocked(api.getItem).mockResolvedValue(mockItem);
    
    render(
      <CardDetailModal 
        itemId="i1" 
        isOpen={true} 
        onClose={() => {}} 
        allAvailableItems={[]}
      />, 
      { wrapper }
    );
    
    expect(await screen.findByText('Test Task')).toBeDefined();
    expect(screen.getByText('Test Description')).toBeDefined();
  });

  it('should show "Loading..." while fetching item', () => {
    vi.mocked(api.getItem).mockReturnValue(new Promise(() => {})); // Never resolves
    
    render(
      <CardDetailModal 
        itemId="i1" 
        isOpen={true} 
        onClose={() => {}} 
        allAvailableItems={[]}
      />, 
      { wrapper }
    );
    
    expect(screen.getByText(/Loading item details/i)).toBeDefined();
  });
});
