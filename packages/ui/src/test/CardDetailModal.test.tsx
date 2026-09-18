/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { SocketProvider } from '../SocketContext';
import { CardDetailModal } from '../components/CardDetailModal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ItemType, Status } from '../types';
import { itemTypeHint } from '../components/ItemTypeSquare';
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
    listAgentRuns: vi.fn(() => Promise.resolve([])),
    listRunEvents: vi.fn(() => Promise.resolve([])),
  }
}));

// Capturing socket mock so tests can drive server-push events.
const socketHandlers: Record<string, (...args: any[]) => void> = {};
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connect: vi.fn(),
    on: (ev: string, cb: (...args: any[]) => void) => { socketHandlers[ev] = cb; },
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
  },
});

// SocketProvider owns the connection now (CGLAB-168), so the component only
// subscribes — it needs the provider above it to receive anything. The io()
// mock above still captures the handlers, so socketHandlers drives events
// exactly as before.
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <SocketProvider>
      <ThemeProvider>
        {children}
      </ThemeProvider>
    </SocketProvider>
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
    for (const k of Object.keys(socketHandlers)) delete socketHandlers[k];
  });

  afterEach(() => {
    cleanup();
  });

  // The detail modal's tracker badge was gated on externalUrl, so a card linked
  // while JIRA was disconnected — which stores the key with no URL by design —
  // showed no reference at all here.
  const renderModal = (item: Record<string, unknown>) => {
    (api.getItem as any).mockResolvedValue(item);
    return render(
      <CardDetailModal
        item={item as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
      />,
      { wrapper }
    );
  };

  it('shows a JIRA reference that has no browse URL', async () => {
    renderModal({ ...mockItem, externalId: 'CGLAB-163' });
    expect(screen.getByText('CGLAB-163')).toBeDefined();
  });

  it('does not render the url-less reference as a link', async () => {
    renderModal({ ...mockItem, externalId: 'CGLAB-163' });
    expect(screen.getByText('CGLAB-163').closest('a')).toBeNull();
  });

  it('still renders a clickable badge when the URL is present', async () => {
    renderModal({
      ...mockItem,
      externalId: 'CGLAB-163',
      externalUrl: 'https://cg-lab.atlassian.net/browse/CGLAB-163',
    });
    expect(screen.getByText('CGLAB-163').closest('a')).not.toBeNull();
  });

  it('renders no reference badge when externalId is null', async () => {
    renderModal({ ...mockItem, externalId: null, externalUrl: null });
    expect(screen.queryByText('CGLAB-163')).toBeNull();
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

  it('should display step badge beside author when comment has a step field', () => {
    const itemWithComments = {
      ...mockItem,
      comments: [
        {
          id: 'c1',
          author: 'agent',
          content: 'evidence text',
          timestamp: new Date().toISOString(),
          step: 'create_unit_tests',
        },
      ],
    };
    render(
      <CardDetailModal
        item={itemWithComments as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );
    // Author is shown
    expect(screen.getByText('@agent')).toBeDefined();
    // Step badge is shown beside the author
    expect(screen.getByText('create_unit_tests')).toBeDefined();
  });

  it('should not display any step badge when comment has no step field', () => {
    const itemWithComments = {
      ...mockItem,
      comments: [
        {
          id: 'c2',
          author: 'user',
          content: 'plain comment',
          timestamp: new Date().toISOString(),
        },
      ],
    };
    render(
      <CardDetailModal
        item={itemWithComments as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );
    expect(screen.getByText('@user')).toBeDefined();
    // No step badge rendered
    expect(screen.queryByTestId('comment-step-badge')).toBeNull();
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

  // CGLAB-21 follow-up #1: the Runs tab is conditional on agent runs existing.
  // A server-pushed run:event must make it appear live, without a manual refresh.
  it('reveals the Runs tab live when a run:event socket arrives', async () => {
    (api.getItem as any).mockResolvedValue(mockItem);
    vi.mocked(api.listAgentRuns).mockResolvedValue([] as any);

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

    await waitFor(() => expect(screen.getByText('Test Story')).toBeDefined());
    // No runs yet → no Runs tab.
    expect(screen.queryByRole('button', { name: /Runs/i })).toBeNull();

    // A run gets recorded; the server pushes a run:event for this item.
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'r1', itemId: 'i1', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', status: 'running', startedAt: '2026-07-21T10:00:00.000Z' },
    ] as any);
    await act(async () => {
      socketHandlers['run:event']?.({ itemId: 'i1', runId: 'r1', event: {} });
    });

    // Tab appears without any manual refetch.
    await waitFor(() => expect(screen.getByRole('button', { name: /Runs/i })).toBeDefined());
  });

  // CGLAB-21 follow-up #5: status is shown once (the header chip). The old
  // "Status: …" line under the title in Overview must be gone.
  it('shows the workflow status only once (header chip, not under the title)', async () => {
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

    await waitFor(() => expect(screen.getByText('Test Story')).toBeDefined());
    // The status value (TODO) appears exactly once — the header chip.
    expect(screen.getAllByText('TODO')).toHaveLength(1);
    // The old under-title "Status:" line is gone.
    expect(screen.queryByText(/^Status:/)).toBeNull();
  });
});

/**
 * Writing a card from nothing (CGLAB-164).
 *
 * Reported by a user who could not answer his own question: "I'm starting a
 * new task from scratch — do I write it in agenfk?" The route exists, and
 * what it opens is the same modal a finished card opens: 72rem wide, the full
 * window height, a Metrics panel reading a cycle time of zero, a Hierarchy
 * panel saying the parent is None, and an empty Progress Log — all of it
 * describing a card that does not exist yet, wrapped around three inputs.
 *
 * Two changes, and neither is a redesign: the draft is sized to what a draft
 * actually has, and the type control gets the grammar every tracker already
 * uses. The dropdown itself stays exactly where it was.
 */
describe('the create form is a draft, not a finished card', () => {
  const draft = { type: ItemType.TASK, status: Status.TODO, title: '', description: '', projectId: 'p1' };

  const openDraft = (over: Record<string, unknown> = {}) =>
    render(
      <CardDetailModal
        item={{ ...draft, ...over } as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );

  afterEach(cleanup);

  it('drops the panels that can only describe a card that already exists', () => {
    // Cycle time of a card created zero seconds ago, a parent of "None", and a
    // progress log with nothing in it. Three panels, all of them answering
    // questions nobody asked of a blank form.
    openDraft();
    expect(screen.queryByText(/cycle time/i)).toBeNull();
    expect(screen.queryByText(/^Hierarchy$/i)).toBeNull();
    expect(screen.queryByText(/progress log/i)).toBeNull();
  });

  it('keeps every one of those panels on a card that does exist', () => {
    /*
     * The half that makes the test above mean something. "Hide it" is one
     * character away from "hide it always", and the detail view is the screen
     * these panels were built for.
     */
    render(
      <CardDetailModal
        item={{ id: 'i9', projectId: 'p1', type: ItemType.TASK, title: 'Real card', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() } as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );
    expect(screen.getByText(/cycle time/i)).toBeDefined();
    expect(screen.getByText(/^Hierarchy$/i)).toBeDefined();
    expect(screen.getByText(/progress log/i)).toBeDefined();
  });

  it('draws no tab strip, because a draft has exactly one tab', () => {
    // Plan, Subitems, History, Tests, Usage and Runs are all hidden on a card
    // with no id, which leaves a tab bar with a single tab in it — a control
    // that cannot be used for anything.
    openDraft();
    expect(screen.queryByRole('button', { name: /^overview$/i })).toBeNull();
  });

  it('keeps the tab strip on a card that has more than one tab', () => {
    render(
      <CardDetailModal
        item={{ id: 'i9', projectId: 'p1', type: ItemType.STORY, title: 'Real card', status: Status.TODO, createdAt: new Date(), updatedAt: new Date(), implementationPlan: '# Plan' } as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );
    expect(screen.getByRole('button', { name: /^overview$/i })).toBeDefined();
  });

  it('is sized to its content instead of taking the whole window', () => {
    // max-w-6xl h-[calc(100vh-2rem)] — 72rem wide and the full window height,
    // for a title, a description and a type. It makes a small decision look
    // like a large one and pushes Create a screen away from the field you
    // just typed into.
    const { container } = openDraft();
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(panel).toBeTruthy();
    // Positive as well as negative: deleting the size branch entirely would
    // satisfy both "not 6xl" and "not full height" while leaving the dialog
    // with NO max-width at all — edge to edge, worse than what it replaced.
    expect(panel.className).toMatch(/max-w-xl/);
    expect(panel.className).not.toMatch(/max-w-6xl/);
    // Anchored on the class boundary: `max-h-[calc(100vh-2rem)]` is a CEILING
    // and is fine — an unanchored match would read it as the fixed height and
    // fail a correct implementation.
    expect(panel.className).not.toMatch(/(^|\s)h-\[calc\(100vh-2rem\)\]/);
  });

  it('keeps the detail view at the size it already was', () => {
    // The card this fixes is about CREATING a card. A finished card has tabs,
    // a run panel and a progress log, and it earns the room.
    const { container } = render(
      <CardDetailModal
        item={{ id: 'i9', projectId: 'p1', type: ItemType.TASK, title: 'Real card', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() } as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(panel.className).toMatch(/max-w-6xl/);
  });

  it('is announced as a dialog with a name', () => {
    // Before this it was an unnamed <div> over the app: a screen reader
    // announced nothing at all when it opened.
    openDraft();
    const dialog = screen.getByRole('dialog', { name: /new item/i });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('hands the type hint to whoever focuses the type control', () => {
    /*
     * Not just on screen — reachable from the control it describes. A sighted
     * user reads the line under the dropdown; someone tabbing into the
     * combobox hears "Type, combobox, TASK" and would never reach the
     * sentence, which sits several elements away in the DOM.
     */
    openDraft();
    const select = screen.getByRole('combobox', { name: /type/i });
    const describedBy = select.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(itemTypeHint(ItemType.TASK));
  });

  it('puts focus inside itself when it opens', () => {
    /*
     * `aria-modal="true"` tells assistive tech that everything behind this is
     * inert. Opening it with focus still out there on the board contradicts
     * that on the first Tab. The draft aims focus at the first field; the
     * detail view has no field to aim at, so the panel takes it — the same
     * shape the card picker already uses.
     */
    openDraft();
    expect(document.activeElement).toBe(screen.getByLabelText('Title'));
    cleanup();

    render(
      <CardDetailModal
        item={{ id: 'i9', projectId: 'p1', type: ItemType.TASK, title: 'Real card', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() } as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Real card' }));
  });

  it('names the type control, which was an unlabelled combobox', () => {
    // One <label> served three inputs. The type <select> had none, so it was
    // announced as "combobox" and nothing else.
    openDraft();
    expect(screen.getByRole('combobox', { name: /type/i })).toBeDefined();
  });

  it('names the description box, which was an unlabelled textbox', () => {
    openDraft();
    expect(screen.getByRole('textbox', { name: /description/i })).toBeDefined();
  });

  it('says which step the card will land in, because the flow is configurable', () => {
    // Nobody should have to know a project's first step by heart, and it is
    // not always TODO — flows are per-project and their steps are renamed.
    openDraft({ status: 'BACKLOG' });
    expect(screen.getByText(/lands in/i).textContent).toMatch(/BACKLOG/);
  });

  it('shows the tracker square for the selected type, and changes it with the selection', () => {
    // The grammar, attached to the control that was four bare words. The
    // <select> is untouched; what changes is that you can now see which type
    // you are on without reading it.
    openDraft();
    const square = screen.getByTestId('new-item-type-square');
    expect(square.className).toMatch(/bg-blue-\d{3}/); // TASK
    fireEvent.change(screen.getByRole('combobox', { name: /type/i }), { target: { value: ItemType.EPIC } });
    expect(screen.getByTestId('new-item-type-square').className).toMatch(/bg-violet-\d{3}/);
  });

  it('says what the chosen type means, and updates when it changes', () => {
    /*
     * The wiring, not the wording: that the line on screen is the one written
     * for the type currently selected. What those sentences must and must not
     * claim is pinned in ItemTypeSquare.test.tsx, next to the function that
     * writes them — including the ban on promising a worktree, which nothing
     * in the server gates on type.
     */
    openDraft();
    expect(screen.getByTestId('new-item-type-hint').textContent).toBe(itemTypeHint(ItemType.TASK));
    fireEvent.change(screen.getByRole('combobox', { name: /type/i }), { target: { value: ItemType.EPIC } });
    expect(screen.getByTestId('new-item-type-hint').textContent).toBe(itemTypeHint(ItemType.EPIC));
    expect(itemTypeHint(ItemType.EPIC)).not.toBe(itemTypeHint(ItemType.TASK));
  });

  it('leaves the real card its plain type chip, with no create-form grammar on it', () => {
    // The visible half of "the detail view is unchanged". The square belongs
    // to the control that CHOOSES a type; a card whose type is settled shows
    // the chip it always showed.
    render(
      <CardDetailModal
        item={{ id: 'i9', projectId: 'p1', type: ItemType.BUG, title: 'Real card', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() } as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={async () => {}}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );
    expect(screen.queryByTestId('new-item-type-square')).toBeNull();
    expect(screen.queryByTestId('new-item-type-hint')).toBeNull();
    expect(screen.queryByRole('combobox', { name: /type/i })).toBeNull();
    expect(screen.getAllByText('BUG').length).toBeGreaterThan(0);
  });

  it('carries the description through to the card it creates', () => {
    // The `id`/`htmlFor` pairing added for the label sits on a CONTROLLED
    // input: getting it wrong breaks the binding silently, and the existing
    // create test passes an empty description, which cannot see that.
    const onAddItem = vi.fn().mockResolvedValue(undefined);
    render(
      <CardDetailModal
        item={draft as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={onAddItem}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );
    fireEvent.change(screen.getByPlaceholderText(/Title of your new task/i), { target: { value: 'With a reason' } });
    fireEvent.change(screen.getByRole('textbox', { name: /description/i }), { target: { value: 'The constraint you will forget' } });
    fireEvent.click(screen.getByRole('button', { name: /Create task/i }));
    return waitFor(() =>
      expect(onAddItem).toHaveBeenCalledWith('With a reason', ItemType.TASK, Status.TODO, 'The constraint you will forget'),
    );
  });

  it('still creates the card it was always able to create', () => {
    // The regression this whole change must not cause: everything above is
    // chrome around one button that has to keep working.
    const onAddItem = vi.fn().mockResolvedValue(undefined);
    render(
      <CardDetailModal
        item={draft as any}
        allItems={[]}
        onClose={() => {}}
        onSelectItem={() => {}}
        onAddItem={onAddItem}
        onDeleteItem={async () => {}}
      />,
      { wrapper },
    );
    fireEvent.change(screen.getByPlaceholderText(/Title of your new task/i), { target: { value: 'Still works' } });
    fireEvent.click(screen.getByRole('button', { name: /Create task/i }));
    return waitFor(() =>
      expect(onAddItem).toHaveBeenCalledWith('Still works', ItemType.TASK, Status.TODO, ''),
    );
  });
});
