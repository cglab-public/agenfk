/**
 * Processes drawn under their card, and the SESSIONS section gone (1a1b8df6).
 *
 * The sidebar showed the same work twice: the projects tree listed the cards,
 * and a flat SESSIONS list at the bottom listed the agents running on those
 * same cards. Two places for one fact is what made the rail and the terminal
 * disagree earlier in this epic, so the processes move under the card they
 * belong to and the section goes away.
 *
 * THE RISK THIS FILE EXISTS FOR is the two dots. Putting a process directly
 * under its card places the card's mark and the process's mark one line apart,
 * so any disagreement that was survivable at three inches becomes obvious. The
 * card's mark is a ROLL-UP: it shows the most demanding state beneath it, and
 * it is a pure function of the rows drawn there, so the two agree by
 * construction rather than by discipline.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { AppShell } from '../components/AppShell';
import { ActiveProjectProvider, useActiveProject } from '../ActiveProject';
import { SocketProvider } from '../SocketContext';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(async () => [{ id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() }]),
    listActiveItems: vi.fn(async () => []),
    listRuns: vi.fn(async () => []),
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
  io: vi.fn(() => ({ connected: true, connect: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn() })),
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.listProjects).mockResolvedValue([
    { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
  ] as never);
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

/*
 * DELETED: "the tabs the shell starts with", "remembering the order" and
 * "rearranging" - eight tests, plus the `shellTabs` helper that found the
 * tablist they all read.
 *
 * They held two rules. That a built-in tab could not be CLOSED, because a user
 * who closed Kanban had no way back to the board. And that the ORDER was the
 * user's: restored from `agenfk_shell_tabs`, repaired when a stored id named a
 * tab this build does not have, rewritten whenever the move-left button was
 * pressed.
 *
 * Both rules are about a bar, and there is no bar. Nothing can be closed out
 * of a list that is not rendered, and one destination has no order. Kept as a
 * description rather than as tests that pass because their subject is absent.
 *
 * Restore them if a tab strip ever comes back. The storage key and the reader
 * that repaired it across versions were deleted with the bar - see the note in
 * AppShell.tsx, which says what the machinery was.
 */

/**
 * Where the Runs view lives (CGLAB-176, resettled here).
 *
 * It can still sit in two places, and the reason for the pair is unchanged:
 * live logs are something you follow WHILE looking at the board, so a
 * full-height screen makes that a choice between them - but a strip is too
 * small to read a log in, so the full screen has to stay available.
 *
 * WHAT CHANGED is the first position's name and its route. It was `tab`,
 * meaning a tab in the view strip. The strip is gone, and the same whole-column
 * view is now the Agents screen, opened from the sidebar. `screen` is that
 * position under an honest name, and a stored `"tab"` is read as it.
 *
 * Which makes the sidebar row load-bearing rather than convenient: with no tab
 * to click it is the only way in, and the control that docks the feed away
 * lives on the feed itself. A view whose only route is a button inside it
 * cannot be opened at all.
 *
 * The constraint that shapes the implementation is the one it always was:
 * moving it must not REMOUNT the board. The board is `children`, and moving a
 * subtree to a different DOM parent unmounts and remounts it - losing scroll
 * position, open menus and any edit in flight. So the board stays where it is
 * and the strip appears beneath it, in the same column.
 */
const agentsRow = async () => screen.findByRole('button', { name: /^agents$/i });
const runsScreen = () => document.getElementById('panel-agents')!;


describe('the SESSIONS section', () => {
  it('is gone from the sidebar', async () => {
    /*
     * THE change. Its contents are not lost - they are drawn under the cards
     * they belong to - but the section itself must not survive alongside them,
     * or the duplication this removes is simply doubled.
     */
    renderShell();
    await waitFor(() => expect(screen.getByRole('heading', { name: /projects/i })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: /^sessions$/i })).toBeNull();
  });

  it('takes the open-terminal count with it', async () => {
    // The count belonged to the section's header. Leaving it behind would
    // strand a number with nothing to count.
    renderShell();
    await waitFor(() => expect(screen.getByRole('heading', { name: /projects/i })).toBeInTheDocument());
    expect(screen.queryByTestId('open-terminal-count')).toBeNull();
  });
});

