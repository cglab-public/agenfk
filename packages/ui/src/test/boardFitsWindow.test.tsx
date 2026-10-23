/**
 * #262 - the board fits the window: step columns share the width down to a 120px floor (96px compact),
 * the side columns stay collapsed strips until expanded, and both choices are remembered per viewer.
 * Harness from boardSettings.test.tsx.
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import { KanbanBoard } from '../components/KanbanBoard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { ActiveProjectProvider, useActiveProject } from '../ActiveProject';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { ItemType, Status } from '../types';
import { io } from 'socket.io-client';
import { SocketProvider } from '../SocketContext';

// Mock socket.io-client. Handlers are recorded rather than dropped so a test
// can fire a server event — `project_switched` in particular, since the pin
// exists to suppress exactly that and nothing else proves it does.
const socketHandlers: Record<string, (payload: unknown) => void> = {};
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connected: true,
    connect: vi.fn(),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => { socketHandlers[event] = handler; }),
    off: vi.fn((event: string) => { delete socketHandlers[event]; }),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

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
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

// Default flow used in tests — uses Status names as labels to keep column header assertions stable
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
    getSettings: vi.fn(() => Promise.resolve({ tmuxByDefault: false, attentionAlerts: true, attentionSound: true, soundTiming: 'unfocused', osNotifications: true, maxConcurrentSuiteRuns: 0 })),
    updateSettings: vi.fn((patch: any) => Promise.resolve(patch)),
    getSettingsRuntime: vi.fn(() => Promise.resolve({ cpus: 8, automaticSuiteRuns: 4, suiteRunLimit: 4 })),
    getGitHubAccount: vi.fn(() => Promise.resolve({ connected: false, reason: 'not_authenticated' })),
    getTelemetryConfig: vi.fn(() => Promise.resolve({ telemetryEnabled: true, installationId: 'i' })),
    setTelemetryConfig: vi.fn((enabled: boolean) => Promise.resolve({ telemetryEnabled: enabled })),
  }
}));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: 0 },
  },
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <ActiveProjectProvider>
    <ThemeProvider>
      {children}
    </ThemeProvider>
    </ActiveProjectProvider>
  </QueryClientProvider>
);


// An 8-step flow, as TDD Flow+RFC: the case that scrolled sideways.
const EIGHT_STEP_FLOW = {
  ...DEFAULT_FLOW_MOCK,
  id: 'tdd', name: 'TDD Flow+RFC',
  steps: ['TODO', 'DISCOVERY', 'RFC_APPROVAL', 'CREATE_UNIT_TESTS', 'IN_PROGRESS', 'REFACTOR', 'REVIEW', 'DONE']
    .map((name, order) => ({ id: `s-${name}`, name, label: name, order, ...(name === 'TODO' || name === 'DONE' ? { isAnchor: true } : {}) })),
};

describe('the board fits the window (#262)', () => {
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); queryClient.clear();
    vi.mocked(api.getProjectFlow).mockResolvedValue(EIGHT_STEP_FLOW as any);
    vi.mocked(api.listProjects).mockResolvedValue([{ id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() }] as any);
    localStorage.setItem('agenfk_project_id', 'p1');
  });
  afterEach(() => cleanup());

  it('gives every step column a 120px floor, not 180px, so eight steps fit a laptop window', async () => {
    render(<KanbanBoard />, { wrapper });
    const column = await screen.findByTestId('column-REVIEW');
    expect(column.className).toMatch(/md:min-w-\[120px\]/);
    expect(column.className).not.toMatch(/md:min-w-\[180px\]/);
    for (const name of EIGHT_STEP_FLOW.steps.map(s => s.name)) expect(screen.getByTestId(`column-${name}`).className).toMatch(/md:flex-1/);
  });

  it('a compact toggle narrows the floor to 96px and tightens the cards, and is remembered', async () => {
    vi.mocked(api.listItems).mockResolvedValue([{ id: 'c1', projectId: 'p1', type: ItemType.TASK, title: 'A card under review', status: 'REVIEW', createdAt: new Date(), updatedAt: new Date() }] as any);
    const { unmount } = render(<KanbanBoard />, { wrapper });
    const card = () => screen.getByText('A card under review').closest('[draggable]') as HTMLElement;
    await screen.findByText('A card under review');
    expect(card().className).not.toMatch(/md:p-2/);
    const toggle = await screen.findByTestId('board-compact-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('column-REVIEW').className).toMatch(/md:min-w-\[96px\]/));
    // Tighter on the desktop board; the stacked mobile layout keeps its padding.
    expect(card().className).toMatch(/md:p-2/);
    expect(card().className).toMatch(/(^| )p-3( |$)/);
    expect(screen.getByTestId('board-compact-toggle').getAttribute('aria-pressed')).toBe('true');
    unmount();
    render(<KanbanBoard />, { wrapper });
    await waitFor(() => expect(screen.getByTestId('column-REVIEW').className).toMatch(/md:min-w-\[96px\]/));
  });

  it('the side columns start collapsed, and an expanded one stays expanded next time', async () => {
    const { unmount } = render(<KanbanBoard />, { wrapper });
    const pausedStrip = await screen.findByTestId('collapsed-PAUSED');
    expect(screen.getByTestId('ideas-collapsed-button')).toBeTruthy();
    fireEvent.click(pausedStrip);
    await waitFor(() => expect(screen.queryByTestId('collapsed-PAUSED')).toBeNull());
    unmount();
    render(<KanbanBoard />, { wrapper });
    await screen.findByTestId('column-REVIEW');
    expect(screen.queryByTestId('collapsed-PAUSED')).toBeNull();
    // The others were never touched: still strips.
    expect(screen.getByTestId('collapsed-BLOCKED')).toBeTruthy();
    expect(screen.getByTestId('ideas-collapsed-button')).toBeTruthy();
  });
});

// Review of #262: expanded side columns keep their 180px floor - their headers need it.
describe('expanded side columns (#262 review)', () => {
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); queryClient.clear();
    vi.mocked(api.getProjectFlow).mockResolvedValue(EIGHT_STEP_FLOW as any);
    vi.mocked(api.listProjects).mockResolvedValue([{ id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() }] as any);
    localStorage.setItem('agenfk_project_id', 'p1');
  });
  afterEach(() => cleanup());

  it('an expanded Paused column keeps a 180px floor, in compact mode too', async () => {
    localStorage.setItem('agenfk_board_layout', JSON.stringify({ compact: true, collapsed: { ideas: true, paused: false, blocked: true, archived: true } }));
    render(<KanbanBoard />, { wrapper });
    const count = await screen.findByTestId('side-count-PAUSED');
    const column = count.closest('.flex-col.w-full') as HTMLElement;
    expect(column.className).toMatch(/md:min-w-\[180px\]/);
  });
});
