/**
 * @vitest-environment jsdom
 *
 * 3aea49f1 (CGLAB-430) — verifies running for more than 10 seconds, in any
 * project, show in the board's header; clicking one opens its card.
 *
 * User 2026-09-28: "Ongoing verify calls >10s should appear somewhere in the
 * UI so the user can click on it and open the respective card (independent of
 * project)." The header (the browser board's, which the desktop shell wraps
 * too) gets a chip - "N verifies running" - whose popover lists each: project
 * and card, step, how long, what it is doing, and the last line it printed.
 * The list comes from GET /verify-runs and is replaced by the 'verify_runs'
 * socket event.
 */
import React from 'react';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KanbanBoard } from '../components/KanbanBoard';
import { ThemeProvider } from '../ThemeContext';
import { ActiveProjectProvider } from '../ActiveProject';
import { SocketProvider } from '../SocketContext';
import { api } from '../api';
import { ItemType, Status } from '../types';

/** The socket's handlers, by event, so a test can push 'verify_runs' as the server would. */
const socketHandlers = new Map<string, (payload: unknown) => void>();
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connect: vi.fn(),
    on: vi.fn((ev: string, h: (p: unknown) => void) => { socketHandlers.set(ev, h); }),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })),
});
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const FLOW = {
  id: 'default', name: 'Default Flow', projectId: '__builtin__',
  steps: [
    { id: 's-todo', name: 'TODO', label: 'TODO', order: 1 },
    { id: 's-ip', name: 'IN_PROGRESS', label: 'IN PROGRESS', order: 2 },
    { id: 's-review', name: 'REVIEW', label: 'REVIEW', order: 3 },
    { id: 's-done', name: 'DONE', label: 'DONE', order: 5 },
  ],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(() => Promise.resolve([])),
    listItems: vi.fn(() => Promise.resolve([])),
    getItem: vi.fn(() => Promise.resolve({})),
    updateItem: vi.fn(() => Promise.resolve({})),
    getJiraStatus: vi.fn(() => Promise.resolve({ configured: false, connected: false })),
    getLatestRelease: vi.fn(() => Promise.resolve(null)),
    getVersion: vi.fn(() => Promise.resolve({ version: '1.0.0' })),
    getProjectFlow: vi.fn(() => Promise.resolve(FLOW)),
    getGitHubStatus: vi.fn(() => Promise.resolve({ configured: false })),
    getActiveRun: vi.fn(() => Promise.resolve(null)),
    listAgentRuns: vi.fn(() => Promise.resolve([])),
    listRunEvents: vi.fn(() => Promise.resolve([])),
    getGates: vi.fn(() => Promise.resolve({ step: 'IN_PROGRESS', approvalRequired: false, approvals: [], overrides: {}, lastChecks: null })),
    getCheckHistory: vi.fn(() => Promise.resolve([])),
    getVerifyRuns: vi.fn(() => Promise.resolve([])),
  },
}));

let queryClient: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <ActiveProjectProvider>
      <SocketProvider>
        <ThemeProvider>{children}</ThemeProvider>
      </SocketProvider>
    </ActiveProjectProvider>
  </QueryClientProvider>
);

const NOW = new Date();
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const P1 = { id: 'p1', name: 'Alpha', createdAt: NOW, updatedAt: NOW };
const P2 = { id: 'p2', name: 'Beta', createdAt: NOW, updatedAt: NOW };
const HERE = { id: 'card-here', projectId: 'p1', type: ItemType.TASK, title: 'Card in Alpha', status: Status.IN_PROGRESS, createdAt: NOW, updatedAt: NOW };
const THERE = { id: 'card-there', projectId: 'p2', type: ItemType.TASK, title: 'Card in Beta', status: Status.REVIEW, createdAt: NOW, updatedAt: NOW };

const run = (o: Record<string, unknown>) => ({ runId: `r-${o.itemId}`, step: 'IN_PROGRESS', phase: { state: 'running', kind: 'whole' }, ...o });

const chip = () => screen.queryByTestId('verify-runs-chip');

