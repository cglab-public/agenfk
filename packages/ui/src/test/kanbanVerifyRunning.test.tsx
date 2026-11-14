/**
 * @vitest-environment jsdom
 *
 * 9569b4d7 — a background verify used to be invisible on the board: the run
 * lived only in the server's memory. The card now says so, animated, while it
 * runs (item.activeRun), and its Overview shows the run's latest output.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { KanbanBoard } from '../components/KanbanBoard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { ActiveProjectProvider } from '../ActiveProject';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { ItemType, Status } from '../types';

// Mock socket.io-client
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connect: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
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

// Mock scrollIntoView (jsdom has no layout)
window.HTMLElement.prototype.scrollIntoView = vi.fn();

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
    getActiveRun: vi.fn(() => Promise.resolve(null)),
    listAgentRuns: vi.fn(() => Promise.resolve([])),
    listRunEvents: vi.fn(() => Promise.resolve([])),
    getGates: vi.fn(() => Promise.resolve({ step: 'IN_PROGRESS', approvalRequired: false, approvals: [], overrides: {}, lastChecks: null })),
    getCheckHistory: vi.fn(() => Promise.resolve([])),
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

const NOW = new Date();
const project = { id: 'p1', name: 'P1', createdAt: NOW, updatedAt: NOW };
const RUN = { runId: 'run-1', step: 'IN_PROGRESS', startedAt: new Date(Date.now() - 5_000).toISOString() };
const RUNNING = { id: 'task-run', projectId: 'p1', type: ItemType.TASK, title: 'Running card', status: Status.IN_PROGRESS, createdAt: NOW, updatedAt: NOW, activeRun: RUN };
const IDLE = { id: 'task-idle', projectId: 'p1', type: ItemType.TASK, title: 'Idle card', status: Status.IN_PROGRESS, createdAt: NOW, updatedAt: NOW };

describe('9569b4d7: a running verify shows on the board', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    queryClient.clear();
    window.history.pushState({}, '', '/?project=p1');
    vi.mocked(api.getProjectFlow).mockResolvedValue(DEFAULT_FLOW_MOCK as never);
    vi.mocked(api.listProjects).mockResolvedValue([project] as never);
    vi.mocked(api.listItems).mockResolvedValue([RUNNING, IDLE] as never);
  });
  afterEach(() => { cleanup(); window.history.pushState({}, '', '/'); });

  it('puts the animated badge on the card itself, with the card closed', async () => {
    render(<KanbanBoard />, { wrapper });
    await screen.findByText('Running card');
    const running = document.getElementById('card-task-run')!;
    const idle = document.getElementById('card-task-idle')!;
    expect(running.querySelector('[data-testid="verify-running"]')).not.toBeNull();
    expect(idle.querySelector('[data-testid="verify-running"]')).toBeNull();
  });

  it("shows the run's latest output on the card's Overview while it runs", async () => {
    vi.mocked(api.getActiveRun).mockResolvedValue({ ...RUN, output: 'line one\n ✓ packages/server/src/test/foo.test.ts (3 tests)\n' });
    window.history.pushState({}, '', '/?item=task-run&project=p1&view=overview');
    render(<KanbanBoard />, { wrapper });
    expect(await screen.findByText(/packages\/server\/src\/test\/foo\.test\.ts/, {}, { timeout: 3000 })).toBeDefined();
    expect(vi.mocked(api.getActiveRun)).toHaveBeenCalledWith('task-run');
  });

  it("keys the Overview's output by run, so a new run never shows the last one's output", async () => {
    vi.mocked(api.getActiveRun).mockResolvedValue({ ...RUN, output: 'first run output' });
    window.history.pushState({}, '', '/?item=task-run&project=p1&view=overview');
    render(<KanbanBoard />, { wrapper });
    expect(await screen.findByText(/first run output/, {}, { timeout: 3000 })).toBeDefined();
    expect(queryClient.getQueryCache().findAll({ queryKey: ['active-run', 'task-run', 'run-1'] })).toHaveLength(1);
  });

  it('asks for no output when nothing runs', async () => {
    window.history.pushState({}, '', '/?item=task-idle&project=p1&view=overview');
    render(<KanbanBoard />, { wrapper });
    await screen.findByRole('button', { name: /Overview/ }, { timeout: 3000 });
    expect(vi.mocked(api.getActiveRun)).not.toHaveBeenCalled();
  });
});
