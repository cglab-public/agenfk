/** @vitest-environment jsdom */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import { KanbanBoard } from '../components/KanbanBoard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { ActiveProjectProvider } from '../ActiveProject';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { ItemType, Status, type AgEnFKItem, type Flow, type Project } from '../types';

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn() })),
}));
window.HTMLElement.prototype.scrollTo = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const FLOW = {
  id: 'default', name: 'Default Flow', projectId: '__builtin__',
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
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

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
    getCurrentRelease: vi.fn(() => Promise.resolve(null)),
    getVersion: vi.fn(() => Promise.resolve({ version: '1.0.0' })),
    getProjectFlow: vi.fn(() => Promise.resolve(FLOW)),
    getGitHubStatus: vi.fn(() => Promise.resolve({ configured: false })),
  },
}));

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <ActiveProjectProvider><ThemeProvider>{children}</ThemeProvider></ActiveProjectProvider>
  </QueryClientProvider>
);

// Local calendar parts, so day boundaries are local whatever the suite's TZ.
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const NOW = new Date(2026, 2, 15, 12, 0); // 15 Mar 2026, noon local

let seq = 0;
const item = (title: string, status: Status, createdAt: string, updatedAt: string, extra: Partial<AgEnFKItem> = {}): AgEnFKItem => ({
  id: `id-${title.replace(/\s+/g, '-').toLowerCase()}`,
  projectId: 'p1', type: ItemType.TASK, title, description: '', status,
  sortOrder: seq++, createdAt, updatedAt, history: [], ...extra,
});

// Fresh: created in January, touched yesterday. Stale: nothing since January.
// New: created this morning, touched late tonight (later than "now").
const baseItems = () => {
  seq = 0;
  return [
    item('Fresh Task', Status.TODO, local(2026, 1, 1), local(2026, 3, 14, 10)),
    item('Stale Task', Status.TODO, local(2026, 1, 2), local(2026, 1, 10)),
    item('New Task', Status.IN_PROGRESS, local(2026, 3, 15, 9), local(2026, 3, 15, 23, 59)),
    item('Fresh Paused', Status.PAUSED, local(2026, 1, 1), local(2026, 3, 13)),
    item('Stale Paused', Status.PAUSED, local(2026, 1, 1), local(2026, 1, 3)),
    item('Fresh Blocked', Status.BLOCKED, local(2026, 1, 1), local(2026, 3, 13)),
    item('Stale Blocked', Status.BLOCKED, local(2026, 1, 1), local(2026, 1, 3)),
    item('Fresh Archived', Status.ARCHIVED, local(2026, 1, 1), local(2026, 3, 13)),
    item('Stale Archived', Status.ARCHIVED, local(2026, 1, 1), local(2026, 1, 3)),
    item('Fresh Idea', Status.IDEAS, local(2026, 1, 1), local(2026, 3, 13)),
    item('Stale Idea', Status.IDEAS, local(2026, 1, 1), local(2026, 1, 3)),
  ];
};

// `shown` is a card expected on screen once the board has loaded.
const renderBoard = async (items: AgEnFKItem[] = baseItems(), shown: string = items[0].title) => {
  vi.mocked(api.listProjects).mockResolvedValue([{ id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() } as unknown as Project]);
  vi.mocked(api.listItems).mockResolvedValue(items);
  localStorage.setItem('agenfk_project_id', 'p1');
  const utils = render(<KanbanBoard />, { wrapper });
  await screen.findByText(shown);
  return utils;
};

const openPanel = () => {
  const trigger = screen.getByRole('button', { name: 'Date filter' });
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  return screen.getByRole('group', { name: 'Date filter options' });
};
const chooseField = (label: 'Created' | 'Updated') =>
  fireEvent.click(within(within(openPanel()).getByRole('group', { name: 'Date field' })).getByRole('button', { name: label }));
const chooseRange = (label: string) =>
  fireEvent.click(within(within(openPanel()).getByRole('group', { name: 'Date range' })).getByRole('button', { name: label }));

const visible = (title: string) => screen.queryByText(title) !== null;
const columnCount = (status: string) => screen.getByTestId(`column-count-${status}`).textContent;
const sideCount = (status: string) => screen.getByTestId(`side-count-${status}`).textContent;

