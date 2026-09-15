/**
 * @vitest-environment jsdom
 *
 * The shell's top-level views, now that there is no tab bar (CGLAB-178).
 *
 * This file was written for a bar the user owned: a list that was state rather
 * than a constant, an order that survived closing the app, a drag, a move-left
 * button and an announcement for anyone who could not see the bar move. Kanban
 * left the bar, then Terminal, and Runs - the last one - was already being kept
 * docked under the board. A bar with nothing in it orders nothing.
 *
 * SO MOST OF THIS FILE IS GONE, and each block below says what it held. The
 * rule the deletions share: a test over one tab, or over no tabs, cannot fail.
 * Reordering needs two things to disagree about, and there is now one place a
 * view can be.
 *
 * What survives is the part that was never about the bar: the board is
 * reachable, the panels stay mounted, and a card can ask for a terminal.
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

describe('the Runs view', () => {
  it('is opened by a button in the sidebar, the only way in there is', async () => {
    // The tab that used to open it is gone, so this row IS the route. A run
    // feed reachable only from a control inside itself is a view with no way
    // in, which is the same trap as a dock with no way back.
    renderShell();
    fireEvent.click(await agentsRow());
    expect(runsScreen().hasAttribute('hidden')).toBe(false);
    expect(runsScreen().textContent).toMatch(/no agent runs open/i);
  });

  it('starts on its own screen, which is where the tab used to put it', async () => {
    renderShell();
    fireEvent.click(await agentsRow());
    expect(screen.queryByTestId('runs-dock')).toBeNull();
  });

  it('moves to a strip under the board, and leaves its screen', async () => {
    renderShell();
    fireEvent.click(await agentsRow());
    fireEvent.click(screen.getByRole('button', { name: /dock runs below/i }));
    await waitFor(() => expect(screen.getByTestId('runs-dock')).toBeInTheDocument());
  });

  it('does not leave you looking at the screen it just emptied', async () => {
    // The rule `moveRunsTo` has always had, now that the screen it applies to
    // is Agents rather than a tab: docking the feed away while its own screen
    // is the one showing would leave the main area blank. The board is the
    // only view that is always there.
    renderShell();
    fireEvent.click(await agentsRow());
    fireEvent.click(screen.getByRole('button', { name: /dock runs below/i }));
    await waitFor(() => expect(runsScreen().hasAttribute('hidden')).toBe(true));
    expect(document.getElementById('panel-kanban')!.hasAttribute('hidden')).toBe(false);
  });

  it('does not remount the board when it moves', async () => {
    // The one thing this must not cost. The board is `children`; moving a
    // subtree to a different DOM parent unmounts and remounts it, losing
    // scroll position, open menus and anything half-typed.
    renderShell();
    const before = await screen.findByText('board');
    fireEvent.click(await agentsRow());
    fireEvent.click(screen.getByRole('button', { name: /dock runs below/i }));
    await waitFor(() => expect(screen.getByTestId('runs-dock')).toBeInTheDocument());
    // The SAME node, not an equal one: a remount produces a new element.
    expect(screen.getByText('board')).toBe(before);
  });

  it('remembers where it was put', async () => {
    localStorage.setItem('agenfk_runs_dock', '"bottom"');
    renderShell();
    await waitFor(() => expect(screen.getByTestId('runs-dock')).toBeInTheDocument());
  });

  it('opens on its screen for the position name it had as a tab', async () => {
    /*
     * `"tab"` is what every build with a tab strip wrote, so it is in the
     * storage of everyone upgrading. It always meant "the whole main column",
     * and that is where it still has to land.
     *
     * There is no special case for it in `readRunsDock`, and this test does
     * not pretend there is: `"tab"` is simply not a zone this build has, and
     * the fallback for an unrecognised zone is the screen. What this pins is
     * that the fallback stays the SCREEN - flipping it to `bottom` would move
     * the feed under the board for every upgrading user at once, silently.
     */
    localStorage.setItem('agenfk_runs_dock', '"tab"');
    renderShell();
    fireEvent.click(await agentsRow());
    expect(screen.queryByTestId('runs-dock')).toBeNull();
    expect(runsScreen().hasAttribute('hidden')).toBe(false);
  });

  it('ignores a stored position it does not recognise', async () => {
    // Written by another version, or edited by hand. An unknown zone must not
    // put the view nowhere.
    localStorage.setItem('agenfk_runs_dock', '"floating-over-everything"');
    renderShell();
    fireEvent.click(await agentsRow());
    expect(screen.queryByTestId('runs-dock')).toBeNull();
    expect(runsScreen().hasAttribute('hidden')).toBe(false);
  });

  it('says where it went, rather than showing an empty screen', async () => {
    // Clicking Agents with the feed docked below used to be able to land on
    // nothing. A nav row that lands on nothing reads as a broken app, and this
    // is also where the way back is announced.
    localStorage.setItem('agenfk_runs_dock', '"bottom"');
    renderShell();
    fireEvent.click(await agentsRow());
    expect(runsScreen().textContent).toMatch(/docked below the board/i);
  });

  it('can be put back, without hunting for how', async () => {
    // A move with no way back is a trap, and the way back has to be visible
    // from the state it left you in - which is the strip itself, because the
    // board is what you are looking at.
    localStorage.setItem('agenfk_runs_dock', '"bottom"');
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: /back to its own screen/i }));
    await waitFor(() => expect(screen.queryByTestId('runs-dock')).toBeNull());
  });

  it('takes you to the feed when it is put back, not just to where it was', async () => {
    // Returning it while the board is showing used to report success and
    // change nothing the user could see: the strip vanished and the screen it
    // moved to was not the one selected.
    localStorage.setItem('agenfk_runs_dock', '"bottom"');
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: /back to its own screen/i }));
    await waitFor(() => expect(runsScreen().hasAttribute('hidden')).toBe(false));
  });

  it('is moved by a button, not only by dragging', async () => {
    // Keyboard parity is in the card, and it is the reason this is a control
    // rather than a drag target: a drag-only affordance is unreachable without
    // a pointer.
    renderShell();
    fireEvent.click(await agentsRow());
    const control = screen.getByRole('button', { name: /dock runs below/i });
    expect(control.tagName).toBe('BUTTON');
  });

  it('leaves the board alone above it', async () => {
    // The strip is a SIBLING of the board in the same column, never a wrapper
    // around it. Re-parenting `children` would unmount and remount the board.
    localStorage.setItem('agenfk_runs_dock', '"bottom"');
    renderShell();
    const board = await screen.findByText('board');
    expect(screen.getByTestId('runs-dock').contains(board)).toBe(false);
  });
});

