/**
 * 7b640e64 (boardSettings.test.tsx, harness from KanbanBoard.test.tsx).
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


describe('the browser board reaches Settings (7b640e64)', () => {
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); queryClient.clear();
    vi.mocked(api.getProjectFlow).mockResolvedValue(DEFAULT_FLOW_MOCK as any);
    // The toolbar belongs to a loaded project, as on a real board.
    vi.mocked(api.listProjects).mockResolvedValue([{ id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() }] as any);
    localStorage.setItem('agenfk_project_id', 'p1');
  });
  afterEach(() => cleanup());

  it('has a Settings button that opens the settings in a dialog, Verification included', async () => {
    render(<KanbanBoard />, { wrapper });
    fireEvent.click(await screen.findByTestId('board-settings-btn'));
    const dialog = await screen.findByRole('dialog', { name: /settings/i });
    expect(within(dialog).getByRole('button', { name: /Verification/ })).toBeTruthy();
  });

  it('closes with Escape', async () => {
    render(<KanbanBoard />, { wrapper });
    fireEvent.click(await screen.findByTestId('board-settings-btn'));
    const dialog = await screen.findByRole('dialog', { name: /settings/i });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /settings/i })).toBeNull());
  });

  /*
   * User 2026-09-29: the dialog changed height with every section. Every
   * section now stays in one cell, so the body is always the tallest one's
   * height (capped at the viewport, scrolling inside); only the current one
   * can be read or reached. jsdom has no layout: the height itself is checked
   * in a browser, this pins the structure that gives it.
   */
  it('keeps every section in place while one is shown, so its height never changes', async () => {
    render(<KanbanBoard />, { wrapper });
    fireEvent.click(await screen.findByTestId('board-settings-btn'));
    const dialog = await screen.findByRole('dialog', { name: /settings/i });
    const rail = within(dialog).getByRole('navigation', { name: /settings sections/i });
    const panes = () => Array.from(dialog.querySelectorAll<HTMLElement>('[data-testid="settings-pane"]'));
    const before = panes();
    expect(before).toHaveLength(within(rail).getAllByRole('button').length);
    const shown = () => panes().filter(p => p.getAttribute('aria-hidden') !== 'true');
    expect(shown()).toHaveLength(1);
    fireEvent.click(within(rail).getByRole('button', { name: /Verification/ }));
    // The same elements, not re-mounted ones: switching changes which one shows, nothing else.
    expect(panes()).toEqual(before);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toHaveTextContent(/Suite runs at once/);
  });

  /*
   * User 2026-09-29 (d8bda14f): in dark mode the dialog's edge could not be
   * seen - it was filled with the board's own colour (bg-canvas), outlined at
   * 10% and set over an unblurred 40% backdrop. It now wears the Org Flows
   * picker's frame (fill, outline, shadow) over the GitHub Import modal's
   * blurred backdrop. jsdom computes no colours: contrast is checked in a
   * browser, this pins the frame that gives it.
   */
  it("stands out from the board: the Org Flows picker's frame over the Import modal's blurred backdrop", async () => {
    render(<KanbanBoard />, { wrapper });
    fireEvent.click(await screen.findByTestId('board-settings-btn'));
    const backdrop = await screen.findByRole('dialog', { name: /settings/i });
    const panel = backdrop.firstElementChild as HTMLElement;
    for (const c of ['bg-black/50', 'backdrop-blur-sm']) expect(backdrop).toHaveClass(c);
    // CGLAB-434: the raised-surface token, which sits a step above the board's canvas in both themes.
    for (const c of ['bg-surface', 'border', 'border-slate-200', 'dark:border-slate-700', 'shadow-2xl']) {
      expect(panel).toHaveClass(c);
    }
    expect(panel).not.toHaveClass('bg-canvas'); // the board's own colour
    expect(panel.className).not.toMatch(/(?:^|\s)dark:bg-/); // a dark twin would override the token
  });

  it('the sections not shown cannot be reached: hidden from assistive tech and inert', async () => {
    render(<KanbanBoard />, { wrapper });
    fireEvent.click(await screen.findByTestId('board-settings-btn'));
    const dialog = await screen.findByRole('dialog', { name: /settings/i });
    const hidden = Array.from(dialog.querySelectorAll<HTMLElement>('[data-testid="settings-pane"][aria-hidden="true"]'));
    expect(hidden.length).toBeGreaterThan(0);
    for (const p of hidden) expect(p.hasAttribute('inert')).toBe(true);
    expect(within(dialog).queryByText(/Suite runs at once/)).not.toBeNull();   // mounted, for its height
    expect(within(dialog).queryByRole('combobox', { name: /suite runs at once/i })).toBeNull();   // but not reachable
  });
});

