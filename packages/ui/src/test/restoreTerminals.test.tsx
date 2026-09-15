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
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react';
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
let exitHandlers: Array<(e: { sessionId: string; exitCode: number }) => void> = [];
let dataHandlers: Array<(e: { sessionId: string; data: string }) => void> = [];
let activityHandlers: Array<(e: { sessionId: string; activity: 'working' | 'idle' }) => void> = [];
let killCalls: string[];

const setBridge = () => {
  spawnCalls = [];
  exitHandlers = [];
  dataHandlers = [];
  activityHandlers = [];
  killCalls = [];
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
        kill: async (id: string) => { killCalls.push(id); return true; },
        // Collected for the same reason as onExit below: a mock that drops
        // the handler makes the liveness path untestable.
        onData: (_sessionId: string, cb: (e: { sessionId: string; data: string }) => void) => {
          dataHandlers.push(cb);
          return () => { dataHandlers = dataHandlers.filter(h => h !== cb); };
        },
        // Handlers are COLLECTED, not dropped. The bridge mock used to return
        // a no-op unsubscribe and never call anything, so no test could make a
        // session end — which is why "a session that exited still counts as
        // running" shipped.
        onActivity: (_sessionId: string, cb: (e: { sessionId: string; activity: 'working' | 'idle' }) => void) => {
          activityHandlers.push(cb);
          return () => { activityHandlers = activityHandlers.filter(h => h !== cb); };
        },
        onExit: (_sessionId: string, cb: (e: { sessionId: string; exitCode: number }) => void) => {
          exitHandlers.push(cb);
          return () => { exitHandlers = exitHandlers.filter(h => h !== cb); };
        },
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

/**
 * Into the Terminal view, the only way there now is.
 *
 * It used to be a click on the Terminal tab. That tab is gone, so this takes
 * the route a user has: the sessions rail in the sidebar, which lists agents,
 * and clicking one means "take me to it". Restoring deliberately does NOT
 * switch to the terminal - reopening the app should not yank you off the
 * board - so the view still has to be asked for rather than waited for.
 */
const goToTerminalView = async () => {
  fireEvent.click((await screen.findAllByTestId('process-open'))[0]);
  await waitFor(() =>
    expect(document.getElementById('panel-terminal')!.hasAttribute('hidden')).toBe(false));
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

/**
 * What a tab is called.
 *
 * Two failures that showed up together on a real screen: every tab in the strip
 * read as the same raw uuid. One was the restore path having no name for the
 * card and falling back to its id; the other was the strip titling tabs by the
 * CARD at all, which repeats the same string across every tab of a set and
 * distinguishes nothing.
 */
describe('naming the tabs', () => {
  const stored = [{
    id: 'row-1', itemId: 'i1', projectId: 'p1', agentId: 'claude-code',
    agentSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    itemTitle: 'Something in agenfk',
    openedAt: new Date().toISOString(),
  }];

  it('never shows a raw item id where a card name belongs', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(stored as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBeGreaterThan(0));
    // The uuid must appear nowhere on screen. It is an internal key.
    expect(document.body.textContent).not.toContain('aaaaaaaa-bbbb-cccc-dddd');
  });

  it('titles each tab by its agent and position, not by the card', async () => {
    // Tabs in a set are usually on the SAME card, so the card name repeats and
    // tells the user nothing about which tab is which.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(stored as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBeGreaterThan(0));
    await goToTerminalView();
    expect(await screen.findByRole('tab', { name: /Claude Code 1/ })).toBeInTheDocument();
  });

  it('still says which card, in the header', async () => {
    // The card's name is said ONCE, where it applies to everything below it.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(stored as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBeGreaterThan(0));
    await goToTerminalView();
    expect(await screen.findAllByText('Something in agenfk')).not.toHaveLength(0);
  });
});

/**
 * Whether the rail can tell that OUR OWN terminals are working.
 *
 * An adversarial review found it could not. Liveness was fed only by `run:event`
 * from the socket, which comes from the Claude Code hook — and a terminal
 * opened here creates a PTY and no run at all. So a desktop terminal was
 * permanently "idle": a thin grey ring while the agent worked for an hour.
 *
 * Worse than the wrong dot: the rail renders STOP only for running or waiting,
 * so the single state our own terminals could reach was the one with no
 * controls. There was no way to stop a session from the rail at all.
 *
 * The signal used here is the terminal's own output. It is the honest one
 * available without inventing a protocol: bytes arriving means the agent is
 * doing something.
 */
describe('two agents on one card', () => {
  /*
   * Constructed from a RESTORE rather than by driving the + button: the claim
   * is about the merge, and reaching the same state through two dialogs made
   * the test about the dialogs.
   */
  const twoRestored = [
    {
      id: 'row-1', itemId: 'i1', projectId: 'p1', agentId: 'claude-code',
      agentSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      itemTitle: 'Something in agenfk', openedAt: new Date().toISOString(),
    },
    {
      id: 'row-2', itemId: 'i1', projectId: 'p1', agentId: 'codex',
      itemTitle: 'Something in agenfk', openedAt: new Date().toISOString(),
    },
  ];

  it('lists both, instead of one swallowing the other', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(twoRestored as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(2));
    const labels = (await screen.findAllByTestId('process-open')).length;
    expect(labels, 'the rail collapsed two agents into one row').toBe(2);
  });

  it('names each row by its own agent', async () => {
    // The merged row used to carry whichever session was written last, so the
    // rail named one agent while clicking it reached the other.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(twoRestored as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(2));
    // Read off the process rows themselves now that the flat section is gone:
    // both agents are drawn under the one card they share.
    const rows = await screen.findAllByTestId('process-row');
    const text = rows.map(r => r.textContent).join(' ');
    expect(text).toMatch(/Claude Code/);
    expect(text).toMatch(/Codex/);
  });
});

