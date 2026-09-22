/**
 * @vitest-environment jsdom
 *
 * The door in the empty picker has to open onto something (CGLAB-164).
 *
 * `CardPicker.test.tsx` renders the picker on its own and asserts `onCreateCard`
 * was called. That is the exact shape of verification this repo has already
 * been burned by: FleetSheet's tests checked `onLaunch` got the right ids and
 * stopped at the component boundary, while the shell's handler dropped two of
 * the three. Complete at both ends, disconnected in the middle.
 *
 * So this file drives the real shell to the empty picker — the reachable state
 * a terminal outliving its card leaves behind — presses the new door, and
 * checks what a person would see happen: the dialog closes and the app is
 * actually asked for a new card in the project the shell is on.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { AppShell } from '../components/AppShell';
import { ActiveProjectProvider, useActiveProject } from '../ActiveProject';
import { SocketProvider } from '../SocketContext';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(async () => [
      { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
    ]),
    listItems: vi.fn(async () => []),
    listActiveItems: vi.fn(async () => []),
    listRuns: vi.fn(async () => []),
    listAgentRuns: vi.fn(async () => []),
    listRunEvents: vi.fn(async () => []),
    getVersion: vi.fn(async () => ({ version: '1.1.18' })),
    getReadme: vi.fn(async () => ({ content: '' })),
    getLatestRelease: vi.fn(async () => null),
    updateItem: vi.fn(async () => ({})),
    getSettings: vi.fn(async () => ({ tmuxByDefault: false })),
    updateSettings: vi.fn(async () => ({ tmuxByDefault: false })),
    listTerminalSessions: vi.fn(async () => []),
    recordTerminalSession: vi.fn(async () => ({ id: 'row-1' })),
    forgetTerminalSession: vi.fn(async () => {}),
    getGitStatus: vi.fn(async () => ({ changed: 0, staged: 0, files: [] })),
  },
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connected: true, connect: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn(),
  })),
}));

let spawnCalls: Array<Record<string, unknown>>;

const setBridge = () => {
  spawnCalls = [];
  Object.defineProperty(window, 'agenfkDesktop', {
    value: {
      isDesktop: true, platform: 'darwin',
      versions: { electron: '40', chrome: '1', node: '24' },
      prefs: { get: async () => ({ autoApprove: false }), setAutoApprove: async () => ({ autoApprove: false }) },
      terminal: {
        spawn: async (req: Record<string, unknown>) => {
          spawnCalls.push(req);
          return { sessionId: `pty-${spawnCalls.length}`, agentSessionId: undefined };
        },
        write: async () => true,
        resize: async () => true,
        kill: async () => true,
        onData: () => () => {},
        onActivity: () => () => {},
        onExit: () => () => {},
        listAgents: async () => [
          { id: 'claude-code', label: 'Claude Code', installed: true, supportsAutoApprove: true },
        ],
        refreshAgents: async () => [],
        sessionPersistence: async () => ({ available: false }),
      },
    },
    configurable: true, writable: true,
  });
};

/**
 * Reads the context the door is supposed to write to.
 *
 * `requestNewItem` is the app's existing route to a blank card — the sidebar's
 * `+` uses it and `KanbanBoard` turns it into the draft modal. Watching the
 * value it sets is what proves the door was wired to that route rather than to
 * a handler of its own that quietly does nothing.
 */
const Probe: React.FC = () => {
  const { newItemRequest, activeProjectId, newItemTitle } = useActiveProject();
  return (
    <>
      <div data-testid="probe">{newItemRequest ?? 'none'}|{activeProjectId ?? 'none'}</div>
      <div data-testid="probe-title">{newItemTitle ?? 'none'}</div>
    </>
  );
};

const restored = [{
  id: 'row-1', itemId: 'i1', projectId: 'p1', agentId: 'claude-code',
  itemTitle: 'Something in agenfk', openedAt: new Date().toISOString(),
}];

