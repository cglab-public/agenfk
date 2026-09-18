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
  const { newItemRequest, activeProjectId } = useActiveProject();
  return <div data-testid="probe">{newItemRequest ?? 'none'}|{activeProjectId ?? 'none'}</div>;
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
    fireEvent.click(await screen.findByRole('button', { name: /create a card/i }));
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toMatch(/^p1#\d+\|p1$/));
  });

  it('closes the picker on the way, instead of leaving it over the board', async () => {
    // The draft opens on the board. A dialog left on top of it is the same
    // dead-end the picker had before, with an extra step.
    await openTheEmptyPicker();
    fireEvent.click(await screen.findByRole('button', { name: /create a card/i }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /which card/i })).toBeNull());
  });

  it('still opens onto a project on a first launch, where none is remembered yet', async () => {
    /*
     * The case that made this test file seed a project in the first place, and
     * the reason it is not seeded here: restoring a terminal does NOT select a
     * project — only opening one does (`requestTerminal`) — so a fresh profile
     * with remembered terminals arrives in the Terminal view with nothing
     * active, and the door would be hidden exactly where the person has the
     * fewest other routes to a card.
     *
     * The terminal on screen knows which project it belongs to. That is the
     * project the card goes in.
     */
    localStorage.clear();
    await openTheEmptyPicker();
    fireEvent.click(await screen.findByRole('button', { name: /create a card/i }));
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
    expect(screen.queryByRole('button', { name: /create a card/i })).toBeNull();
  });

  it('leaves Ask AgEnFK inert, because nothing is behind it yet', async () => {
    // Disabled in the shell too, not merely in the component's own test: this
    // is the one control here that must not appear to work.
    await openTheEmptyPicker();
    const ask = await screen.findByRole('button', { name: /ask agenfk/i }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    fireEvent.click(ask);
    expect(screen.getByTestId('probe').textContent).toMatch(/^none\|/);
  });
});
