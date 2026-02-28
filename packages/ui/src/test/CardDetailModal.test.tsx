/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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
    tests: [{ id: 'r1', command: 'npm test', output: 'ok', status: 'PASSED', executedAt: new Date() }],
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
        onDeleteItem={async () => {}}
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
        onDeleteItem={async () => {}}
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
        onDeleteItem={async () => {}}
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
        onDeleteItem={async () => {}}
      />, 
      { wrapper }
    );

    const subitemsTab = screen.getByRole('button', { name: /Subitems/i });
    fireEvent.click(subitemsTab);

    const input = screen.getByPlaceholderText(/Quick add/i);
    fireEvent.change(input, { target: { value: 'New Task' } });
    fireEvent.submit(input.closest('form')!);

    expect(onAddItem).toHaveBeenCalledWith('New Task', ItemType.TASK, Status.TODO);
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
        onDeleteItem={async () => {}}
      />, 
      { wrapper }
    );

    const historyTab = screen.getByRole('button', { name: /History/i });
    expect(historyTab).toBeDefined();
    
    fireEvent.click(historyTab);
    expect(screen.getByText(/No state transitions recorded/i)).toBeDefined();
  });

  it('should enter edit mode when pencil button is clicked', async () => {
    const onUpdateItem = vi.fn().mockResolvedValue({});
    render(
      <CardDetailModal
        item={mockItem as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
        onUpdateItem={onUpdateItem}
      />,
      { wrapper },
    );

    const editBtn = screen.getByTitle(/Edit item/i);
    fireEvent.click(editBtn);

    const editTitleInput = screen.getByTestId('edit-title') as HTMLInputElement;
    expect(editTitleInput.value).toBe('Test Story');
  });

  it('should save edit changes when Save button is clicked', async () => {
    const onUpdateItem = vi.fn().mockResolvedValue({});
    render(
      <CardDetailModal
        item={mockItem as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
        onUpdateItem={onUpdateItem}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByTitle(/Edit item/i));
    const editTitle = screen.getByTestId('edit-title');
    fireEvent.change(editTitle, { target: { value: 'Updated Title' } });

    fireEvent.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => {
      expect(onUpdateItem).toHaveBeenCalledWith('i1', expect.objectContaining({ title: 'Updated Title' }));
    });
  });

  it('should cancel edit mode without saving', async () => {
    const onUpdateItem = vi.fn().mockResolvedValue({});
    render(
      <CardDetailModal
        item={mockItem as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
        onUpdateItem={onUpdateItem}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByTitle(/Edit item/i));
    const editTitle = screen.getByTestId('edit-title');
    fireEvent.change(editTitle, { target: { value: 'Changed Title' } });

    // Click cancel (pencil button again in editing state says 'Cancel editing')
    fireEvent.click(screen.getByTitle(/Cancel editing/i));
    expect(onUpdateItem).not.toHaveBeenCalled();
    // Should show original title
    expect(screen.getByText('Test Story')).toBeDefined();
  });

  it('should close on Escape key press', () => {
    const onClose = vi.fn();
    render(
      <CardDetailModal
        item={mockItem as any}
        allItems={[]}
        onClose={onClose}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('should render history when history tab is clicked', async () => {
    const itemWithHistory = {
      ...mockItem,
      history: [{ id: 'h1', fromStatus: 'TODO', toStatus: 'IN_PROGRESS', timestamp: new Date().toISOString(), triggeredBy: 'user' }],
    };
    render(
      <CardDetailModal
        item={itemWithHistory as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /History/i }));
    expect(screen.getByText('IN_PROGRESS')).toBeDefined();
  });

  it('should render EPIC subitems as STORY type', async () => {
    const epicItem = { ...mockItem, type: ItemType.EPIC };
    const storySubitem = { id: 'sub2', parentId: 'i1', title: 'Sub Story', type: ItemType.STORY, status: Status.TODO };
    render(
      <CardDetailModal
        item={epicItem as any}
        allItems={[storySubitem as any]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );
    const subitemsTab = screen.getByRole('button', { name: /Subitems/i });
    fireEvent.click(subitemsTab);
    expect(await screen.findByText('Sub Story')).toBeDefined();
  });

  it('should add STORY type subitem for EPIC parent via Quick Add', async () => {
    const epicItem = { ...mockItem, type: ItemType.EPIC };
    const onAddItem = vi.fn().mockResolvedValue(undefined);
    render(
      <CardDetailModal
        item={epicItem as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={onAddItem}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /Subitems/i }));
    const input = screen.getByPlaceholderText(/Quick add/i);
    fireEvent.change(input, { target: { value: 'New Story' } });
    fireEvent.submit(input.closest('form')!);
    expect(onAddItem).toHaveBeenCalledWith('New Story', ItemType.STORY, Status.TODO);
  });

  it('should call onDeleteItem when Delete is confirmed', async () => {
    const onDeleteItem = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <CardDetailModal
        item={mockItem as any}
        allItems={[]}
        onClose={onClose}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={onDeleteItem}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /Delete/i }));
    await waitFor(() => {
      expect(onDeleteItem).toHaveBeenCalledWith('i1');
    });
  });

  it('should NOT call onDeleteItem when Delete is cancelled', async () => {
    const onDeleteItem = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <CardDetailModal
        item={mockItem as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={onDeleteItem}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /Delete/i }));
    expect(onDeleteItem).not.toHaveBeenCalled();
  });

  it('should render create form when item has no id (isNew)', () => {
    const newItem = { type: ItemType.TASK, status: Status.TODO, title: '', description: '', projectId: 'p1' };
    render(
      <CardDetailModal
        item={newItem as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );
    expect(screen.getByPlaceholderText(/Title of your new task/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /Create task/i })).toBeDefined();
  });

  it('should call onAddItem with new item details via create form', async () => {
    const onAddItem = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const newItem = { type: ItemType.TASK, status: Status.TODO, title: '', description: '', projectId: 'p1' };
    render(
      <CardDetailModal
        item={newItem as any}
        allItems={[]}
        onClose={onClose}
        onSelectItem={() => {}}
        onAddItem={onAddItem}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );
    const titleInput = screen.getByPlaceholderText(/Title of your new task/i);
    fireEvent.change(titleInput, { target: { value: 'Brand New Task' } });
    fireEvent.click(screen.getByRole('button', { name: /Create task/i }));
    await waitFor(() => {
      expect(onAddItem).toHaveBeenCalledWith('Brand New Task', ItemType.TASK, Status.TODO, '');
    });
  });

  it('should navigate to subitem when subitem row is clicked', async () => {
    const subitem = { id: 'sub1', parentId: 'i1', title: 'Sub Task', type: ItemType.TASK, status: Status.DONE };
    const onSelectItem = vi.fn();
    render(
      <CardDetailModal
        item={mockItem as any}
        allItems={[subitem as any]}
        onClose={() => {}}
        onSelectItem={onSelectItem}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: /Subitems/i }));
    const subitemRow = await screen.findByText('Sub Task');
    const row = subitemRow.closest('tr')!;
    fireEvent.click(row);
    expect(onSelectItem).toHaveBeenCalledWith(subitem);
  });

  it('should enter confirm state and then delete on double-click of delete subitem button', async () => {
    const onDeleteItem = vi.fn().mockResolvedValue(undefined);
    const subitem = { id: 'sub1', parentId: 'i1', title: 'Sub Task', type: ItemType.TASK, status: Status.TODO };
    render(
      <CardDetailModal
        item={mockItem as any}
        allItems={[subitem as any]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={onDeleteItem}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: /Subitems/i }));
    await screen.findByText('Sub Task');

    const deleteBtn = screen.getByTestId('delete-subitem-sub1');
    // First click: enter confirm state
    fireEvent.click(deleteBtn);
    expect(screen.getByText('Confirm?')).toBeDefined();

    // Second click: execute delete
    fireEvent.click(deleteBtn);
    await waitFor(() => {
      expect(onDeleteItem).toHaveBeenCalledWith('sub1');
    });
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
        onDeleteItem={async () => {}}
      />, 
      { wrapper }
    );

    const copyButton = screen.getByTitle(/Copy full ID/i);
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith(mockItem.id);
  });
});