/*
 * DELETED: "dragging a tab" - seven tests.
 *
 * They covered the WIRING of the drag: that it reached `moveTab`, that the bar
 * and `agenfk_shell_tabs` followed, that the selection stayed on the tab
 * rather than on the position, that a drop on the tab itself changed nothing,
 * that a drop which did not start on a tab was ignored, and that both the drag
 * and the move-left button announced the tab's new position to a screen
 * reader. The `dragTabOnto` helper went with them.
 *
 * There is nothing to drag. `moveTab` itself was deleted along with
 * src/tabReorder.ts and its own test file, which answered the harder question
 * these never did: which slot a tab lands in, over lists of any length.
 *
 * If a strip returns, that module is the piece to bring back first - these
 * tests were only ever the wiring around it.
 */

/**
 * Opening a terminal from the board (CGLAB-176).
 *
 * The gap this closes: `requestTerminal` had exactly one caller, the sidebar's
 * session rail — which lists cards that ALREADY have a terminal. So the FIRST
 * terminal on a card had no route from the board, which is where the work is.
 *
 * The card asked for a card to open as its own top-level TAB, and that is
 * deliberately not what was built. The Terminal view already holds N sessions
 * in its own inner tabs; promoting one to the outer bar would put the same
 * state in two places, which is the exact defect that had the session rail and
 * the terminal disagreeing earlier in this epic. What the user wants from
 * "open from the card" is to GET to that card's agent, so this is navigation.
 */
function BoardWithTerminalButton() {
  const { requestTerminalFor } = useActiveProject();
  return (
    <button onClick={() => requestTerminalFor({ id: 'i9', title: 'Wire the thing', projectId: 'p1' } as never)}>
      open terminal on card
    </button>
  );
}

const renderShellWithBoardButton = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ActiveProjectProvider>
      <SocketProvider>
        <AppShell><BoardWithTerminalButton /></AppShell>
      </SocketProvider>
    </ActiveProjectProvider>
  </QueryClientProvider>,
);

