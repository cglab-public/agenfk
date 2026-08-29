/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { KanbanBoard } from '../components/KanbanBoard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';

// Mock socket.io-client
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

// Default flow used in tests
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

function makeProject(id: string, name: string) {
  return { id, name, createdAt: new Date(), updatedAt: new Date() };
}

/** Walk up from a project-name text element to the row div carrying aria-selected. */
function getProjectRow(name: string): HTMLElement | null {
  const textEl = screen.getByText(name);
  return (textEl as HTMLElement).closest('[aria-selected]') as HTMLElement | null;
}

/** Return the element whose aria-selected is "true", or null. */
function getHighlightedRow(): HTMLElement | null {
  return document.querySelector('[aria-selected="true"]') as HTMLElement | null;
}

describe('ProjectPickerKeyboardNav', () => {
  // Handle on the QueryClient of the most recent render, so a test can force a
  // projects refetch and watch the list change under the picker.
  let queryClientRef: QueryClient | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    queryClientRef = null;
  });

  afterEach(() => {
    cleanup();
  });

  function renderKanbanBoard() {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
      },
    });
    queryClientRef = queryClient;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </QueryClientProvider>
    );
    render(<KanbanBoard />, { wrapper });
  }

  const projects = [
    makeProject('z-id', 'Zebra'),
    makeProject('a-id', 'apple'),
    makeProject('m-id', 'Mango'),
  ];

  /** Shared setup: seed three projects and render the board. */
  function setup() {
    vi.mocked(api.listProjects).mockResolvedValue(projects);
    renderKanbanBoard();
  }

  it('has no highlighted row before any arrow key is pressed', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));
    const highlighted = getHighlightedRow();
    expect(highlighted).toBeNull();
  });

  // CGLAB-115 (1): the highlight is only a *visual* marker — Enter no longer
  // depends on it. With no row highlighted, Enter falls back to the first
  // match, so the fallback must not be smuggled into aria-selected either.
  it('Enter with no highlight selects the first match without marking it aria-selected', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    fireEvent.keyDown(document.body, { key: 'Enter' });

    expect(getHighlightedRow()).toBeNull();
    expect(localStorage.getItem('agenfk_project_id')).toBe('a-id');
  });

  it('ArrowDown highlights the first project (alphabetically sorted)', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' });

    // "apple" is first in the sorted list
    const row = getProjectRow('apple');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('ArrowDown advances the highlight to the second project', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // apple (1st)
    fireEvent.keyDown(searchInput, { key: "ArrowDown" }); // Mango (2nd)

    const row = getProjectRow('Mango');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');

    // apple should now be un-highlighted
    const appleRow = getProjectRow('apple');
    expect(appleRow?.getAttribute('aria-selected')).toBe('false');
  });

  it('ArrowUp moves the highlight back up one position', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // apple
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // Mango
    fireEvent.keyDown(searchInput, { key: 'ArrowUp' });   // back to apple

    const row = getProjectRow('apple');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');

    const mangoRow = getProjectRow('Mango');
    expect(mangoRow?.getAttribute('aria-selected')).toBe('false');
  });

  it('clamps at the top — ArrowUp while first is highlighted keeps first highlighted', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // apple (first)
    fireEvent.keyDown(searchInput, { key: 'ArrowUp' });   // clamp — still apple

    const row = getProjectRow('apple');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('clamps at the bottom — ArrowDown while last is highlighted keeps last highlighted', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // apple
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // Mango
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // Zebra (last)
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // clamp — still Zebra

    const row = getProjectRow('Zebra');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('Enter selects the highlighted project', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // highlights apple
    fireEvent.keyDown(searchInput, { key: 'Enter' });     // selects it

    expect(localStorage.getItem('agenfk_project_id')).toBe('a-id');
  });

  it('keyboard navigation works with an active search filter', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');

    // Filter to only "Mango"
    fireEvent.change(searchInput, { target: { value: 'man' } });
    await waitFor(() => {
      expect(screen.queryByText('Zebra')).toBeNull();
      expect(screen.queryByText('apple')).toBeNull();
    });

    // ArrowDown highlights the first filtered result
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
    const row = getProjectRow('Mango');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');

    // Enter selects the filtered project
    fireEvent.keyDown(searchInput, { key: 'Enter' });
    expect(localStorage.getItem('agenfk_project_id')).toBe('m-id');
  });

  it('keyboard navigation works without focusing the search input', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    // Fire ArrowDown on the panel (document listener catches it)
    const panel = screen.getByTestId('project-picker-panel');
    fireEvent.keyDown(panel, { key: 'ArrowDown' });

    const row = getProjectRow('apple');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');

    // Enter on the panel selects the highlighted project
    fireEvent.keyDown(panel, { key: 'Enter' });
    expect(localStorage.getItem('agenfk_project_id')).toBe('a-id');
  });

  it('Enter does not select a project while creating a new project', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    // Open the create-new-project form
    fireEvent.click(screen.getByText('Create New Project'));
    const nameInput = screen.getByPlaceholderText('e.g. My Awesome App');
    fireEvent.change(nameInput, { target: { value: 'My New Project' } });

    // Press Enter while the name input is focused — picker should NOT select
    fireEvent.keyDown(nameInput, { key: 'Enter' });

    // No project was selected via picker (the create mutation may fire, but
    // localStorage must not have been written by handleSelectProject)
    expect(localStorage.getItem('agenfk_project_id')).toBeNull();
  });

  it('shrink-then-Enter selects the correct filtered project', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');

    // ArrowDown x3: apple → Mango → Zebra (last, index 2)
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' });

    const zebraRow = getProjectRow('Zebra');
    expect(zebraRow?.getAttribute('aria-selected')).toBe('true');

    // Type a filter that narrows to only "Mango" — resets highlight to -1
    fireEvent.change(searchInput, { target: { value: 'man' } });
    await waitFor(() => {
      expect(screen.queryByText('Zebra')).toBeNull();
      expect(screen.queryByText('apple')).toBeNull();
    });

    // ArrowDown once: highlights Mango (only filtered result, index 0)
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
    const mangoRow = getProjectRow('Mango');
    expect(mangoRow?.getAttribute('aria-selected')).toBe('true');

    // Enter selects Mango. Note this case does not discriminate between
    // "highlighted" and "first match" — they are the same row here. The
    // discriminating case is 'Enter selects the highlighted row even when it
    // is not the first match'.
    fireEvent.keyDown(searchInput, { key: 'Enter' });
    expect(localStorage.getItem('agenfk_project_id')).toBe('m-id');
  });

  // CGLAB-115 (1): typing in the search box resets the highlight to -1, so
  // Enter used to fall through and do nothing — the fastest path (type a few
  // letters, hit Enter) was dead. Enter must select the first filtered match.
  it('Enter while typing selects the first filtered match', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    fireEvent.change(searchInput, { target: { value: 'man' } });
    await waitFor(() => {
      expect(screen.queryByText('Zebra')).toBeNull();
      expect(screen.queryByText('apple')).toBeNull();
    });

    fireEvent.keyDown(searchInput, { key: 'Enter' });

    expect(localStorage.getItem('agenfk_project_id')).toBe('m-id');
  });

  it('Enter with no typing and no highlight still selects the first project', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    fireEvent.keyDown(document.body, { key: 'Enter' });

    expect(localStorage.getItem('agenfk_project_id')).toBe('a-id');
  });

  // The fallback picks sortedFilteredProjects[0], so with no highlight Enter
  // must land on 'apple' even though 'Zebra' is the first row in the raw
  // fixture array — sort order decides, insertion order does not.
  it('Enter with no highlight picks the alphabetically first project, not the first in the raw list', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    // 'Zebra' is index 0 in the fixture array; 'apple' sorts first.
    expect(screen.getAllByText(/^(apple|Mango|Zebra)$/)[0].textContent).toBe('apple');

    fireEvent.keyDown(document.body, { key: 'Enter' });

    expect(localStorage.getItem('agenfk_project_id')).toBe('a-id');
  });

  it('Enter selects the highlighted row even when it is not the first match', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // apple
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' }); // Mango

    fireEvent.keyDown(searchInput, { key: 'Enter' });

    expect(localStorage.getItem('agenfk_project_id')).toBe('m-id');
  });

  it('Enter with no matches at all is a no-op', async () => {
    setup();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    fireEvent.change(searchInput, { target: { value: 'zzz-no-match' } });
    await waitFor(() => screen.getByText(/no projects match/i));

    fireEvent.keyDown(searchInput, { key: 'Enter' });

    expect(localStorage.getItem('agenfk_project_id')).toBeNull();
  });

  // The bounds check on the highlight guards a highlight that is out of range
  // for the list it now indexes into. Typing cannot produce that (onChange
  // resets the highlight to -1), but a background refetch of the project list
  // can: react-query swaps in a shorter array without touching the highlight.
  // Without this case an off-by-one in the guard survives — Stryker kept
  // landing it, because every other Enter test leaves the index in range.
  it('Enter with a highlight left out of range by a shrinking project list falls back to the first match', async () => {
    const three = [
      makeProject('z-id', 'Zebra'),
      makeProject('a-id', 'apple'),
      makeProject('m-id', 'Mango'),
    ];
    vi.mocked(api.listProjects).mockResolvedValue(three);
    renderKanbanBoard();
    await waitFor(() => screen.getByText('apple'));

    const searchInput = screen.getByLabelText('Search projects');
    // Highlight Mango, index 1 of apple/Mango/Zebra.
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
    expect(getProjectRow('Mango')?.getAttribute('aria-selected')).toBe('true');

    // The list shrinks under the highlight: only Zebra remains, so index 1 is
    // out of range while the highlight still reads 1.
    vi.mocked(api.listProjects).mockResolvedValue([makeProject('z-id', 'Zebra')]);
    await act(async () => {
      await queryClientRef!.invalidateQueries({ queryKey: ['projects'] });
    });
    await waitFor(() => {
      expect(screen.queryByText('apple')).toBeNull();
      expect(screen.queryByText('Mango')).toBeNull();
    });

    fireEvent.keyDown(searchInput, { key: 'Enter' });

    expect(localStorage.getItem('agenfk_project_id')).toBe('z-id');
  });

});
