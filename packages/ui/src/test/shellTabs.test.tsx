/**
 * @vitest-environment jsdom
 *
 * The shell's tab bar, as something the user owns (CGLAB-178).
 *
 * It was three entries written in code. What the team likes elsewhere is
 * opening as many as they want, each holding a context, and switching without
 * losing anything — so the list has to become state, and state that survives
 * closing the app.
 *
 * The groundwork was already here and is worth naming, because it is why this
 * is a small change rather than a rewrite: panels are hidden and never
 * unmounted, so switching has never cost anything, and the tablist already
 * has keyboard navigation.
 *
 * Two rules this file exists to hold:
 *
 * **The built-in tabs cannot be closed.** A user who closes Kanban has no way
 * back to the board, and a tab bar that can be emptied is a dead end.
 *
 * **The order is the user's.** It is remembered, because rearranging something
 * that resets on the next launch is worse than not being able to rearrange it.
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

const shellTabs = async () =>
  within(await screen.findByRole('tablist', { name: /views/i })).getAllByRole('tab');

describe('the tabs the shell starts with', () => {
  it('still opens on the board', async () => {
    renderShell();
    const tabs = await shellTabs();
    expect(tabs[0]).toHaveTextContent(/kanban/i);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('cannot close a built-in tab, because there would be no way back', async () => {
    renderShell();
    const tabs = await shellTabs();
    expect(within(tabs[0].parentElement!).queryByRole('button', { name: /close/i })).toBeNull();
  });
});

describe('remembering the order', () => {
  it('restores an order the user chose', async () => {
    // Rearranging something that resets on the next launch is worse than not
    // being able to rearrange it at all.
    localStorage.setItem('agenfk_shell_tabs', JSON.stringify(['runs', 'kanban', 'terminal']));
    renderShell();
    const tabs = await shellTabs();
    expect(tabs[0]).toHaveTextContent(/runs/i);
  });

  it('ignores a stored order that names a tab it does not have', async () => {
    // Written by an older or newer build. Trusting it blindly would render a
    // tab bar with a hole in it, or drop a tab the user needs.
    localStorage.setItem('agenfk_shell_tabs', JSON.stringify(['nonsense', 'kanban']));
    renderShell();
    const tabs = await shellTabs();
    expect(tabs.map(t => t.textContent).join(' ')).toMatch(/kanban/i);
    expect(tabs.map(t => t.textContent).join(' ')).toMatch(/runs/i);
  });

  it('survives a stored value that is not even a list', async () => {
    localStorage.setItem('agenfk_shell_tabs', '{"not":"an array"}');
    renderShell();
    expect((await shellTabs()).length).toBeGreaterThan(0);
  });

  it('writes the order when it changes', async () => {
    renderShell();
    const tabs = await shellTabs();
    fireEvent.click(within(tabs[1].parentElement!).getByRole('button', { name: /move .* left/i }));
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('agenfk_shell_tabs') ?? '[]');
      expect(stored[0]).toBe('terminal');
    });
  });
});

describe('rearranging', () => {
  it('moves a tab left, and the selection follows the tab', async () => {
    // The selection belongs to the tab, not to the position. Moving the tab
    // you are looking at must not switch you to a different view.
    renderShell();
    let tabs = await shellTabs();
    fireEvent.click(tabs[1]);
    fireEvent.click(within(tabs[1].parentElement!).getByRole('button', { name: /move .* left/i }));
    tabs = await shellTabs();
    expect(tabs[0]).toHaveTextContent(/terminal/i);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('offers no move-left on the first tab, which has nowhere to go', async () => {
    renderShell();
    const tabs = await shellTabs();
    expect(within(tabs[0].parentElement!).queryByRole('button', { name: /move .* left/i })).toBeNull();
  });
});

/**
 * Where the Runs view lives (CGLAB-176).
 *
 * As a sibling tab of Kanban it is in the wrong place, and the card says why:
 * live logs are something you follow WHILE looking at the board. A tab makes
 * that a choice between them.
 *
 * The destinations are a CLOSED set on purpose. Free layout becomes window
 * management — state that is hard to persist and easy to leave unusable — and
 * a couple of fixed positions give nearly all the perceived flexibility for a
 * fraction of that.
 *
 * The constraint that shapes the implementation: moving it must not REMOUNT
 * the board. The board is `children`, and moving a subtree to a different DOM
 * parent unmounts and remounts it — losing scroll position, open menus and any
 * edit in flight. So the board stays where it is and the strip appears beneath
 * it, in the same column.
 */
