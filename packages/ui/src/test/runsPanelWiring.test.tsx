/**
 * The Runs feed shows runs (0d897a8c).
 *
 * It never has. Both places the feed appears - its own screen, and the strip
 * docked under the board - rendered a hand-written EmptyState saying "No agent
 * runs open", whatever was running. Not an empty case: missing wiring wearing
 * an empty case's clothes, which is the worst kind, because the app looks
 * finished and correct while telling you nothing.
 *
 * Everything else was already there. `RunsPanel` lists the runs and draws the
 * event transcript with lanes, and was plugged into the card detail modal
 * alone. The hook records an AgentRun per agent session and seven tools as
 * events - and a `Task` call is recorded as lane `orchestrator`, kind
 * `dispatch`, so a sub-agent being dispatched is already first-class data that
 * nothing on screen displayed.
 *
 * That is the value the user asked for in their own words: the logs we do not
 * see today, which are the sub-agents.
 *
 * THE FEED FOLLOWS the terminal you are watching, and the card you last
 * navigated to otherwise. Following the terminal ALONE was the first attempt
 * and it was wrong in the way that matters: a run recorded by the Claude Code
 * hook has no terminal of ours at all, and those are precisely the runs this
 * feed exists for. It would have stayed empty for its own main use.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '../components/AppShell';
import { ActiveProjectProvider } from '../ActiveProject';
import { SocketProvider } from '../SocketContext';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(),
    listActiveItems: vi.fn(),
    listRuns: vi.fn(),
    listAgentRuns: vi.fn(),
    listRunEvents: vi.fn(),
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
    connected: true, connect: vi.fn(), on: vi.fn(), off: vi.fn(),
    emit: vi.fn(), disconnect: vi.fn(),
  })),
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.listProjects).mockResolvedValue([
    { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
  ] as never);
  vi.mocked(api.listActiveItems).mockResolvedValue([] as never);
  vi.mocked(api.listRuns).mockResolvedValue([] as never);
  vi.mocked(api.listAgentRuns).mockResolvedValue([] as never);
  vi.mocked(api.listRunEvents).mockResolvedValue([] as never);
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(q => ({
      matches: false, media: q, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
});
afterEach(cleanup);

const renderShell = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ActiveProjectProvider>
      <SocketProvider>
        <AppShell><div>board</div></AppShell>
      </SocketProvider>
    </ActiveProjectProvider>
  </QueryClientProvider>,
);

/** Go to the feed the way a user does: the sidebar's Agents row. */
const openTheFeed = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /^agents$/i }));
};

describe('the feed asks for runs at all', () => {
  it('fetches them for the session being watched', async () => {
    /*
     * THE test, and it is about a request rather than about pixels: the old
     * placeholder rendered a perfectly good-looking panel and never asked the
     * server anything. Anything asserting only on what is drawn would have
     * passed against it.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', type: 'TASK', title: 'Busy card', status: 'IN_PROGRESS' },
    ] as never);
    vi.mocked(api.listRuns).mockResolvedValue([
      {
        id: 'run-1', itemId: 'i1', projectId: 'p1', harness: 'claude-code',
        status: 'failed', startedAt: new Date().toISOString(),
      },
    ] as never);
    renderShell();
    /*
     * Reached the way a person reaches a stuck card: the "N need you" jump on
     * the projects header. That is a real route AND it is the one that matters
     * - a run recorded by the hook has no terminal of ours, so a feed keyed on
     * the open terminal alone would never show it.
     */
    fireEvent.click(await screen.findByRole('button', { name: /need you/i }));
    await openTheFeed();

    await waitFor(() => expect(api.listAgentRuns).toHaveBeenCalledWith('i1'));
  });

  it('asks for nothing when no session is being watched', async () => {
    // The honest empty case, and the one the placeholder was impersonating.
    renderShell();
    await openTheFeed();
    await screen.findByText(/no agent runs open/i);
    expect(api.listAgentRuns).not.toHaveBeenCalled();
  });
});

describe('the empty state only appears when it is true', () => {
  it('stops claiming nothing is running once something is', async () => {
    /*
     * The line that was always on screen. Its wording - "Runs started from a
     * card appear here" - described behaviour the app did not have, which is
     * why it read as a considered empty state rather than as a bug.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', type: 'TASK', title: 'Busy card', status: 'IN_PROGRESS' },
    ] as never);
    vi.mocked(api.listRuns).mockResolvedValue([
      {
        id: 'run-1', itemId: 'i1', projectId: 'p1', harness: 'claude-code',
        status: 'failed', startedAt: new Date().toISOString(),
      },
    ] as never);
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      { id: 'ar-1', itemId: 'i1', status: 'running', startedAt: new Date().toISOString() },
    ] as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: /need you/i }));
    await openTheFeed();

    await waitFor(() => expect(screen.queryByText(/no agent runs open/i)).toBeNull());
  });
});

describe('a run the panel does not recognise', () => {
  it('draws it as a worker rather than taking the screen down', async () => {
    /*
     * Found by wiring this up, not by looking for it. The run row read
     * LANE[run.actor] with no fallback while the EVENT row three hundred lines
     * above has had `|| LANE.worker` all along - so a run whose actor is
     * absent or unrecognised made `lane.tag` a read on undefined and took the
     * whole panel with it. A white screen, not a missing label.
     *
     * Survivable while the panel lived only inside the card detail modal. This
     * card makes it a top-level screen, so the surface becomes every run the
     * server returns - including any written by an older build, or by a client
     * that never set an actor.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', type: 'TASK', title: 'Busy card', status: 'IN_PROGRESS' },
    ] as never);
    vi.mocked(api.listRuns).mockResolvedValue([
      {
        id: 'run-1', itemId: 'i1', projectId: 'p1', harness: 'claude-code',
        status: 'failed', startedAt: new Date().toISOString(),
      },
    ] as never);
    vi.mocked(api.listAgentRuns).mockResolvedValue([
      // No `actor` at all, which is what an older record looks like.
      { id: 'ar-1', itemId: 'i1', status: 'running', step: 'REFACTOR', startedAt: new Date().toISOString() },
    ] as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: /need you/i }));
    await openTheFeed();

    /*
     * Found as a BUTTON, which is what the panel draws each run as. Matching
     * on text alone found the step in more than one place, and an assertion
     * that can be satisfied by something behind the panel proves nothing about
     * the panel.
     */
    expect(await screen.findByRole('button', { name: /REFACTOR/ })).toBeInTheDocument();
  });
});

/*
 * A test for the Runs toggle in the terminal bar lived here and moved to
 * restoreTerminals.test.tsx, which is the only harness that can open a real
 * terminal. The control only renders once one is open, and this file's shell
 * cannot get there: a hook-recorded run has no terminal of ours, so clicking
 * its row opens a dialog instead.
 *
 * Worth recording because two versions of that test passed through here
 * failing for reasons unrelated to the defect - one clicked the dock strip's
 * arrow because /runs/i matches "Put Runs back to its own screen" as well.
 */