describe('a card asking for a terminal', () => {
  it('puts up the open dialog, named after the card', async () => {
    renderShellWithBoardButton();
    fireEvent.click(await screen.findByText('open terminal on card'));
    expect(await screen.findByRole('dialog', { name: /open a terminal on Wire the thing/i })).toBeTruthy();
  });

  it('opens nothing until the card asks', async () => {
    // The latch that keeps an agent CLI from being launched by a render.
    renderShellWithBoardButton();
    await screen.findByText('open terminal on card');
    expect(screen.queryByRole('dialog', { name: /open a terminal/i })).toBeNull();
  });

  it('asks again after the dialog was dismissed', async () => {
    // What the nonce buys. Without it the second click carries a value equal to
    // the first, the shell sees no change, and the button works exactly once.
    renderShellWithBoardButton();
    fireEvent.click(await screen.findByText('open terminal on card'));
    fireEvent.click(within(await screen.findByRole('dialog', { name: /open a terminal/i }))
      .getByRole('button', { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /open a terminal/i })).toBeNull());
    fireEvent.click(screen.getByText('open terminal on card'));
    expect(await screen.findByRole('dialog', { name: /open a terminal on Wire the thing/i })).toBeTruthy();
  });
});

/*
 * DELETED EARLIER, AND NOW MOOT: the two tests that held "the stored order and
 * the bar on screen are not the same list".
 *
 * The drift they caught was real - the move-left button stepping to a tab that
 * was hidden because Runs was docked away, and the live region announcing
 * "position 2 of 3" over a two-tab bar. The previous commit removed them when
 * the Kanban tab left, because docking Runs below then left ONE tab and made
 * the drift unreachable through the UI, and noted that `visibleOrder` in
 * AppShell was still the code that prevented it.
 *
 * `visibleOrder` is gone too now, along with everything that counted tabs.
 * There is no second list to disagree with a first one. This note stays only
 * so the trail from the original defect does not end in silence.
 */

/**
 * The board and the terminal are reached WITHOUT a tab bar.
 *
 * Kanban left the strip first (eb8fc679), Terminal followed it, and Runs - the
 * last tab - moved permanently under the board. So the strip itself is gone.
 *
 * What is REMOVED is a row of buttons. What stays is every panel, still
 * mounted and hidden rather than unmounted, and every route into them: Tasks
 * and Agents in the sidebar's WORK group, a card in the sidebar tree or the
 * sessions rail for the terminal.
 *
 * The window drag region the strip's row used to carry did NOT stay here. It
 * moved to a row that appears in the main column only while the sidebar is
 * collapsed, which is the only state where the macOS traffic lights reach into
 * that column - and that is asserted in AppShell.test.tsx, where the desktop
 * bridge can be made to report darwin. This environment is not a Mac, so a
 * check here would pass or fail on the wrong fact.
 */
describe('the board is reached from the sidebar, not a tab', () => {
  it('offers no view tabs at all', () => {
    // queryAll, not getAll: with the strip gone there is no tablist, and
    // getAllByRole throws on an empty result - which would fail for the
    // opposite of the reason this test exists.
    renderShell();
    expect(screen.queryByRole('tablist', { name: /views/i })).toBeNull();
    const labels = screen.queryAllByRole('tab').map(t => t.textContent);
    expect(labels).not.toContain('Kanban');
    expect(labels).not.toContain('Terminal');
    expect(labels).not.toContain('Runs');
  });

  it('still shows the board when Tasks is chosen', async () => {
    // The route that replaces it. If this fails the board is unreachable,
    // which is worse than a redundant tab.
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: /tasks/i }));
    expect(document.getElementById('panel-kanban')).not.toBeNull();
  });

  it('keeps the board MOUNTED, never unmounted', async () => {
    /*
     * The invariant the whole shell is built on. Unmounting the board loses
     * filters, scroll position and half-typed titles; unmounting the terminal
     * panel kills live agents and destroys their scrollback. Removing a tab
     * must not become an excuse to render conditionally.
     */
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: /agents/i }));
    const board = document.getElementById('panel-kanban');
    expect(board, 'the board unmounted when another view was selected').not.toBeNull();
    expect(board?.hasAttribute('hidden')).toBe(true);
  });

  it('keeps the terminal panel mounted with no tab to select it', async () => {
    /*
     * The panel outlived its tab. Its `aria-labelledby` used to point at
     * `tab-terminal`, and leaving that in place would name the panel after a
     * button that no longer exists - the exact defect the Kanban removal had
     * to fix one commit ago, where a tabpanel was left pointing at a deleted
     * tab and ended up with no accessible name at all.
     */
    renderShell();
    const panel = await waitFor(() => {
      const el = document.getElementById('panel-terminal');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(panel.getAttribute('aria-labelledby')).toBeNull();
    expect(panel.getAttribute('aria-label')).toBe('Terminal');
  });
});