describe('docking the Runs view', () => {
  it('is a tab by default, which is where it has always been', async () => {
    renderShell();
    const labels = (await shellTabs()).map(t => t.textContent);
    expect(labels.join(' ')).toMatch(/runs/i);
  });

  it('moves to a strip under the board, and leaves the tab bar', async () => {
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: /dock runs below/i }));
    await waitFor(() => expect(screen.getByTestId('runs-dock')).toBeInTheDocument());
    const labels = (await shellTabs()).map(t => t.textContent);
    expect(labels.join(' ')).not.toMatch(/runs/i);
  });

  it('does not remount the board when it moves', async () => {
    // The one thing this must not cost. The board is `children`; moving a
    // subtree to a different DOM parent unmounts and remounts it, losing
    // scroll position, open menus and anything half-typed.
    renderShell();
    const before = await screen.findByText('board');
    fireEvent.click(await screen.findByRole('button', { name: /dock runs below/i }));
    await waitFor(() => expect(screen.getByTestId('runs-dock')).toBeInTheDocument());
    // The SAME node, not an equal one: a remount produces a new element.
    expect(screen.getByText('board')).toBe(before);
  });

  it('remembers where it was put', async () => {
    localStorage.setItem('agenfk_runs_dock', '"bottom"');
    renderShell();
    await waitFor(() => expect(screen.getByTestId('runs-dock')).toBeInTheDocument());
  });

  it('ignores a stored position it does not recognise', async () => {
    // Written by another version, or edited by hand. An unknown zone must not
    // put the view nowhere.
    localStorage.setItem('agenfk_runs_dock', '"floating-over-everything"');
    renderShell();
    const labels = (await shellTabs()).map(t => t.textContent);
    expect(labels.join(' ')).toMatch(/runs/i);
  });

  it('can be put back, without hunting for how', async () => {
    // A move with no way back is a trap, and the way back has to be visible
    // from the state it left you in.
    localStorage.setItem('agenfk_runs_dock', '"bottom"');
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: /back to a tab/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('runs-dock')).toBeNull();
    });
  });

  it('is moved by a button, not only by dragging', async () => {
    // Keyboard parity is in the card, and it is the reason this is a control
    // rather than a drag target: a drag-only affordance is unreachable without
    // a pointer.
    renderShell();
    const control = await screen.findByRole('button', { name: /dock runs below/i });
    expect(control.tagName).toBe('BUTTON');
  });
});

/**
 * Dragging a tab somewhere else (CGLAB-176).
 *
 * An ADDITION to the move-left button, never a replacement. The button works
 * from the keyboard and needs no pointer; a drag is better with a mouse and
 * impossible without one, so swapping one for the other would trade an
 * accessible affordance for an inaccessible one. Both tests below exist to
 * hold that line: the button still works, and the drag announces its outcome
 * to anyone who cannot see the bar move.
 *
 * jsdom has no drag implementation, so these fire the events the handlers
 * listen for. That is enough, because the decision under test is which slot
 * the tab lands in — not how the browser paints it on the way there.
 */
const dragTabOnto = (from: HTMLElement, to: HTMLElement) => {
  const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
  fireEvent.dragStart(from.parentElement!, { dataTransfer });
  fireEvent.dragOver(to.parentElement!, { dataTransfer });
  fireEvent.drop(to.parentElement!, { dataTransfer });
};