describe('3aea49f1: running verifies in the header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketHandlers.clear();
    localStorage.clear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    window.history.pushState({}, '', '/?project=p1');
    vi.mocked(api.listProjects).mockResolvedValue([P1, P2] as never);
    vi.mocked(api.listItems).mockImplementation(((params?: { projectId?: string }) =>
      Promise.resolve(params?.projectId === 'p2' ? [THERE] : [HERE])) as never);
    vi.mocked(api.getProjectFlow).mockResolvedValue(FLOW as never);
  });
  afterEach(() => { cleanup(); window.history.pushState({}, '', '/'); });

  it('shows no chip while no verify has run for 10 seconds', async () => {
    vi.mocked(api.getVerifyRuns).mockResolvedValue([run({ itemId: 'card-here', projectId: 'p1', projectName: 'Alpha', title: 'Card in Alpha', startedAt: ago(4) })] as never);
    render(<KanbanBoard />, { wrapper });
    await screen.findByText('Card in Alpha');
    await act(async () => { await Promise.resolve(); });
    expect(vi.mocked(api.getVerifyRuns)).toHaveBeenCalled();
    expect(chip()).toBeNull();
  });

  it('counts the verifies past 10 seconds, in any project', async () => {
    vi.mocked(api.getVerifyRuns).mockResolvedValue([
      run({ itemId: 'card-here', projectId: 'p1', projectName: 'Alpha', title: 'Card in Alpha', startedAt: ago(42) }),
      run({ itemId: 'card-there', projectId: 'p2', projectName: 'Beta', title: 'Card in Beta', step: 'REVIEW', startedAt: ago(15) }),
      run({ itemId: 'card-new', projectId: 'p2', projectName: 'Beta', title: 'Just started', startedAt: ago(2) }),
    ] as never);
    render(<KanbanBoard />, { wrapper });
    expect((await screen.findByTestId('verify-runs-chip')).textContent).toMatch(/2 verifies running/);
  });

  it('says "1 verify running" for one', async () => {
    vi.mocked(api.getVerifyRuns).mockResolvedValue([run({ itemId: 'card-there', projectId: 'p2', projectName: 'Beta', title: 'Card in Beta', startedAt: ago(30) })] as never);
    render(<KanbanBoard />, { wrapper });
    expect((await screen.findByTestId('verify-runs-chip')).textContent).toMatch(/1 verify running/);
  });

  it('lists each with its project, card, step, time and what it is doing', async () => {
    vi.mocked(api.getVerifyRuns).mockResolvedValue([
      run({ itemId: 'a', projectId: 'p1', projectName: 'Alpha', title: 'Queued card', startedAt: ago(20), phase: { state: 'queued', ahead: 2 } }),
      run({ itemId: 'b', projectId: 'p1', projectName: 'Alpha', title: 'Whole card', startedAt: ago(65), lastLine: '✓ 12 tests passed' }),
      run({ itemId: 'c', projectId: 'p2', projectName: 'Beta', title: 'Affected card', startedAt: ago(20), phase: { state: 'running', kind: 'affected', files: 3 } }),
      run({ itemId: 'd', projectId: 'p2', projectName: 'Beta', title: 'Person card', step: 'DISCOVERY', startedAt: ago(20), phase: { state: 'awaiting-person' } }),
    ] as never);
    render(<KanbanBoard />, { wrapper });
    fireEvent.click(await screen.findByTestId('verify-runs-chip'));
    const pop = await screen.findByTestId('verify-runs-list');
    const row = (title: string) => within(pop).getByText(title, { exact: false }).closest('[data-testid="verify-run-entry"]') as HTMLElement;
    expect(row('Queued card').textContent).toMatch(/Alpha/);
    expect(row('Queued card').textContent).toMatch(/waiting for a suite-run slot: 2 ahead/);
    expect(row('Whole card').textContent).toMatch(/IN_PROGRESS/);
    expect(row('Whole card').textContent).toMatch(/running the whole suite/);
    expect(row('Whole card').textContent).toMatch(/1m [5-9]s/);
    expect(row('Whole card').textContent).toMatch(/✓ 12 tests passed/);
    expect(row('Affected card').textContent).toMatch(/affected tests only: 3 files/);
    expect(row('Person card').textContent).toMatch(/waiting on a person/);
  });

  it('follows the socket: a pushed list replaces what it shows', async () => {
    vi.mocked(api.getVerifyRuns).mockResolvedValue([run({ itemId: 'card-here', projectId: 'p1', projectName: 'Alpha', title: 'Card in Alpha', startedAt: ago(30) })] as never);
    render(<KanbanBoard />, { wrapper });
    expect((await screen.findByTestId('verify-runs-chip')).textContent).toMatch(/1 verify running/);
    const push = socketHandlers.get('verify_runs');
    expect(push, "the board listens for 'verify_runs'").toBeTypeOf('function');
    // The query cache tells its observers on the next tick.
    await act(async () => { push!([]); await new Promise(r => setTimeout(r, 0)); });
    expect(chip()).toBeNull();
    await act(async () => { push!([
      run({ itemId: 'x', projectId: 'p1', projectName: 'Alpha', title: 'X', startedAt: ago(30) }),
      run({ itemId: 'y', projectId: 'p2', projectName: 'Beta', title: 'Y', startedAt: ago(31) }),
    ]); await new Promise(r => setTimeout(r, 0)); });
    expect(chip()?.textContent).toMatch(/2 verifies running/);
  });

  it('closes the list on Escape', async () => {
    vi.mocked(api.getVerifyRuns).mockResolvedValue([run({ itemId: 'card-there', projectId: 'p2', projectName: 'Beta', title: 'Card in Beta', startedAt: ago(30) })] as never);
    render(<KanbanBoard />, { wrapper });
    const button = await screen.findByTestId('verify-runs-chip');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await screen.findByTestId('verify-runs-list');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('verify-runs-list')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // beae41a0: focus goes back to the chip, not to the page.
    expect(document.activeElement).toBe(button);
  });

  // beae41a0: a disclosure - a button that shows a list - not a dialog that never takes focus.
  it('is a disclosure: the button controls the list, and nothing claims to be a dialog', async () => {
    vi.mocked(api.getVerifyRuns).mockResolvedValue([run({ itemId: 'card-there', projectId: 'p2', projectName: 'Beta', title: 'Card in Beta', startedAt: ago(30) })] as never);
    render(<KanbanBoard />, { wrapper });
    const button = await screen.findByTestId('verify-runs-chip');
    expect(button.getAttribute('aria-haspopup')).toBeNull();
    fireEvent.click(button);
    const list = await screen.findByTestId('verify-runs-list');
    expect(button.getAttribute('aria-controls')).toBe(list.id);
    expect(screen.queryByRole('dialog')).toBeNull();
    // 2ec08b41: a label on a plain div is read by nothing; a region carries it.
    expect(screen.getByRole('region', { name: /verifies running/i })).toBe(list);
  });

  // beae41a0: after a server restart or a dropped connection, what was pushed meanwhile is gone - read it again.
  it('reads the list again when the socket (re)connects', async () => {
    vi.mocked(api.getVerifyRuns).mockResolvedValue([run({ itemId: 'card-there', projectId: 'p2', projectName: 'Beta', title: 'Card in Beta', startedAt: ago(30) })] as never);
    render(<KanbanBoard />, { wrapper });
    await screen.findByTestId('verify-runs-chip');
    vi.mocked(api.getVerifyRuns).mockResolvedValue([] as never);
    const connect = socketHandlers.get('connect');
    expect(connect, "the chip listens for 'connect'").toBeTypeOf('function');
    await act(async () => { connect!(undefined); await new Promise(r => setTimeout(r, 0)); });
    expect(chip()).toBeNull();
  });

  // Found in the browser check: open when the last run ended, the list came back open with the next one, unasked.
  it('a list left open when the runs ended stays closed when a new one appears', async () => {
    vi.mocked(api.getVerifyRuns).mockResolvedValue([run({ itemId: 'card-there', projectId: 'p2', projectName: 'Beta', title: 'Card in Beta', startedAt: ago(30) })] as never);
    render(<KanbanBoard />, { wrapper });
    fireEvent.click(await screen.findByTestId('verify-runs-chip'));
    await screen.findByTestId('verify-runs-list');
    const push = socketHandlers.get('verify_runs')!;
    await act(async () => { push([]); await new Promise(r => setTimeout(r, 0)); });
    expect(chip()).toBeNull();
    await act(async () => { push([run({ itemId: 'z', projectId: 'p1', projectName: 'Alpha', title: 'Z', startedAt: ago(20) })]); await new Promise(r => setTimeout(r, 0)); });
    expect(chip()?.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('verify-runs-list')).toBeNull();
  });

  it("clicking one in another project switches to it and opens the card on its Overview", async () => {
    vi.mocked(api.getVerifyRuns).mockResolvedValue([run({ itemId: 'card-there', projectId: 'p2', projectName: 'Beta', title: 'Card in Beta', step: 'REVIEW', startedAt: ago(30) })] as never);
    render(<KanbanBoard />, { wrapper });
    await screen.findByText('Card in Alpha');
    fireEvent.click(await screen.findByTestId('verify-runs-chip'));
    const pop = await screen.findByTestId('verify-runs-list');
    fireEvent.click(within(pop).getByText('Card in Beta', { exact: false }));
    // The board now shows Beta, with THAT card's detail open on Overview.
    expect(await screen.findByRole('button', { name: /Overview/ }, { timeout: 3000 })).toBeDefined();
    // The detail's header names the card by its id's first 8 characters; the board card shows only 4.
    expect(await screen.findByText(/card-the/, {}, { timeout: 3000 })).toBeDefined();
    expect(vi.mocked(api.listItems)).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p2' }));
    expect(screen.queryByTestId('verify-runs-list')).toBeNull();
  });
});
