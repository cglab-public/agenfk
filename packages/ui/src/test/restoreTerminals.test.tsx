/**
 * @vitest-environment jsdom
 *
 * Putting back the terminals the user had open, with their conversations.
 *
 * The distinction this file is built around: restoring the TAB is easy and
 * nearly worthless on its own. Restoring the CONVERSATION is the feature. A
 * restored tab with a fresh agent in it looks exactly like the session the
 * user left and is not — which is worse than restoring nothing, because it
 * takes a while to notice, and by then they have typed into it.
 *
 * So every test here is about whether the right conversation comes back, or
 * whether the app is honest when it cannot.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { AppShell } from '../components/AppShell';
import { ActiveProjectProvider } from '../ActiveProject';
import { SocketProvider } from '../SocketContext';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(async () => [
      { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
    ]),
    listActiveItems: vi.fn(async () => []),
    listRuns: vi.fn(async () => []),
    getVersion: vi.fn(async () => ({ version: '1.1.18' })),
    getReadme: vi.fn(async () => ({ content: '' })),
    getLatestRelease: vi.fn(async () => null),
    updateItem: vi.fn(async () => ({})),
    getSettings: vi.fn(async () => ({ tmuxByDefault: false })),
    updateSettings: vi.fn(async () => ({ tmuxByDefault: false })),
    listTerminalSessions: vi.fn(async () => []),
    recordTerminalSession: vi.fn(async (s: Record<string, unknown>) => ({ id: 'row-1', ...s })),
    forgetTerminalSession: vi.fn(async () => {}),
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
          // What the main process does: mints a conversation id for an agent
          // that can be told one, and nothing for codex.
          return {
            sessionId: `pty-${spawnCalls.length}`,
            agentSessionId: req.agentId === 'codex' ? undefined
              : (req.agentSessionId as string | undefined) ?? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          };
        },
        write: async () => true,
        resize: async () => true,
        kill: async () => true,
        onData: () => () => {},
        onExit: () => () => {},
        listAgents: async () => [
          { id: 'claude-code', label: 'Claude Code', installed: true, supportsAutoApprove: true },
          { id: 'codex', label: 'Codex', installed: true, supportsAutoApprove: true },
        ],
        refreshAgents: async () => [],
        sessionPersistence: async () => ({ available: false }),
      },
    },
    configurable: true, writable: true,
  });
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.listProjects).mockResolvedValue([
    { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
  ] as never);
  vi.mocked(api.listTerminalSessions).mockResolvedValue([] as never);
  vi.mocked(api.getSettings).mockResolvedValue({ tmuxByDefault: false } as never);
  // Implementations, not just call history. `clearAllMocks` resets calls and
  // leaves implementations in place, so a `mockRejectedValue` from one test
  // stayed active in the next and failed it with an error it never asked for.
  vi.mocked(api.recordTerminalSession).mockImplementation(
    async (session) => ({ id: 'row-1', openedAt: new Date().toISOString(), ...session }) as never,
  );
  vi.mocked(api.forgetTerminalSession).mockResolvedValue(undefined as never);
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

const ACTIVE = [{ id: 'i1', projectId: 'p1', type: 'TASK', title: 'Something in agenfk', status: 'IN_PROGRESS' }];

const renderShell = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ActiveProjectProvider>
        <SocketProvider>
          <AppShell><div>board</div></AppShell>
        </SocketProvider>
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
};

const openTerminal = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
  fireEvent.click(await screen.findByTitle('Something in agenfk'));
  fireEvent.click(await screen.findByRole('button', { name: /^create/i }));
};

describe('remembering a terminal as it is opened', () => {
  it('records the conversation id the agent was given', async () => {
    // Recorded at OPEN time, which is only possible because we hand the agent
    // its id rather than discovering it afterwards. Nothing has to be parsed
    // out of the terminal, and no hook has to be installed.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    renderShell();
    await openTerminal();
    await waitFor(() => expect(api.recordTerminalSession).toHaveBeenCalled());
    expect(vi.mocked(api.recordTerminalSession).mock.calls[0][0]).toMatchObject({
      itemId: 'i1',
      agentId: 'claude-code',
      agentSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
  });

  it('still records a terminal whose agent cannot be given an id', async () => {
    // codex. The tab is worth putting back even when the conversation is not
    // recoverable — but the record must not claim an id it never had.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.updateItem).mockResolvedValue({} as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    fireEvent.click(await screen.findByTitle('Something in agenfk'));
    fireEvent.click(await screen.findByRole('button', { name: /claude code/i }));
    fireEvent.click(await screen.findByRole('option', { name: /codex/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^create/i }));
    await waitFor(() => expect(api.recordTerminalSession).toHaveBeenCalled());
    const recorded = vi.mocked(api.recordTerminalSession).mock.calls[0][0];
    expect(recorded.agentId).toBe('codex');
    expect(recorded.agentSessionId).toBeUndefined();
  });

  it('opens the terminal even when the record cannot be written', async () => {
    // Remembering is a nicety; opening the terminal is what the user asked
    // for. Ordering is the guarantee, not a try/catch bolted on afterwards.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.recordTerminalSession).mockRejectedValue(new Error('offline'));
    renderShell();
    await openTerminal();
    await waitFor(() => expect(spawnCalls.length).toBeGreaterThan(0));
  });
});

describe('putting them back', () => {
  const stored = [{
    id: 'row-1', itemId: 'i1', projectId: 'p1', agentId: 'claude-code',
    agentSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    openedAt: new Date().toISOString(),
  }];

  it('reopens the terminal asking to RESUME, not to start fresh', async () => {
    // The whole point. Without `resume`, the agent starts a new conversation
    // in a tab that looks exactly like the one the user left.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(stored as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBeGreaterThan(0));
    expect(spawnCalls[0]).toMatchObject({
      itemId: 'i1',
      agentId: 'claude-code',
      agentSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      resume: true,
    });
  });

  it('does not ask to resume a conversation that has no id', async () => {
    // codex. Asking to resume nothing would either fail the launch or resume
    // somebody else's session.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue([
      { ...stored[0], agentId: 'codex', agentSessionId: undefined },
    ] as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBeGreaterThan(0));
    expect(spawnCalls[0].resume).not.toBe(true);
  });

  it('does not record the restored terminal all over again', async () => {
    // Otherwise every launch doubles the number of remembered terminals, and
    // the tenth launch opens a wall of them.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(stored as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBeGreaterThan(0));
    expect(api.recordTerminalSession).not.toHaveBeenCalled();
  });

  it('opens nothing when there is nothing to put back', async () => {
    // A fresh install must not start an agent nobody asked for.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    renderShell();
    await screen.findByText('board');
    await new Promise(r => setTimeout(r, 50));
    expect(spawnCalls).toHaveLength(0);
  });

  it('restores each remembered terminal exactly once', async () => {
    // The effect runs on a query result, and a refetch must not open the same
    // agent a second time in the same worktree.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(stored as never);
    const { rerender } = renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(1));
    rerender(<div />);
    expect(spawnCalls).toHaveLength(1);
  });
});

describe('closing a tab', () => {
  it('forgets it, so it does not come back next launch', async () => {
    // Closing is the user saying they are done. Reopening it would be the app
    // arguing with them.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    renderShell();
    await openTerminal();
    // Wait for the record to LAND, not merely to be requested: the row id
    // arrives on the promise, and closing before it does would be testing a
    // race rather than the behaviour.
    await waitFor(() => expect(api.recordTerminalSession).toHaveBeenCalled());
    await waitFor(() => expect(vi.mocked(api.recordTerminalSession).mock.results[0].value).resolves.toBeTruthy());
    fireEvent.click(await screen.findByRole('button', { name: /close terminal on/i }));
    await waitFor(() => expect(api.forgetTerminalSession).toHaveBeenCalledWith('row-1'));
  });
});