beforeEach(() => {
  localStorage.clear();
  // The app remembers the project you were last in, and the door needs one:
  // a card has to be created SOMEWHERE. Seeded the way the app seeds it
  // rather than clicked through the sidebar, so the test is about the door.
  localStorage.setItem('agenfk_project_id', 'p1');
  vi.clearAllMocks();
  vi.mocked(api.listProjects).mockResolvedValue([
    { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
  ] as never);
  vi.mocked(api.getSettings).mockResolvedValue({ tmuxByDefault: false } as never);
  vi.mocked(api.recordTerminalSession).mockResolvedValue({ id: 'row-1' } as never);
  vi.mocked(api.forgetTerminalSession).mockResolvedValue(undefined as never);
  // The reachable empty state: nothing in an active step, a terminal that
  // outlived the card it was opened on.
  vi.mocked(api.listActiveItems).mockResolvedValue([] as never);
  vi.mocked(api.listTerminalSessions).mockResolvedValue(restored as never);
  setBridge();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(q => ({
      matches: false, media: q, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).agenfkDesktop;
});

const renderShell = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ActiveProjectProvider>
      <SocketProvider>
        <AppShell><Probe /></AppShell>
      </SocketProvider>
    </ActiveProjectProvider>
  </QueryClientProvider>,
);

/** The same picker, but with work in flight — the ordinary case. */
const openThePickerWithCards = async () => {
  vi.mocked(api.listActiveItems).mockResolvedValue([
    { id: 'c1', projectId: 'p1', type: 'TASK', title: 'A card in flight', status: 'IN_PROGRESS' },
  ] as never);
  return openTheEmptyPicker();
};

const openTheEmptyPicker = async () => {
  renderShell();
  await waitFor(() => expect(spawnCalls.length).toBe(1));
  fireEvent.click((await screen.findAllByTestId('process-open'))[0]);
  await waitFor(() =>
    expect(document.getElementById('panel-terminal')!.hasAttribute('hidden')).toBe(false));
  fireEvent.click(await screen.findByRole('button', { name: /new terminal/i }));
  return screen.findByRole('dialog', { name: /which card/i });
};

describe('Create a card, from the empty picker', () => {
  it('asks the app for a new card in the project the shell is on', async () => {
    const picker = await openTheEmptyPicker();
    expect(picker.textContent).toMatch(/no work in flight/i);
    fireEvent.click(await screen.findByRole('button', { name: /new task/i }));
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toMatch(/^p1#\d+\|p1$/));
  });

  it('closes the picker on the way, instead of leaving it over the board', async () => {
    // The draft opens on the board. A dialog left on top of it is the same
    // dead-end the picker had before, with an extra step.
    await openTheEmptyPicker();
    fireEvent.click(await screen.findByRole('button', { name: /new task/i }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /which card/i })).toBeNull());
  });

  it('creates the card for the TERMINAL you are looking at, not for the sidebar selection', async () => {
    /*
     * Precedence, and the first version had it backwards.
     *
     * The board is on "agenfk" while the terminal in front of you belongs to
     * "horizon-lab". This picker is opened FROM the terminal strip and every
     * row in it is about that terminal's world; pressing Create a card here
     * means "a card for this thing I am looking at". Preferring the sidebar's
     * selection filed it in the other repo AND re-pointed the board to follow
     * — so the person lands somewhere they did not ask for, holding a card
     * they now have to move.
     */
    localStorage.setItem('agenfk_project_id', 'p1');
    vi.mocked(api.listProjects).mockResolvedValue([
      { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
      { id: 'p2', name: 'horizon-lab', createdAt: new Date(), updatedAt: new Date() },
    ] as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(
      [{ ...restored[0], projectId: 'p2' }] as never,
    );
    await openTheEmptyPicker();
    fireEvent.click(await screen.findByRole('button', { name: /new task/i }));
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toMatch(/^p2#\d+\|p2$/));
  });

  it('falls back to the remembered project when the row carries an EMPTY project, not just a missing one', async () => {
    /*
     * `??` only steps aside for null and undefined, so a row that arrived with
     * `projectId: ''` — off-type, but it comes over the wire — short-circuited
     * to the empty string and then failed the truthiness check that decides
     * whether the door is drawn. The door vanished on a screen where the app
     * plainly knew which project was open.
     */
    localStorage.setItem('agenfk_project_id', 'p1');
    vi.mocked(api.listTerminalSessions).mockResolvedValue(
      [{ ...restored[0], projectId: '' }] as never,
    );
    await openTheEmptyPicker();
    fireEvent.click(await screen.findByRole('button', { name: /new task/i }));
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toMatch(/^p1#\d+\|p1$/));
  });

  it('falls back to the remembered project when the terminal row has none', async () => {
    /*
     * The other half of the precedence rule. A restored row without a project
     * — and there are such rows — must not leave the door hidden when the app
     * plainly knows which project is open.
     */
    localStorage.setItem('agenfk_project_id', 'p1');
    vi.mocked(api.listTerminalSessions).mockResolvedValue(
      [{ ...restored[0], projectId: undefined }] as never,
    );
    await openTheEmptyPicker();
    fireEvent.click(await screen.findByRole('button', { name: /new task/i }));
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toMatch(/^p1#\d+\|p1$/));
  });

  it('still opens onto a project on a first launch, where none is remembered yet', async () => {
    /*
     * A fresh profile with remembered terminals: restoring a terminal does NOT
     * select a project — only opening one does (`requestTerminal`) — so the
     * app arrives in the Terminal view with nothing active, and the door would
     * be hidden exactly where the person has the fewest other routes to a
     * card. The terminal on screen knows its project; that is the one.
     */
    localStorage.clear();
    await openTheEmptyPicker();
    fireEvent.click(await screen.findByRole('button', { name: /new task/i }));
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toMatch(/^p1#\d+\|p1$/));
  });

  it('draws no create door at all when there is genuinely nowhere to put a card', async () => {
    /*
     * The branch that decides whether a door gets drawn onto nothing, driven
     * through the real shell: no remembered project AND a restored terminal
     * whose row carries no project either. The picker must then fall back to
     * the sentence alone rather than offering to create a card into thin air.
     */
    localStorage.clear();
    vi.mocked(api.listTerminalSessions).mockResolvedValue(
      [{ ...restored[0], projectId: undefined }] as never,
    );
    const picker = await openTheEmptyPicker();
    expect(picker.textContent).toMatch(/no work in flight/i);
    expect(screen.queryByRole('button', { name: /new task/i })).toBeNull();
  });

  it('carries the phrase that was typed all the way to the draft', async () => {
    /*
     * End to end, because the component test can only prove the picker HANDS
     * the phrase over — the defect being fixed is that the shell dropped it on
     * the floor and opened an empty Title.
     *
     * The list here has cards in it; the search is what empties it, which is
     * the exact moment someone has already written what they want.
     */
    localStorage.setItem('agenfk_project_id', 'p1');
    vi.mocked(api.listActiveItems).mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        id: `x${i}`, projectId: 'p1', type: 'TASK', title: `Card number ${i}`, status: 'IN_PROGRESS',
      })) as never,
    );
    await openTheEmptyPicker();
    fireEvent.change(await screen.findByRole('searchbox', { name: /search cards/i }), {
      target: { value: 'fix the picker dismiss' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /new task/i }));
    await waitFor(() =>
      expect(screen.getByTestId('probe-title').textContent).toBe('fix the picker dismiss'));
  });

  /*
   * This assertion used to read "leaves Ask AgEnFK inert, because nothing is
   * behind it yet", and it was right for three cards. There is a room behind
   * the door now — the contract, the review route and the panel — so the claim
   * moves to the thing that has to stay true either way: the door works or it
   * explains itself, and never pretends.
   */
  /*
   * WHERE THE DOOR HAD TO MOVE. It was drawn only in the empty state — which
   * is where the artifact draws it — and that made it unreachable on any
   * machine with work in flight, which is every machine that has been used.
   * The person with twenty cards and a new objective is exactly who needs it.
   */
  it('offers Ask AgEnFK under a list that HAS cards', async () => {
    await openThePickerWithCards();
    const door = await screen.findByTestId('ask-agenfk-footer');
    fireEvent.click(door);
    expect(await screen.findByTestId('ask-agenfk')).toBeDefined();
  });

  it('opens the Ask AgEnFK panel from the shell, not just in the component test', async () => {
    await openTheEmptyPicker();
    // By testid, not by name: the empty state and the footer BOTH offer the
    // door now, so a name query finds two.
    const ask = await screen.findByTestId('ask-agenfk-door') as HTMLButtonElement;
    expect(ask.disabled).toBe(false);
    fireEvent.click(ask);
    // The panel, and the picker gone from under it.
    expect(await screen.findByTestId('ask-agenfk')).toBeDefined();
    expect(screen.queryByRole('searchbox', { name: /search cards/i })).toBeNull();
  });
});