describe('Board date filter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    localStorage.clear();
    queryClient.clear();
    vi.mocked(api.getProjectFlow).mockResolvedValue(FLOW as unknown as Flow);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('Any time (the default) leaves the board as it is: every card, original order, no chip', async () => {
    await renderBoard();
    expect(screen.queryByTestId('date-filter-chip')).toBeNull();
    expect(visible('Fresh Task')).toBe(true);
    expect(visible('Stale Task')).toBe(true);
    expect(visible('New Task')).toBe(true);
    expect(columnCount('TODO')).toBe('2');
    const todo = screen.getByTestId('column-header-TODO').parentElement!;
    const titles = within(todo).getAllByText(/Task$/).map(n => n.textContent);
    expect(titles).toEqual(['Fresh Task', 'Stale Task']);
    expect(sideCount('PAUSED')).toBe('2');
  });

  it('defaults to Updated and filters on it: Last 7 days hides the stale card', async () => {
    await renderBoard();
    const panel = openPanel();
    expect(within(panel).getByRole('button', { name: 'Updated' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(panel).getByRole('button', { name: 'Created' })).toHaveAttribute('aria-pressed', 'false');
    chooseRange('Last 7 days');

    await waitFor(() => expect(visible('Stale Task')).toBe(false));
    expect(visible('Fresh Task')).toBe(true);
    expect(visible('New Task')).toBe(true);
    expect(columnCount('TODO')).toBe('1');
    expect(screen.getByTestId('date-filter-chip')).toHaveTextContent('Updated · Last 7 days');
    expect(within(openPanel()).getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('switching to Created re-filters on the creation date only', async () => {
    await renderBoard();
    chooseRange('Last 7 days');
    await waitFor(() => expect(visible('Stale Task')).toBe(false));
    chooseField('Created');

    // Fresh Task was touched yesterday but created in January: gone now.
    await waitFor(() => expect(visible('Fresh Task')).toBe(false));
    expect(visible('New Task')).toBe(true);
    expect(columnCount('TODO')).toBe('0');
    expect(screen.getByTestId('date-filter-chip')).toHaveTextContent('Created · Last 7 days');
    expect(within(openPanel()).getByRole('button', { name: 'Created' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Today includes a card updated at 23:59 tonight', async () => {
    await renderBoard();
    chooseRange('Today');
    await waitFor(() => expect(visible('Fresh Task')).toBe(false));
    expect(visible('New Task')).toBe(true);
    expect(columnCount('IN_PROGRESS')).toBe('1');
  });

  it('a custom range filters on whole local days, both ends included', async () => {
    await renderBoard();
    chooseRange('Custom');
    const panel = openPanel();
    fireEvent.change(within(panel).getByLabelText('From'), { target: { value: '2026-01-01' } });
    fireEvent.change(within(panel).getByLabelText('To'), { target: { value: '2026-01-10' } });

    await waitFor(() => expect(visible('Fresh Task')).toBe(false));
    expect(visible('Stale Task')).toBe(true); // updated 10 Jan, the last included day
    expect(visible('New Task')).toBe(false);
    expect(screen.getByTestId('date-filter-chip')).toHaveTextContent('Updated · 2026-01-01 → 2026-01-10');
  });

  it('the chip clears the filter and brings every card back', async () => {
    await renderBoard();
    chooseRange('Today');
    await waitFor(() => expect(visible('Stale Task')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Clear date filter' }));

    await waitFor(() => expect(visible('Stale Task')).toBe(true));
    expect(visible('Fresh Task')).toBe(true);
    expect(screen.queryByTestId('date-filter-chip')).toBeNull();
    expect(localStorage.getItem('agenfk_board_date_filter:p1')).toBeNull();
  });

  it('announces the active filter to assistive tech', async () => {
    await renderBoard();
    chooseRange('Last 30 days');
    await waitFor(() =>
      expect(screen.getByTestId('date-filter-announcement')).toHaveTextContent('Showing cards updated in the last 30 days'));
    expect(screen.getByTestId('date-filter-announcement')).toHaveAttribute('aria-live', 'polite');
  });

  it('the trigger reports its expanded state and Escape closes the panel', async () => {
    await renderBoard();
    const trigger = screen.getByRole('button', { name: 'Date filter' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Date filter options' })).toBeNull());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows an empty state in a column the filter empties', async () => {
    await renderBoard();
    chooseRange('Today');
    const todo = screen.getByTestId('column-header-TODO').parentElement!;
    await waitFor(() => expect(within(todo).getByText('No cards updated today')).toBeDefined());
    // A column the filter leaves cards in shows no such message.
    const ip = screen.getByTestId('column-header-IN_PROGRESS').parentElement!;
    expect(within(ip).queryByText('No cards updated today')).toBeNull();
  });

  it('filters the side columns and their badges too', async () => {
    await renderBoard();
    chooseRange('Last 7 days');
    await waitFor(() => expect(sideCount('PAUSED')).toBe('1'));
    expect(sideCount('BLOCKED')).toBe('1');
    expect(sideCount('ARCHIVED')).toBe('1');
    expect(sideCount('IDEAS')).toBe('1');

    fireEvent.click(screen.getByTestId('side-count-PAUSED').closest('button')!);
    fireEvent.click(screen.getByTestId('side-count-ARCHIVED').closest('button')!);
    fireEvent.click(screen.getByTestId('side-count-IDEAS').closest('button')!);
    await waitFor(() => expect(visible('Fresh Paused')).toBe(true));
    expect(visible('Stale Paused')).toBe(false);
    expect(visible('Fresh Archived')).toBe(true);
    expect(visible('Stale Archived')).toBe(false);
    expect(visible('Fresh Idea')).toBe(true);
    expect(visible('Stale Idea')).toBe(false);
    // The expanded headers count the same thing as the collapsed rails did.
    expect(sideCount('PAUSED')).toBe('1');
    expect(sideCount('ARCHIVED')).toBe('1');
  });

  it('combines with drill-down: inside a parent, its old children are hidden', async () => {
    seq = 0;
    const items = [
      item('Parent Story', Status.TODO, local(2026, 1, 1), local(2026, 3, 14), { type: ItemType.STORY }),
      item('Fresh Child', Status.TODO, local(2026, 1, 1), local(2026, 3, 14), { parentId: 'id-parent-story' }),
      item('Stale Child', Status.TODO, local(2026, 1, 1), local(2026, 1, 5), { parentId: 'id-parent-story' }),
    ];
    await renderBoard(items);
    const parentCard = screen.getByText('Parent Story').closest('[draggable="true"]') as HTMLElement;
    fireEvent.click(within(parentCard).getByRole('button', { name: /child items/i }));
    await screen.findByText('Stale Child');

    chooseRange('Last 7 days');
    await waitFor(() => expect(visible('Stale Child')).toBe(false));
    expect(visible('Fresh Child')).toBe(true);
    expect(columnCount('TODO')).toBe('1');
  });

  it('search still reaches a card the filter hides, clearing the filter to show it', async () => {
    await renderBoard();
    chooseRange('Today');
    await waitFor(() => expect(visible('Stale Task')).toBe(false));

    const input = screen.getByPlaceholderText(/Search Item ID or Name/i);
    fireEvent.change(input, { target: { value: 'Stale Task' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(visible('Stale Task')).toBe(true));
    expect(screen.queryByTestId('date-filter-chip')).toBeNull();
  });

  it('search for a card the filter already shows keeps the filter', async () => {
    await renderBoard();
    chooseRange('Last 7 days');
    await waitFor(() => expect(visible('Stale Task')).toBe(false));

    const input = screen.getByPlaceholderText(/Search Item ID or Name/i);
    fireEvent.change(input, { target: { value: 'Fresh Task' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(screen.getByText('1/1')).toBeDefined());
    expect(screen.getByTestId('date-filter-chip')).toHaveTextContent('Updated · Last 7 days');
    expect(visible('Stale Task')).toBe(false);
  });

  it('a live update that touches a hidden card brings it into view', async () => {
    const items = baseItems();
    await renderBoard(items);
    chooseRange('Today');
    await waitFor(() => expect(visible('Stale Task')).toBe(false));

    act(() => {
      queryClient.setQueryData(['items', 'p1'], items.map(i =>
        i.title === 'Stale Task' ? { ...i, updatedAt: local(2026, 3, 15, 11) } : i));
    });
    await waitFor(() => expect(visible('Stale Task')).toBe(true));
    expect(columnCount('TODO')).toBe('1');
  });

  it('reordering while filtered renumbers the whole column, hidden cards included', async () => {
    seq = 0;
    const items = [
      item('Alpha', Status.TODO, local(2026, 1, 1), local(2026, 3, 14)),  // sortOrder 0
      item('Hidden', Status.TODO, local(2026, 1, 1), local(2026, 1, 2)),  // sortOrder 1
      item('Bravo', Status.TODO, local(2026, 1, 1), local(2026, 3, 14)),  // sortOrder 2
    ];
    await renderBoard(items);
    chooseRange('Last 7 days');
    await waitFor(() => expect(visible('Hidden')).toBe(false));

    const alpha = screen.getByText('Alpha').closest('[draggable="true"]') as HTMLElement;
    const bravo = screen.getByText('Bravo').closest('[draggable="true"]') as HTMLElement;
    const todoColumn = screen.getByTestId('column-header-TODO').parentElement!;
    const dataTransfer = { setData: vi.fn(), getData: vi.fn((k: string) => (k === 'itemId' ? 'id-bravo' : '')) };
    fireEvent.dragStart(bravo, { dataTransfer });
    alpha.getBoundingClientRect = vi.fn(() => ({ top: 100, height: 100, bottom: 200, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => {} } as DOMRect));
    const over = Object.assign(new CustomEvent('dragover', { bubbles: true, cancelable: true }), { clientY: 120 }); // above Alpha's centre
    fireEvent(alpha, over);
    fireEvent.drop(todoColumn, { dataTransfer });

    await waitFor(() => expect(api.bulkUpdateItems).toHaveBeenCalled());
    const updates = vi.mocked(api.bulkUpdateItems).mock.calls[0][0];
    const order = Object.fromEntries(items.map(i => [i.id, i.sortOrder]));
    for (const u of updates) order[u.id] = u.updates.sortOrder;
    // Bravo moved above Alpha; Hidden must not be left sharing a slot.
    expect(order['id-bravo']).toBe(0);
    expect(order['id-alpha']).toBe(1);
    expect(order['id-hidden']).toBe(2);
  });

  it('a cross-column drop while filtered appends after the hidden cards too', async () => {
    seq = 0;
    const items = [
      item('Mover', Status.TODO, local(2026, 1, 1), local(2026, 3, 14)),
      item('Hidden Doing', Status.IN_PROGRESS, local(2026, 1, 1), local(2026, 1, 2)),
      item('Shown Doing', Status.IN_PROGRESS, local(2026, 1, 1), local(2026, 3, 14)),
    ];
    vi.mocked(api.updateItem).mockImplementation((id, updates) => Promise.resolve({ id, ...updates } as AgEnFKItem));
    await renderBoard(items);
    chooseRange('Last 7 days');
    await waitFor(() => expect(visible('Hidden Doing')).toBe(false));

    const mover = screen.getByText('Mover').closest('[draggable="true"]') as HTMLElement;
    const ipColumn = screen.getByTestId('column-header-IN_PROGRESS').parentElement!;
    const dataTransfer = { setData: vi.fn(), getData: vi.fn((k: string) => (k === 'itemId' ? 'id-mover' : '')) };
    fireEvent.dragStart(mover, { dataTransfer });
    fireEvent.drop(ipColumn, { dataTransfer });

    await waitFor(() => expect(api.updateItem).toHaveBeenCalled());
    expect(vi.mocked(api.updateItem).mock.calls[0][1]).toEqual(
      expect.objectContaining({ status: Status.IN_PROGRESS, sortOrder: 2 }));
  });

  it('remembers the filter per project across a reload', async () => {
    const { unmount } = await renderBoard();
    chooseField('Created');
    chooseRange('Last 30 days');
    await waitFor(() => expect(visible('Stale Task')).toBe(false));
    unmount();
    queryClient.clear();

    await renderBoard(baseItems(), 'New Task');
    expect(screen.getByTestId('date-filter-chip')).toHaveTextContent('Created · Last 30 days');
    expect(visible('Stale Task')).toBe(false);
    expect(visible('New Task')).toBe(true);
  });

  it('another project\'s saved filter does not apply here', async () => {
    localStorage.setItem('agenfk_board_date_filter:p2', JSON.stringify({ field: 'updatedAt', range: { kind: 'today' } }));
    await renderBoard();
    expect(screen.queryByTestId('date-filter-chip')).toBeNull();
    expect(visible('Stale Task')).toBe(true);
  });

  it('a corrupt saved filter falls back to Any time', async () => {
    localStorage.setItem('agenfk_board_date_filter:p1', '{not json');
    await renderBoard();
    expect(screen.queryByTestId('date-filter-chip')).toBeNull();
    expect(visible('Stale Task')).toBe(true);
  });

  // ── Review round 1 ──────────────────────────────────────────────────────

  it('search prefers a match the filter shows over a hidden one, keeping the filter', async () => {
    seq = 0;
    const items = [
      item('Login fresh', Status.TODO, local(2026, 1, 1), local(2026, 3, 15, 8)),
      // IN_PROGRESS outranks TODO in search order, and the filter hides it.
      item('Login stale', Status.IN_PROGRESS, local(2026, 1, 1), local(2026, 1, 5)),
    ];
    await renderBoard(items);
    chooseRange('Today');
    await waitFor(() => expect(visible('Login stale')).toBe(false));

    const input = screen.getByPlaceholderText(/Search Item ID or Name/i);
    fireEvent.change(input, { target: { value: 'login' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(screen.getByText('1/2')).toBeDefined());
    expect(screen.getByTestId('date-filter-chip')).toHaveTextContent('Updated · Today');
    expect(visible('Login stale')).toBe(false);
  });

  it('a search that lifts the filter is announced', async () => {
    await renderBoard();
    chooseRange('Today');
    await waitFor(() => expect(visible('Stale Task')).toBe(false));
    const input = screen.getByPlaceholderText(/Search Item ID or Name/i);
    fireEvent.change(input, { target: { value: 'Stale Task' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(screen.getByTestId('date-filter-announcement')).toHaveTextContent('Date filter cleared'));
  });

  it('Trash All Archived says how many archived cards the filter hides', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderBoard();
    chooseRange('Last 7 days');
    fireEvent.click(screen.getByTestId('side-count-ARCHIVED').closest('button')!);
    fireEvent.click(await screen.findByTitle('Trash All Archived'));
    expect(confirm).toHaveBeenCalledWith('Move all 2 archived items to trash? 1 of them is hidden by the date filter.');
    expect(api.trashArchivedItems).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('Trash All Archived keeps its plain wording with no filter', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderBoard();
    fireEvent.click(screen.getByTestId('side-count-ARCHIVED').closest('button')!);
    fireEvent.click(await screen.findByTitle('Trash All Archived'));
    expect(confirm).toHaveBeenCalledWith('Move all archived items to trash?');
    confirm.mockRestore();
  });

  it('Archive Column archives only the cards the filter shows', async () => {
    await renderBoard();
    chooseRange('Last 7 days');
    await waitFor(() => expect(visible('Stale Task')).toBe(false));
    fireEvent.click(within(screen.getByTestId('column-header-TODO')).getByTitle('Archive Column'));
    await waitFor(() => expect(api.updateItem).toHaveBeenCalled());
    const archived = vi.mocked(api.updateItem).mock.calls.map(c => c[0]);
    expect(archived).toEqual(['id-fresh-task']);
  });

  it('switching project swaps in that project\'s own filter, and back', async () => {
    localStorage.setItem('agenfk_board_date_filter:p1', JSON.stringify({ field: 'updatedAt', range: { kind: 'today' } }));
    vi.mocked(api.listProjects).mockResolvedValue([
      { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() },
      { id: 'p2', name: 'P2', createdAt: new Date(), updatedAt: new Date() },
    ] as unknown as Project[]);
    const p2Items = [item('Old P2 Task', Status.TODO, local(2026, 1, 1), local(2026, 1, 2), { projectId: 'p2' })];
    vi.mocked(api.listItems).mockImplementation(((opts?: { projectId?: string }) =>
      Promise.resolve(opts?.projectId === 'p2' ? p2Items : baseItems())) as typeof api.listItems);
    localStorage.setItem('agenfk_project_id', 'p1');
    render(<KanbanBoard />, { wrapper });
    await screen.findByText('New Task');
    expect(screen.getByTestId('date-filter-chip')).toHaveTextContent('Updated · Today');

    fireEvent.click(screen.getByTitle('Switch Project'));
    fireEvent.click(await waitFor(() => document.getElementById('project-option-p2')!));
    await screen.findByText('Old P2 Task');
    expect(screen.queryByTestId('date-filter-chip')).toBeNull();

    fireEvent.click(screen.getByTitle('Switch Project'));
    fireEvent.click(await waitFor(() => document.getElementById('project-option-p1')!));
    await screen.findByText('New Task');
    expect(screen.getByTestId('date-filter-chip')).toHaveTextContent('Updated · Today');
    expect(visible('Stale Task')).toBe(false);
  });

  it('a custom range typed back to front still filters on the days between', async () => {
    await renderBoard();
    chooseRange('Custom');
    const panel = openPanel();
    fireEvent.change(within(panel).getByLabelText('From'), { target: { value: '2026-01-10' } });
    fireEvent.change(within(panel).getByLabelText('To'), { target: { value: '2026-01-01' } });
    await waitFor(() => expect(visible('Fresh Task')).toBe(false));
    expect(visible('Stale Task')).toBe(true);
  });

  it('clearing the chip hands focus back to the Date trigger', async () => {
    await renderBoard();
    chooseRange('Today');
    fireEvent.click(screen.getByRole('button', { name: 'Clear date filter' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Date filter' })));
  });

  it('the trigger points at the panel it controls', async () => {
    await renderBoard();
    const trigger = screen.getByRole('button', { name: 'Date filter' });
    fireEvent.click(trigger);
    const panel = screen.getByRole('group', { name: 'Date filter options' });
    expect(panel.id).not.toBe('');
    expect(trigger).toHaveAttribute('aria-controls', panel.id);
  });
});
