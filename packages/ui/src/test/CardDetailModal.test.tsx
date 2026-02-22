/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CardDetailModal } from '../components/CardDetailModal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ItemType, Status } from '../types';
import { api } from '../api';

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
    getItem: vi.fn(() => Promise.resolve({})),
    updateItem: vi.fn(() => Promise.resolve({})),
    listItems: vi.fn(() => Promise.resolve([])),
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
    type: ItemType.STORY,
    title: 'Test Story',
    description: 'Test Description',
    status: Status.TODO,
    createdAt: new Date(),
    updatedAt: new Date(),
    tokenUsage: [{ model: 'gpt-4', input: 100, output: 50 }],
    reviews: [{ id: 'r1', command: 'npm test', output: 'ok', status: 'PASSED', executedAt: new Date() }],
    implementationPlan: '# Plan\n- step 1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('should render item details and switch tabs', async () => {
    (api.getItem as any).mockResolvedValue(mockItem);
    
    render(
      <CardDetailModal 
        item={mockItem as any} 
        allItems={[]} 
        onClose={() => {}} 
        onSelectItem={() => {}}
        onAddItem={async () => {}}
      />, 
      { wrapper }
    );
    
    expect(screen.getByText('Test Story')).toBeDefined();
    
    // Switch to Plan tab
    const planTab = screen.getByRole('button', { name: /Plan/i });
    fireEvent.click(planTab);
    expect(screen.getByText(/step 1/i)).toBeDefined();

    // Switch to Test Results tab
    const testsTab = screen.getByRole('button', { name: /Test Results/i });
    fireEvent.click(testsTab);
    expect(screen.getByText(/npm test/i)).toBeDefined();

    // Switch to Usage tab
    const usageTab = screen.getByRole('button', { name: /Usage/i });
    fireEvent.click(usageTab);
    expect(screen.getByText(/gpt-4/i)).toBeDefined();
  });

  it('should render subitems for stories', async () => {
    const subitem = { id: 'sub1', parentId: 'i1', title: 'Sub Task', type: ItemType.TASK, status: Status.DONE };
    render(
      <CardDetailModal 
        item={mockItem as any} 
        allItems={[subitem as any]} 
        onClose={() => {}} 
        onSelectItem={() => {}}
        onAddItem={async () => {}}
      />, 
      { wrapper }
    );

    const subitemsTab = screen.getByRole('button', { name: /Subitems/i });
    fireEvent.click(subitemsTab);
    expect(await screen.findByText('Sub Task')).toBeDefined();
    expect(screen.getByText('DONE')).toBeDefined();
  });

  it('should show "No subitems found" message', () => {
    render(
      <CardDetailModal 
        item={mockItem as any} 
        allItems={[]} 
        onClose={() => {}} 
        onSelectItem={() => {}}
        onAddItem={async () => {}}
      />, 
      { wrapper }
    );

    const subitemsTab = screen.getByRole('button', { name: /Subitems/i });
    fireEvent.click(subitemsTab);
    expect(screen.getByText(/No subitems found/i)).toBeDefined();
  });

  it('should allow adding a subitem', async () => {
    const onAddItem = vi.fn().mockResolvedValue(undefined);
    render(
      <CardDetailModal 
        item={mockItem as any} 
        allItems={[]} 
        onClose={() => {}} 
        onSelectItem={() => {}}
        onAddItem={onAddItem}
      />, 
      { wrapper }
    );

    const subitemsTab = screen.getByRole('button', { name: /Subitems/i });
    fireEvent.click(subitemsTab);

    const input = screen.getByPlaceholderText(/Quick add/i);
    fireEvent.change(input, { target: { value: 'New Task' } });
    fireEvent.submit(input.closest('form')!);

    expect(onAddItem).toHaveBeenCalledWith('New Task', ItemType.TASK);
  });

  it('should always show the History tab even if empty', () => {
    const itemWithNoHistory = { ...mockItem, history: [] };
    render(
      <CardDetailModal 
        item={itemWithNoHistory as any} 
        allItems={[]} 
        onClose={() => {}} 
        onSelectItem={() => {}}
        onAddItem={async () => {}}
      />, 
      { wrapper }
    );

    const historyTab = screen.getByRole('button', { name: /History/i });
    expect(historyTab).toBeDefined();
    
    fireEvent.click(historyTab);
    expect(screen.getByText(/No state transitions recorded/i)).toBeDefined();
  });

  it('should copy ID to clipboard when clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText,
      },
    });

    render(
      <CardDetailModal 
        item={mockItem as any} 
        allItems={[]} 
        onClose={() => {}} 
        onSelectItem={() => {}}
        onAddItem={async () => {}}
      />, 
      { wrapper }
    );

    const copyButton = screen.getByTitle(/Copy full ID/i);
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith(mockItem.id);
  });
});
