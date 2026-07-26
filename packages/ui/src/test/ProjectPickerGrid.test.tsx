/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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

describe('ProjectPickerGrid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
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
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </QueryClientProvider>
    );
    render(<KanbanBoard />, { wrapper });
  }

  function setColumns(cols: number) {
    (window.matchMedia as any).mockImplementation((query: string) => ({
      matches: cols === 3 ? query.includes('1024')
             : cols === 2 ? query.includes('640')
             : false,
      media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
  }

  const projects = [
    makeProject('a1', 'a1'),
    makeProject('a2', 'a2'),
    makeProject('a3', 'a3'),
    makeProject('a4', 'a4'),
    makeProject('a5', 'a5'),
    makeProject('a6', 'a6'),
    makeProject('a7', 'a7'),
  ];

  function setup() {
    vi.mocked(api.listProjects).mockResolvedValue(projects);
    renderKanbanBoard();
  }

  it('data-columns is "1" with the default mock (nothing matches)', async () => {
    setColumns(1);
    setup();
    await waitFor(() => screen.getByText('a1'));
    const listbox = screen.getByRole('listbox', { name: /projects/i });
    expect(listbox.getAttribute('data-columns')).toBe('1');
  });

  it('data-columns is "2" when the 640px query matches', async () => {
    setColumns(2);
    setup();
    await waitFor(() => screen.getByText('a1'));
    const listbox = screen.getByRole('listbox', { name: /projects/i });
    expect(listbox.getAttribute('data-columns')).toBe('2');
  });

  it('data-columns is "3" when the 1024px query matches', async () => {
    setColumns(3);
    setup();
    await waitFor(() => screen.getByText('a1'));
    const listbox = screen.getByRole('listbox', { name: /projects/i });
    expect(listbox.getAttribute('data-columns')).toBe('3');
  });

  it('cols=3: ArrowDown once -> a1 highlighted (from the -1 state)', async () => {
    setColumns(3);
    setup();
    await waitFor(() => screen.getByText('a1'));

    fireEvent.keyDown(document, { key: 'ArrowDown' });

    const row = getProjectRow('a1');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('cols=3: ArrowUp from the -1 state highlights a1', async () => {
    setColumns(3);
    setup();
    await waitFor(() => screen.getByText('a1'));

    fireEvent.keyDown(document, { key: 'ArrowUp' });

    const row = getProjectRow('a1');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('cols=3: ArrowRight from the -1 state highlights a1', async () => {
    setColumns(3);
    setup();
    await waitFor(() => screen.getByText('a1'));

    fireEvent.keyDown(document, { key: 'ArrowRight' });

    const row = getProjectRow('a1');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('cols=3: ArrowLeft from the -1 state highlights a1', async () => {
    setColumns(3);
    setup();
    await waitFor(() => screen.getByText('a1'));

    fireEvent.keyDown(document, { key: 'ArrowLeft' });

    const row = getProjectRow('a1');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('cols=3: ArrowDown, ArrowDown -> a4 (moved a whole row, NOT a2)', async () => {
    setColumns(3);
    setup();
    await waitFor(() => screen.getByText('a1'));

    fireEvent.keyDown(document, { key: 'ArrowDown' }); // a1 (idx 0)
    fireEvent.keyDown(document, { key: 'ArrowDown' }); // a4 (idx 3)

    const row = getProjectRow('a4');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
    expect(getProjectRow('a2')?.getAttribute('aria-selected')).toBe('false');
  });

  it('cols=3: ArrowDown, ArrowRight -> a2', async () => {
    setColumns(3);
    setup();
    await waitFor(() => screen.getByText('a1'));

    fireEvent.keyDown(document, { key: 'ArrowDown' }); // a1
    fireEvent.keyDown(document, { key: 'ArrowRight' }); // a2

    const row = getProjectRow('a2');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('cols=3: ArrowDown, ArrowRight, ArrowLeft -> a1', async () => {
    setColumns(3);
    setup();
    await waitFor(() => screen.getByText('a1'));

    fireEvent.keyDown(document, { key: 'ArrowDown' }); // a1
    fireEvent.keyDown(document, { key: 'ArrowRight' }); // a2
    fireEvent.keyDown(document, { key: 'ArrowLeft' });  // a1

    const row = getProjectRow('a1');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('cols=3: ArrowLeft at index 0 clamps to a1 (stays)', async () => {
    setColumns(3);
    setup();
    await waitFor(() => screen.getByText('a1'));

    fireEvent.keyDown(document, { key: 'ArrowDown' }); // a1
    fireEvent.keyDown(document, { key: 'ArrowLeft' });  // clamp a1

    const row = getProjectRow('a1');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('cols=3: ArrowDown then ArrowUp clamps to a1 (no row above)', async () => {
    setColumns(3);
    setup();
    await waitFor(() => screen.getByText('a1'));

    fireEvent.keyDown(document, { key: 'ArrowDown' }); // a1
    fireEvent.keyDown(document, { key: 'ArrowUp' });    // clamp a1

    const row = getProjectRow('a1');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('cols=3: from a5 (index 4), ArrowDown clamps to a7 (index 6, the last item) rather than running off the end', async () => {
    setColumns(3);
    setup();
    await waitFor(() => screen.getByText('a5'));

    // Manually highlight a5 first
    fireEvent.keyDown(document, { key: 'ArrowDown' }); // a1
    fireEvent.keyDown(document, { key: 'ArrowDown' }); // a4
    fireEvent.keyDown(document, { key: 'ArrowRight' }); // a5

    fireEvent.keyDown(document, { key: 'ArrowDown' }); // should clamp to a7 (idx 6)

    const row = getProjectRow('a7');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('cols=3: ArrowDown to a1 then Enter selects it — assert localStorage.getItem(\'agenfk_project_id\') is a1\'s id', async () => {
    setColumns(3);
    setup();
    await waitFor(() => screen.getByText('a1'));

    fireEvent.keyDown(document, { key: 'ArrowDown' }); // a1
    fireEvent.keyDown(document, { key: 'Enter' });

    expect(localStorage.getItem('agenfk_project_id')).toBe('a1');
  });

  it('cols=2: ArrowDown, ArrowDown -> a3 (row step of 2, proving the step follows the live column count and is not hardcoded)', async () => {
    setColumns(2);
    setup();
    await waitFor(() => screen.getByText('a1'));

    fireEvent.keyDown(document, { key: 'ArrowDown' }); // a1
    fireEvent.keyDown(document, { key: 'ArrowDown' }); // a3

    const row = getProjectRow('a3');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('aria-selected')).toBe('true');
  });

  it('the modal panel has max-w-4xl and does not have max-w-md', async () => {
    setColumns(3);
    setup();
    await waitFor(() => screen.getByText('a1'));

    const panel = screen.getByTestId('project-picker-panel');
    expect(panel.className).toContain('max-w-4xl');
    expect(panel.className).not.toContain('max-w-md');
  });

  it('the list has max-h-[60vh], grid-cols-1, sm:grid-cols-2, lg:grid-cols-3, and still has an ancestor with overflow-y-auto', async () => {
    setColumns(3);
    setup();
    await waitFor(() => screen.getByText('a1'));

    const listbox = screen.getByRole('listbox', { name: /projects/i });
    const listClasses = listbox.className;

    expect(listClasses).toContain('max-h-[60vh]');
    expect(listClasses).toContain('grid-cols-1');
    expect(listClasses).toContain('sm:grid-cols-2');
    expect(listClasses).toContain('lg:grid-cols-3');

    expect(listClasses).toContain('overflow-y-auto');
  });
});