describe('a process whose card is not in the tree', () => {
  it('is still reachable, instead of disappearing with its card', async () => {
    /*
     * The hole this design opens, found by an existing test rather than by
     * reasoning about it. The rail listed every session regardless of the
     * tree; drawing processes UNDER their card means a process whose card is
     * not in the tree has nowhere to be drawn - and the card leaves the tree
     * for ordinary reasons, because the tree lists work in flight and a
     * terminal outlives the card reaching DONE.
     *
     * Losing the row would mean a running agent with no route to it in the
     * sidebar at all: still burning tokens, still holding a worktree, and
     * invisible. So orphans keep a place of their own. It is not the old
     * SESSIONS section returning - that listed EVERYTHING, duplicating the
     * tree; this holds only what the tree cannot show, and is absent whenever
     * there is nothing to hold.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue([] as never);
    // A run recorded by the hook, which needs no terminal of ours - the same
    // orphan condition a restored terminal produces, reachable without a pty.
    vi.mocked(api.listRuns).mockResolvedValue([
      {
        id: 'run-1', itemId: 'gone-from-the-list', harness: 'claude-code',
        status: 'running', startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ] as never);
    renderShell();
    expect(await screen.findByTestId('process-open')).toBeInTheDocument();
  });

  it('keeps no such section when every process has a card', async () => {
    // The guard against bringing the old duplicate list back by accident.
    renderShell();
    await waitFor(() => expect(screen.getByRole('heading', { name: /projects/i })).toBeInTheDocument());
    expect(screen.queryByTestId('orphan-processes')).toBeNull();
  });
});

describe('the order the processes sit in', () => {
  it('puts the one that needs a person above the ones that do not', async () => {
    /*
     * A failure buried under three busy agents is worse than not shown: the
     * list implies it is showing you what needs you. The rail sorted this way
     * and the sort came across with the rows, but nothing checked it - the
     * mutation replacing the comparator with `() => 0` passed everything.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', type: 'TASK', title: 'Busy card', status: 'IN_PROGRESS' },
    ] as never);
    vi.mocked(api.listRuns).mockResolvedValue([
      {
        id: 'run-ok', itemId: 'i1', projectId: 'p1', harness: 'claude-code',
        status: 'running', startedAt: new Date().toISOString(),
      },
      {
        id: 'run-bad', itemId: 'i1', projectId: 'p1', harness: 'codex',
        status: 'failed', startedAt: new Date().toISOString(),
      },
    ] as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));

    await waitFor(async () => expect(await screen.findAllByTestId('process-row')).toHaveLength(2));
    const states = screen.getAllByTestId('process-row').map(r => r.getAttribute('data-state'));
    expect(states[0], 'the failure was not first').toBe('failed');
  });
});

describe('which card a process is drawn under', () => {
  it('goes under its own card, and under no other', async () => {
    /*
     * THE test for this change, and it was missing: a mutation replacing the
     * per-card filter with `() => true` - drawing every process under every
     * card - passed all 104 tests in the two shell files. The one property the
     * whole redesign rests on was the one nothing checked.
     *
     * It matters more here than it would have in the rail. A row under the
     * wrong card is not a cosmetic slip: it says a different agent is working
     * on a different piece of work, and the card's own mark rolls up the rows
     * beneath it, so a misplaced row also turns the card's dot the wrong
     * colour.
     */
    vi.mocked(api.listActiveItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', type: 'TASK', title: 'The card with the agent', status: 'IN_PROGRESS' },
      { id: 'i2', projectId: 'p1', type: 'TASK', title: 'The quiet card', status: 'IN_PROGRESS' },
    ] as never);
    vi.mocked(api.listRuns).mockResolvedValue([
      {
        id: 'run-1', itemId: 'i1', projectId: 'p1', harness: 'claude-code',
        status: 'running', startedAt: new Date().toISOString(),
      },
    ] as never);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));

    const rows = await screen.findAllByTestId('process-row');
    expect(rows, 'the one process was drawn more than once').toHaveLength(1);

    // Walk UP from the row to the card that contains it, rather than trusting
    // document order - which would pass just as happily on a flat list.
    const owner = rows[0].closest('li')!;
    expect(owner.textContent).toMatch(/The card with the agent/);
    expect(owner.textContent).not.toMatch(/The quiet card/);
  });
});
