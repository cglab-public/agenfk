/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { CardDetailModal } from '../components/CardDetailModal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('should render item details and switch tabs', async () => {
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
    const planTab = screen.getAllByText(/Plan/i)[0];
    fireEvent.click(planTab);
    expect(screen.getByText(/step 1/i)).toBeDefined();

    // Switch to Reviews tab
    const reviewsTab = screen.getAllByText(/Reviews/i)[0];
    fireEvent.click(reviewsTab);
    expect(screen.getByText(/npm test/i)).toBeDefined();

    // Switch to Usage tab
    const usageTab = screen.getAllByText(/Usage/i)[0];
    fireEvent.click(usageTab);
    expect(screen.getByText(/gpt-4/i)).toBeDefined();
  });

  it('should render subitems for stories', () => {
    const subitem = { id: 'sub1', parentId: 'i1', title: 'Sub Task', type: ItemType.TASK };
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

    const subitemsTab = screen.getAllByText(/Subitems/i)[0];
    fireEvent.click(subitemsTab);
    expect(screen.getByText('Sub Task')).toBeDefined();
  });
});