/**
 * One click, one agent.
 *
 * Proven by an adversarial review to have been false: recording the
 * conversation wrote `agentSessionId` back into session state, and that value
 * is a PROP of TerminalPane sitting in its effect dependencies. Going
 * undefined -> uuid tore the terminal down — `api.kill`, `term.dispose` — and
 * spawned a second agent, which minted a different id because a fresh spawn
 * carries none. The row then held a conversation killed before it existed.
 *
 * Nothing caught it because the pane's own test asserts
 * `spawnCount - killCount === 1` — an invariant about SURVIVORS, which stays
 * true throughout a kill-and-respawn.
 */
describe('opening a terminal once', () => {
  it('spawns exactly one agent, and kills none', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    renderShell();
    await openTerminal();
    await waitFor(() => expect(api.recordTerminalSession).toHaveBeenCalled());
    // After the record lands, which is when the respawn used to happen.
    await waitFor(() => expect(spawnCalls.length).toBe(1));
    expect(killCalls, 'the terminal was torn down and replaced').toEqual([]);
  });

  it('remembers the conversation the SURVIVING process was given', async () => {
    // The row used to hold the id of the process that got killed, which is why
    // restoring pi opened an empty session.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    renderShell();
    await openTerminal();
    await waitFor(() => expect(api.recordTerminalSession).toHaveBeenCalled());
    const recorded = vi.mocked(api.recordTerminalSession).mock.calls[0][0].agentSessionId;
    expect(spawnCalls).toHaveLength(1);
    expect(recorded).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});

/**
 * Rows that must not survive, and tabs that must not be restored.
 *
 * Three findings from the same review, all of them "the app quietly keeps
 * doing something the user cannot see or undo".
 */
describe('closing a tab before its record lands', () => {
  it('still forgets the row, instead of leaking it forever', async () => {
    // The row survives on the server, so every subsequent launch puts that tab
    // back and spawns an agent into that worktree — and the only way to clear
    // it is to close it again AND win the same race.
    let settle: (row: { id: string }) => void = () => {};
    vi.mocked(api.recordTerminalSession).mockImplementation(
      () => new Promise(res => { settle = res as never; }) as never,
    );
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    renderShell();
    await openTerminal();
    await waitFor(() => expect(api.recordTerminalSession).toHaveBeenCalled());

    // Closed while the POST is still in flight.
    fireEvent.click(await screen.findByRole('button', { name: /close terminal on/i }));
    settle({ id: 'row-late' });

    await waitFor(() => expect(api.forgetTerminalSession).toHaveBeenCalledWith('row-late'));
  });
});

describe('in a browser, where there are no terminals', () => {
  it('restores nothing', async () => {
    // The board runs at localhost:5173 too. Without a guard it restored every
    // remembered tab as a panel saying terminals are desktop-only — and
    // closing them to tidy up DELETED the desktop's rows.
    delete (window as unknown as Record<string, unknown>).agenfkDesktop;
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue([{
      id: 'row-1', itemId: 'i1', projectId: 'p1', agentId: 'claude-code',
      agentSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      itemTitle: 'Something in agenfk', openedAt: new Date().toISOString(),
    }] as never);
    renderShell();
    await screen.findByText('board');
    await new Promise(r => setTimeout(r, 60));
    expect(api.listTerminalSessions).not.toHaveBeenCalled();
  });
});

/**
 * Two terminals of the SAME agent on one card.
 *
 * claude resumes by directory (`--continue`), and a directory holds one most
 * recent conversation, not two. Restoring both tabs with resume would attach
 * two processes to a single transcript: tab 1 would not be resumed at all, it
 * would be showing tab 2's history.
 *
 * The state is reachable and supported — the + button opens another terminal
 * on the current card — so the restore has to decide rather than assume one
 * terminal per card.
 */
describe('restoring two terminals of the same agent on one card', () => {
  const twoClaude = [
    {
      id: 'row-1', itemId: 'i1', projectId: 'p1', agentId: 'claude-code',
      agentSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      itemTitle: 'Something in agenfk', openedAt: '2026-09-14T01:00:00.000Z',
    },
    {
      id: 'row-2', itemId: 'i1', projectId: 'p1', agentId: 'claude-code',
      agentSessionId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      itemTitle: 'Something in agenfk', openedAt: '2026-09-14T02:00:00.000Z',
    },
  ];

  it('resumes only one of them', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(twoClaude as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(2));
    const resuming = spawnCalls.filter(c => c.resume === true);
    expect(resuming, 'both tabs asked to resume the one conversation').toHaveLength(1);
  });

  it('still puts both tabs back', async () => {
    // The second tab is worth having — it just starts a new conversation
    // rather than pretending to be the one the first tab holds.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(twoClaude as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(2));
  });

  it('leaves agents that resume BY ID alone', async () => {
    // pi resumes with an explicit --session-id, so two pi tabs on one card
    // resume two different conversations and neither needs to give way.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(
      twoClaude.map(r => ({ ...r, agentId: 'pi' })) as never,
    );
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(2));
    expect(spawnCalls.filter(c => c.resume === true)).toHaveLength(2);
  });
});