describe('dragging a tab', () => {
  it('lands it in the slot it was dropped on, moving right', async () => {
    renderShell();
    let tabs = await shellTabs();
    dragTabOnto(tabs[0], tabs[2]);
    tabs = await shellTabs();
    expect(tabs.map(t => t.textContent)).toEqual(['Terminal', 'Runs', 'Kanban']);
  });

  it('lands it in the slot it was dropped on, moving left', async () => {
    renderShell();
    let tabs = await shellTabs();
    dragTabOnto(tabs[2], tabs[0]);
    tabs = await shellTabs();
    expect(tabs.map(t => t.textContent)).toEqual(['Runs', 'Kanban', 'Terminal']);
  });

  it('keeps the selection on the tab, not on the position', async () => {
    // Same rule the button already obeys. Dragging the view you are looking at
    // must not switch you to a different one.
    renderShell();
    let tabs = await shellTabs();
    fireEvent.click(tabs[0]);
    dragTabOnto(tabs[0], tabs[2]);
    tabs = await shellTabs();
    expect(tabs[2]).toHaveTextContent(/kanban/i);
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
  });

  it('remembers the new order for next launch', async () => {
    renderShell();
    const tabs = await shellTabs();
    dragTabOnto(tabs[0], tabs[2]);
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('agenfk_shell_tabs')!)).toEqual(['terminal', 'runs', 'kanban']));
  });

  it('dropping a tab on itself changes nothing', async () => {
    renderShell();
    let tabs = await shellTabs();
    dragTabOnto(tabs[1], tabs[1]);
    tabs = await shellTabs();
    expect(tabs.map(t => t.textContent)).toEqual(['Kanban', 'Terminal', 'Runs']);
  });

  it('says where the tab ended up, for a reader that cannot see the bar', async () => {
    // The reason a drag-only affordance would not have been acceptable. The
    // position is announced rather than the direction: after a drag across the
    // bar, "moved left" is not the useful part.
    renderShell();
    const tabs = await shellTabs();
    dragTabOnto(tabs[0], tabs[2]);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/Kanban moved to position 3 of 3/i));
  });

  it("announces the button's move too, so both affordances speak", async () => {
    renderShell();
    const tabs = await shellTabs();
    fireEvent.click(within(tabs[1].parentElement!).getByRole('button', { name: /move .* left/i }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/Terminal moved to position 1 of 3/i));
  });

  it('ignores a drop that did not start on a tab', async () => {
    // A file or a text selection dropped on the bar. Without the guard the bar
    // accepts it and moves nothing, which looks like the drop was understood.
    renderShell();
    let tabs = await shellTabs();
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    fireEvent.dragOver(tabs[2].parentElement!, { dataTransfer });
    fireEvent.drop(tabs[2].parentElement!, { dataTransfer });
    tabs = await shellTabs();
    expect(tabs.map(t => t.textContent)).toEqual(['Kanban', 'Terminal', 'Runs']);
  });
});

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

/**
 * The stored order and the bar on screen are not the same list.
 *
 * Docked below, Runs is not a tab — so `tabOrder` has three ids and the bar
 * shows two. Two separate defects came out of counting with the wrong one, and
 * both were found in review rather than by these tests, which is why they are
 * here now.
 */
describe('reordering while Runs is docked below', () => {
  const dockRunsBelow = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /dock runs below/i }));
    await waitFor(async () => expect(await shellTabs()).toHaveLength(2));
  };

  it('counts the announcement over the tabs that are actually shown', async () => {
    // "position 2 of 3" spoken over a two-tab bar describes a bar that is not
    // on screen — and for a screen-reader user that description is the only
    // one they get.
    renderShell();
    await dockRunsBelow();
    const tabs = await shellTabs();
    fireEvent.click(within(tabs[1].parentElement!).getByRole('button', { name: /move .* left/i }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/Terminal moved to position 1 of 2/i));
  });

  it('moves the tab to the neighbour on screen, not to a hidden one', async () => {
    // Reachable in three clicks: drag Runs left, dock it below, then use the
    // arrow on Terminal. Stepping through the STORED order landed Terminal
    // next to hidden Runs — the bar did not change, and the live region still
    // reported a move.
    renderShell();
    let tabs = await shellTabs();
    dragTabOnto(tabs[2], tabs[1]);
    await waitFor(async () =>
      expect((await shellTabs()).map(t => t.textContent)).toEqual(['Kanban', 'Runs', 'Terminal']));
    await dockRunsBelow();

    tabs = await shellTabs();
    expect(tabs.map(t => t.textContent)).toEqual(['Kanban', 'Terminal']);
    fireEvent.click(within(tabs[1].parentElement!).getByRole('button', { name: /move .* left/i }));
    await waitFor(async () =>
      expect((await shellTabs()).map(t => t.textContent)).toEqual(['Terminal', 'Kanban']));
  });
});