/**
 * A run that failed has to be able to reach the rail at all.
 *
 * The shell asked the server for `status: 'running'` runs only, so a failed
 * one never arrived — the rail's failed state was unreachable no matter what
 * the component did with it. The component's tests passed because they handed
 * the state straight in.
 */
describe('failed runs', () => {
  it('asks for runs without filtering out the failed ones', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    renderShell();
    await waitFor(() => expect(api.listRuns).toHaveBeenCalled());
    const args = vi.mocked(api.listRuns).mock.calls[0][0] ?? {};
    expect(args, 'filtering to running hides every failure').not.toHaveProperty('status');
  });

  it('shows one as failed, not as idle', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listRuns).mockResolvedValue([{
      id: 'r1', itemId: 'i1', harness: 'claude-code', status: 'failed',
      startedAt: new Date().toISOString(),
    }] as never);
    renderShell();
    await waitFor(() => {
      const states = [...document.querySelectorAll('[data-testid="session-dot"]')]
        .map(d => d.getAttribute('data-state'));
      expect(states).toContain('failed');
    });
  });

  it('keeps it failed however old it is', async () => {
    // A failure that ages into 'idle' is a failure nobody sees. Recency decides
    // between running and idle, never whether something broke.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listRuns).mockResolvedValue([{
      id: 'r1', itemId: 'i1', harness: 'claude-code', status: 'failed',
      startedAt: '2020-01-01T00:00:00.000Z',
    }] as never);
    renderShell();
    await waitFor(() => {
      const states = [...document.querySelectorAll('[data-testid="session-dot"]')]
        .map(d => d.getAttribute('data-state'));
      expect(states).toContain('failed');
    });
  });
});

/**
 * Which tab is selected after one is closed (CGLAB-182).
 *
 * The behaviour was already right; what was wrong was how it was reached.
 * `setActiveSession` was called from INSIDE the `setSessions` updater, and an
 * updater has to be pure — React invokes it twice in development and may
 * replay the queue. It happened to be harmless, because the second pass saw
 * `cur !== id` and returned `cur` untouched. That is a property nobody had
 * written down, in a file where the same impurity elsewhere already cost a
 * duplicate record and a killed terminal.
 *
 * So these tests pin the OUTCOME rather than the mechanism, and they run under
 * StrictMode, which is where an impure updater shows itself.
 */
describe('the tab that takes over when one is closed', () => {
  const threeRestored = ['claude-code', 'codex', 'pi'].map((agentId, i) => ({
    id: `row-${i + 1}`, itemId: 'i1', projectId: 'p1', agentId,
    itemTitle: 'Something in agenfk', openedAt: new Date().toISOString(),
  }));

  const renderStrict = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <React.StrictMode>
        <QueryClientProvider client={queryClient}>
          <ActiveProjectProvider>
            <SocketProvider>
              <AppShell><div>board</div></AppShell>
            </SocketProvider>
          </ActiveProjectProvider>
        </QueryClientProvider>
      </React.StrictMode>,
    );
  };

  const openTabs = () => Array.from(
    document.querySelectorAll('[role="tablist"][aria-label="Open terminals"] [role="tab"]'));
  /*
   * Re-queried on every call, never held across a click.
   *
   * A node captured before an interaction can be detached by the re-render
   * that follows, and `within()` on a detached subtree reports no accessible
   * roles at all — which reads as "the button is gone" when the button is
   * right there. Cost me a debugging round.
   */
  const closeTab = (index: number) => {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>(
      '[role="tablist"][aria-label="Open terminals"] button[aria-label^="Close terminal on"]'));
    fireEvent.click(buttons[index]);
  };

  it('falls to the last remaining tab, never to a blank panel', async () => {
    // The one outcome that is not defensible is tabs on screen with nothing
    // under them, which reads as a crash rather than as a closed tab.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(threeRestored as never);
    renderStrict();
    await waitFor(() => expect(openTabs().length).toBe(3));

    fireEvent.click(openTabs()[1]);
    await waitFor(() => expect(openTabs()[1]).toHaveAttribute('aria-selected', 'true'));

    closeTab(1);
    await waitFor(() => expect(openTabs().length).toBe(2));
    const selected = openTabs().filter(t => t.getAttribute('aria-selected') === 'true');
    expect(selected, 'no tab is selected — the panel is blank with tabs showing').toHaveLength(1);
    expect(selected[0]).toBe(openTabs().at(-1));
  });

  it('leaves the selection alone when a different tab is closed', async () => {
    // The other half of the rule, and the one the impure updater relied on
    // being true: closing a tab you are not looking at must not move you.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(threeRestored as never);
    renderStrict();
    await waitFor(() => expect(openTabs().length).toBe(3));

    fireEvent.click(openTabs()[0]);
    await waitFor(() => expect(openTabs()[0]).toHaveAttribute('aria-selected', 'true'));
    const stayingLabel = openTabs()[0].textContent;

    closeTab(2);
    await waitFor(() => expect(openTabs().length).toBe(2));
    expect(openTabs()[0]).toHaveAttribute('aria-selected', 'true');
    expect(openTabs()[0].textContent).toBe(stayingLabel);
  });

  it('leaves nothing selected once the last tab is gone', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue([threeRestored[0]] as never);
    renderStrict();
    await waitFor(() => expect(openTabs().length).toBe(1));
    closeTab(0);
    await waitFor(() => expect(openTabs().length).toBe(0));
    // The strip goes away with the last tab. Asserting only that no tabs
    // render would have been vacuous — with zero sessions nothing renders
    // whatever `activeSession` holds.
    expect(document.querySelector('[role="tablist"][aria-label="Open terminals"]')).toBeNull();
  });

  it('lands somewhere real when two tabs close in the same batch', async () => {
    /*
     * THE case, and the one my first fix got wrong.
     *
     * Both closes inside one `act` means React batches them. The version that
     * read the session list from a ref saw the SAME pre-batch list twice — the
     * ref is assigned during render, and no render happens between them — so
     * the second close computed its "last remaining" from a list still
     * containing the session the first had just removed, and left the
     * selection pointing at a tab that no longer exists.
     *
     * Two separate clicks would not catch it: discrete events flush
     * synchronously, so the ref is refreshed in between. The bug needs one
     * batch, which is what any close-all loop or socket-driven close would
     * produce.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(threeRestored as never);
    renderStrict();
    await waitFor(() => expect(openTabs().length).toBe(3));

    fireEvent.click(openTabs()[2]);
    await waitFor(() => expect(openTabs()[2]).toHaveAttribute('aria-selected', 'true'));

    act(() => { closeTab(2); closeTab(1); });
    await waitFor(() => expect(openTabs().length).toBe(1));

    const selected = openTabs().filter(t => t.getAttribute('aria-selected') === 'true');
    expect(selected, 'the selected tab is one that no longer exists').toHaveLength(1);
    expect(selected[0]).toBe(openTabs()[0]);
  });
});

/**
 * The `+` in the terminal strip (CGLAB-184).
 *
 * It used to reopen on the ACTIVE session's card and nothing else — no route
 * from the Terminal view to any other card without going back to the sidebar.
 * And with no active session it did nothing at all: no dialog, no message, not
 * even a disabled state.
 */
describe('opening another terminal from the strip', () => {
  const restored = [{
    id: 'row-1', itemId: 'i1', projectId: 'p1', agentId: 'claude-code',
    itemTitle: 'Something in agenfk', openedAt: new Date().toISOString(),
  }];

  it('asks which card, instead of assuming the one you are on', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(restored as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(1));

    await goToTerminalView();
    fireEvent.click(await screen.findByRole('button', { name: /new terminal/i }));
    expect(await screen.findByRole('dialog', { name: /which card/i })).toBeTruthy();
  });

  it('says so when nothing is in flight, instead of showing an empty box', async () => {
    /*
     * Renamed after review. The old title claimed to reproduce "the + with no
     * active session", and that state is unreachable: TerminalTab renders an
     * EmptyState before the strip when there are no sessions, so the + does not
     * exist, and with sessions present an active one is always set.
     *
     * What this actually covers is the empty ACTIVE-WORK list, which is real —
     * a card can leave that list while its terminal outlives it.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue([] as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(restored as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(1));

    await goToTerminalView();
    fireEvent.click(await screen.findByRole('button', { name: /new terminal/i }));
    const picker = await screen.findByRole('dialog', { name: /which card/i });
    expect(picker.textContent).toMatch(/no work in flight/i);
  });

  it('takes a DIFFERENT card through to the agent dialog', async () => {
    // End to end. The picker is a step BEFORE the agent dialog, which keeps
    // its identity of "open a terminal on THIS card" and is named after the
    // card just chosen — which is the whole point, since reaching another card
    // was impossible from here.
    vi.mocked(api.listActiveItems).mockResolvedValue([
      ...ACTIVE,
      { id: 'i2', projectId: 'p1', type: 'TASK', title: 'A different card', status: 'REVIEW' },
    ] as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(restored as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(1));

    await goToTerminalView();
    fireEvent.click(await screen.findByRole('button', { name: /new terminal/i }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: /which card/i }))
      .getByTitle('A different card'));
    expect(await screen.findByRole('dialog', { name: /open a terminal on A different card/i })).toBeTruthy();
  });

  it('gives a SECOND terminal on the card you are already on', async () => {
    /*
     * The regression review found in my first version, and the case the picker
     * is arranged to make most likely: the current card is hoisted to row one
     * and labelled "current".
     *
     * Routing that click through `requestTerminal` switched to the terminal
     * that was already open — which, from the + on the Terminal view, meant the
     * dialog closed and NOTHING on screen changed. The dead control this whole
     * card exists to fix, one layer deeper. It also removed the only route to
     * two agents on one card, which the tab labels ("<agent> <n>") and
     * MAX_SESSIONS_PER_WINDOW both exist for.
     *
     * The old assertion here could not have caught it: it checked only that no
     * second agent was spawned and no dialog appeared — all absences, which
     * pass just as well if onPick does nothing whatsoever.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(restored as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(1));

    await goToTerminalView();
    fireEvent.click(await screen.findByRole('button', { name: /new terminal/i }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: /which card/i }))
      .getByTitle('Something in agenfk'));

    // A dialog, named after that same card — not silence.
    expect(await screen.findByRole('dialog', { name: /open a terminal on Something in agenfk/i })).toBeTruthy();
  });

  it('closes on Escape without the user having to find the dialog first', async () => {
    /*
     * The handler existed from the start and could never fire: React dispatches
     * keydown along the fiber tree from the EVENT TARGET, and after clicking +
     * focus is still on that button, which is not inside the dialog. The
     * component's test fired the event at the dialog directly and so could not
     * see it. This one presses Escape wherever focus actually is.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(restored as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(1));

    await goToTerminalView();
    fireEvent.click(await screen.findByRole('button', { name: /new terminal/i }));
    await screen.findByRole('dialog', { name: /which card/i });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /which card/i })).toBeNull());
  });
});

/**
 * A session whose process ended stops counting as running (CGLAB-189).
 *
 * Reported with a screenshot: the rail said "1 running" while that very
 * session's terminal showed "Session exited (1)."
 *
 * The rail's only signal for our own terminals was recency of OUTPUT — and the
 * exit message is itself output, so dying made the row look alive. A dead
 * process is a FACT; it must not have to age out of a liveness window.
 *
 * The fix is per SESSION and not per card, which is the part worth pinning:
 * clearing liveness by itemId would have darkened a second agent still working
 * in the same worktree.
 */
describe('a terminal whose process ended', () => {
  const twoOnOneCard = [
    { id: 'row-1', itemId: 'i1', projectId: 'p1', agentId: 'claude-code',
      itemTitle: 'Something in agenfk', openedAt: new Date().toISOString() },
    { id: 'row-2', itemId: 'i1', projectId: 'p1', agentId: 'codex',
      itemTitle: 'Something in agenfk', openedAt: new Date().toISOString() },
  ];

  const runningCount = () =>
    document.querySelectorAll('[data-testid="session-dot"][data-state="running"]').length;

  it('stops counting as running the moment it exits', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue([twoOnOneCard[0]] as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(1));

    // Made live FIRST, or this test cannot fail: with no output the session was
    // never running, so asserting it is not running afterwards proves nothing.
    // Caught by reverting the fix and watching this one stay green.
    act(() => { dataHandlers.forEach(h => h({ sessionId: 'pty-1', data: 'working\r\n' })); });
    await waitFor(() => expect(runningCount()).toBe(1));

    act(() => { exitHandlers.forEach(h => h({ sessionId: 'pty-1', exitCode: 1 })); });
    await waitFor(() => expect(runningCount()).toBe(0));
  });

  it('does not darken the other agent on the same card', async () => {
    /*
     * The defect the obvious fix would have introduced. LiveAgents is keyed by
     * itemId, so clearing it on exit would have taken out a second agent that
     * is still working in the same worktree.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(twoOnOneCard as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(2));

    // Lit by the real path: terminal output is what marks a card live, and
    // both sessions are on card i1, so both light up.
    act(() => { dataHandlers.forEach(h => h({ sessionId: 'pty-1', data: 'working\r\n' })); });
    await waitFor(() => expect(runningCount()).toBe(2));

    act(() => { exitHandlers.forEach(h => h({ sessionId: 'pty-1', exitCode: 1 })); });
    await waitFor(() => expect(runningCount()).toBe(1));
  });
});


/**
 * A restored tab goes back where it came from (CGLAB-191).
 *
 * The restore hardcoded `persist: false` and `autoApprove: false`, so every tab
 * came back OUTSIDE tmux however it was created. The session that survived was
 * orphaned, a second agent started beside it in the same worktree, and since
 * the replacement did not persist either, nothing survived the next close.
 */
describe('restoring a session that lived in tmux', () => {
  const persisted = [{
    id: 'row-1', itemId: 'i1', projectId: 'p1', agentId: 'claude-code',
    agentSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    itemTitle: 'Something in agenfk',
    persist: true, autoApprove: true,
    openedAt: new Date().toISOString(),
  }];

  it('asks for tmux again, instead of dropping out of it', async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(persisted as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(1));
    expect(spawnCalls[0].persist, 'the tab came back outside tmux').toBe(true);
  });

  it('asks for it with the same permissions it was created with', async () => {
    // autoApprove is baked into the tmux session NAME, so restoring with the
    // wrong one looks for a session that does not exist and starts a second
    // agent beside the one still running.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(persisted as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(1));
    expect(spawnCalls[0].autoApprove).toBe(true);
  });

  it('does not invent tmux for a row that never had it', async () => {
    // Older rows carry neither field. False is the conservative answer for a
    // session whose identity was never written down.
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue([{
      id: 'row-2', itemId: 'i1', projectId: 'p1', agentId: 'claude-code',
      itemTitle: 'Something in agenfk', openedAt: new Date().toISOString(),
    }] as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(1));
    expect(spawnCalls[0].persist).toBe(false);
    expect(spawnCalls[0].autoApprove).toBe(false);
  });
});


/**
 * The rail follows what the agent says, not what the terminal draws (CGLAB-192).
 *
 * Claude Code and Codex publish a spinner in the terminal TITLE while they
 * work. Output recency stays only as the fallback for agents that publish
 * nothing — and it is exactly the signal that kept a card green forever,
 * because a TUI repaints its own footer.
 */
describe('a session that says what it is doing', () => {
  const one = [{
    id: 'row-1', itemId: 'i1', projectId: 'p1', agentId: 'claude-code',
    itemTitle: 'Something in agenfk', openedAt: new Date().toISOString(),
  }];
  const runningCount = () =>
    document.querySelectorAll('[data-testid="session-dot"][data-state="running"]').length;

  const open = async () => {
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue(one as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(1));
  };

  it('goes idle when the agent says idle, even while output keeps arriving', async () => {
    /*
     * THE case. A repainting footer is output, so the old rule held the card
     * green for the whole liveness window no matter what the agent was doing.
     * Here output keeps flowing and the state still goes to idle, because the
     * agent said so.
     */
    await open();
    act(() => { activityHandlers.forEach(h => h({ sessionId: 'pty-1', activity: 'working' })); });
    await waitFor(() => expect(runningCount()).toBe(1));

    act(() => { activityHandlers.forEach(h => h({ sessionId: 'pty-1', activity: 'idle' })); });
    act(() => { dataHandlers.forEach(h => h({ sessionId: 'pty-1', data: 'repaint\r\n' })); });
    await waitFor(() => expect(runningCount()).toBe(0));
  });

  it('goes running on the agent word alone, with no output at all', async () => {
    await open();
    act(() => { activityHandlers.forEach(h => h({ sessionId: 'pty-1', activity: 'working' })); });
    await waitFor(() => expect(runningCount()).toBe(1));
  });

  it('falls back to output only for an agent nothing can read', async () => {
    /*
     * The fallback shrank, and this test shrank with it. pi used to land here;
     * it now has screen rules, so it reports idle from what is drawn rather
     * than lighting up on any byte.
     *
     * `shell` is the honest remaining case: it is not an agent, publishes no
     * title and has no screen rules, so output recency is all there is. Wrong
     * in the familiar direction, but it is a plain shell — there is nothing
     * better to know.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue(ACTIVE as never);
    vi.mocked(api.listTerminalSessions).mockResolvedValue([{
      id: 'row-3', itemId: 'i1', projectId: 'p1', agentId: 'shell',
      itemTitle: 'Something in agenfk', openedAt: new Date().toISOString(),
    }] as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(1));

    act(() => { dataHandlers.forEach(h => h({ sessionId: 'pty-1', data: 'output\r\n' })); });
    await waitFor(() => expect(runningCount()).toBe(1));
  });

  it('lets a dead process win over anything the agent last said', async () => {
    // The agent's last word was "working"; then it exited. A fact beats a claim.
    await open();
    act(() => { activityHandlers.forEach(h => h({ sessionId: 'pty-1', activity: 'working' })); });
    await waitFor(() => expect(runningCount()).toBe(1));

    act(() => { exitHandlers.forEach(h => h({ sessionId: 'pty-1', exitCode: 0 })); });
    await waitFor(() => expect(runningCount()).toBe(0));
  });
});

describe('the Runs toggle in the terminal bar', () => {
  it('hides the feed without navigating away', async () => {
    /*
     * The button says "Hide the run feed", and it shared a callback with the
     * dock strip's up-arrow - which says "Put Runs back to its own screen" and
     * navigates there. Correct for that control, and the exact opposite of
     * what this one promises: pressing hide moved the user to the full-height
     * Agents screen with the terminal gone.
     *
     * Found by review, by reading, not by a failing test - the two callers
     * shared one function and only one of them had a test.
     */
    localStorage.setItem('agenfk_runs_dock', JSON.stringify('bottom'));
    vi.mocked(api.listTerminalSessions).mockResolvedValue([{
      id: 'row-1', itemId: 'i1', projectId: 'p1', agentId: 'claude-code',
      itemTitle: 'Something in agenfk', openedAt: new Date().toISOString(),
    }] as never);
    renderShell();
    await waitFor(() => expect(spawnCalls.length).toBe(1));
    await goToTerminalView();

    fireEvent.click(await screen.findByTitle('Hide the run feed'));

    await waitFor(() => expect(screen.queryByTestId('runs-dock')).toBeNull());
    expect(
      document.getElementById('panel-terminal')!.hasAttribute('hidden'),
      'hiding the feed navigated away from the terminal',
    ).toBe(false);
  });
});
