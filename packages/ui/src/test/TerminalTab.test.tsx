/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TerminalTab } from '../components/TerminalTab';
import { api } from '../api';

vi.mock('../api', () => ({ api: { getGitStatus: vi.fn() } }));

beforeEach(() => {
  // No desktop bridge: the panes render their "desktop only" notice instead of
  // booting xterm, which is irrelevant to what this file asserts and keeps the
  // tests from depending on a canvas.
  delete (window as unknown as Record<string, unknown>).agenfkDesktop;
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.getGitStatus).mockResolvedValue({ changed: 0, staged: 0, files: [] } as never);
});
afterEach(cleanup);

/**
 * A provider, because the top bar asks git for the counts.
 *
 * It has to ask even with the panel closed - see the describe below - so the
 * query belongs to the bar as much as to the panel, and every render in this
 * file now needs somewhere for it to live.
 */
const renderTab = (ui: React.ReactElement) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>,
);

const baseProps = () => ({
  sessions: [{
    id: 's1', itemId: 'i1', title: 'A card', agentId: 'claude-code',
    autoApprove: false, persist: false, openedAt: new Date().toISOString(),
  }],
  activeId: 's1',
  onSelect: vi.fn(),
  onClose: vi.fn(),
  onNew: vi.fn(),
});


/**
 * Opening the worktree in an editor (CGLAB-174).
 *
 * The point is that the user never has to find the path: a worktree lives at
 * ~/.agenfk-worktrees/<repo>/<branch>-<hash>, which nobody is going to type.
 *
 * It belongs on the terminal header because that is where the user already is
 * when they want it — they are looking at the agent's output and want to see
 * the files it just changed.
 */
describe('opening the worktree in an editor', () => {
  it('offers the editors that are installed', async () => {
    renderTab(<TerminalTab {...baseProps()} editors={[{ id: 'vscode', label: 'VS Code' }]} />);
    expect(await screen.findByRole('button', { name: /open in vs code/i })).toBeInTheDocument();
  });

  it('asks for the CARD and the editor, never a path', async () => {
    // The renderer must not be able to name a directory: the path comes from
    // the server's record of which worktree the card owns.
    const onOpenInEditor = vi.fn();
    renderTab(
      <TerminalTab
        {...baseProps()}
        editors={[{ id: 'vscode', label: 'VS Code' }]}
        onOpenInEditor={onOpenInEditor}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /open in vs code/i }));
    expect(onOpenInEditor).toHaveBeenCalledWith('i1', 'vscode');
  });

  it('offers nothing when no editor is installed', async () => {
    // A button that opens nothing and explains nothing is worse than no
    // button. The path is still reachable — it is on screen in the header.
    renderTab(<TerminalTab {...baseProps()} editors={[]} />);
    await screen.findByRole('tablist', { name: /open terminals/i });
    expect(screen.queryByRole('button', { name: /open in/i })).toBeNull();
  });
});

/**
 * CHANGED and STAGED, moved into the top bar (CGLAB-193).
 *
 * They were a header row INSIDE the worktree panel: two static labels with
 * counts, above a list that showed changed and staged files together with a
 * badge on the staged ones. Not a switch at all - saying so was a mistake in
 * the request, and worth recording because the change reads differently once
 * you know it: this makes them controls for the first time.
 *
 * WHAT THE CHANGE IS FOR IS SPACE, and the vertical pixels the header row gave
 * back are the small half of it. The panel is 288px of fixed width beside the
 * terminal, and until now there was no way to get rid of it. Making these
 * buttons open the panel is what makes it closeable, and a closed panel is the
 * full width of the window back.
 *
 * Which forces the counts up into the bar rather than merely inviting it: with
 * the panel closed they are the only thing on screen saying the worktree has
 * changes at all, so a button that hid its own count would close the panel and
 * take the reason to reopen it with them.
 *
 * TOGGLE, not open. Pressing the button for the view already showing closes the
 * panel. The alternative - open-only, with a separate close control on the
 * panel - is two controls for one piece of state, and the pair already has to
 * carry three states between them.
 */
describe('the worktree counts in the terminal bar', () => {
  const withChanges = () => {
    vi.mocked(api.getGitStatus).mockResolvedValue({
      changed: 2, staged: 1,
      files: [
        { path: 'a.ts', staged: false, state: 'modified' },
        { path: 'b.ts', staged: false, state: 'untracked' },
        { path: 'c.ts', staged: true, state: 'added' },
      ],
    } as never);
  };

  const changedButton = () => screen.findByRole('button', { name: /changed \(\d+\)/i });
  const stagedButton = () => screen.findByRole('button', { name: /staged \(\d+\)/i });
  const panel = () => screen.queryByRole('complementary', { name: /worktree/i });

  it('puts both counts in the bar', async () => {
    // Waited for rather than read straight off: the counts arrive from git,
    // and the buttons render with a zero before the answer does. Asserting
    // immediately would be asserting the placeholder.
    withChanges();
    renderTab(<TerminalTab {...baseProps()} showWorktree />);
    await waitFor(async () => expect(await changedButton()).toHaveTextContent('Changed (2)'));
    expect(await stagedButton()).toHaveTextContent('Staged (1)');
  });

  it('shows the counts with the panel closed, which is the point of moving them', async () => {
    // Closed, these two are the only thing on screen saying the worktree has
    // changes. A count that went away with the panel would take the reason to
    // reopen it along with it.
    withChanges();
    renderTab(<TerminalTab {...baseProps()} showWorktree />);
    await waitFor(async () => expect(await changedButton()).toHaveTextContent('Changed (2)'));
    expect(panel()).toBeNull();
  });

  it('starts closed, so the terminal has the full width', async () => {
    withChanges();
    renderTab(<TerminalTab {...baseProps()} showWorktree />);
    await changedButton();
    expect(panel(), 'the panel opened without being asked for').toBeNull();
  });

  it('opens the panel on the view whose button was pressed', async () => {
    withChanges();
    renderTab(<TerminalTab {...baseProps()} showWorktree />);
    fireEvent.click(await changedButton());
    expect(await screen.findByText('a.ts')).toBeInTheDocument();
    // The CHANGED view, so the staged file is not in it.
    expect(screen.queryByText('c.ts')).toBeNull();
  });

  it('opens on the staged files when that is the button pressed', async () => {
    withChanges();
    renderTab(<TerminalTab {...baseProps()} showWorktree />);
    fireEvent.click(await stagedButton());
    expect(await screen.findByText('c.ts')).toBeInTheDocument();
    expect(screen.queryByText('a.ts')).toBeNull();
  });

  it('closes again when the button for the view already showing is pressed', async () => {
    // The promise the label makes on a second click. Open-only would need a
    // separate close control, which is two controls for one piece of state.
    withChanges();
    renderTab(<TerminalTab {...baseProps()} showWorktree />);
    fireEvent.click(await changedButton());
    await screen.findByText('a.ts');
    fireEvent.click(await changedButton());
    await waitFor(() => expect(panel()).toBeNull());
  });

  it('switches view rather than closing when the other button is pressed', async () => {
    withChanges();
    renderTab(<TerminalTab {...baseProps()} showWorktree />);
    fireEvent.click(await changedButton());
    await screen.findByText('a.ts');
    fireEvent.click(await stagedButton());
    expect(await screen.findByText('c.ts')).toBeInTheDocument();
    expect(panel()).not.toBeNull();
  });

  it('presses neither button while the panel is closed', async () => {
    /*
     * Three states, not a two-way switch: changed showing, staged showing, or
     * nothing showing. `aria-pressed` can say "neither", which is why these are
     * buttons rather than tabs - `aria-selected` on a tablist has to have a
     * selected tab, so a closed panel would have to lie about one of them.
     */
    withChanges();
    renderTab(<TerminalTab {...baseProps()} showWorktree />);
    expect(await changedButton()).toHaveAttribute('aria-pressed', 'false');
    expect(await stagedButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('presses exactly the button whose view is showing', async () => {
    withChanges();
    renderTab(<TerminalTab {...baseProps()} showWorktree />);
    fireEvent.click(await stagedButton());
    await waitFor(async () => expect(await stagedButton()).toHaveAttribute('aria-pressed', 'true'));
    expect(await changedButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('remembers that the panel was closed, or closing it means nothing', async () => {
    // A panel that reopens itself on the next launch was never closed. The
    // sidebar and the Runs dock already persist the same way.
    withChanges();
    const { unmount } = renderTab(<TerminalTab {...baseProps()} showWorktree />);
    fireEvent.click(await changedButton());
    await screen.findByText('a.ts');
    fireEvent.click(await changedButton());
    await waitFor(() => expect(panel()).toBeNull());
    unmount();

    renderTab(<TerminalTab {...baseProps()} showWorktree />);
    await changedButton();
    expect(panel(), 'the panel reopened itself after being closed').toBeNull();
  });

  it('remembers which view was showing, not merely that it was open', async () => {
    withChanges();
    const { unmount } = renderTab(<TerminalTab {...baseProps()} showWorktree />);
    fireEvent.click(await stagedButton());
    await screen.findByText('c.ts');
    unmount();

    renderTab(<TerminalTab {...baseProps()} showWorktree />);
    expect(await screen.findByText('c.ts')).toBeInTheDocument();
    expect(screen.queryByText('a.ts')).toBeNull();
  });

  it('survives a stored value written by another build', async () => {
    // Same rule every other remembered preference here follows: an unreadable
    // value must not leave the panel in a state with no way out of it.
    localStorage.setItem('agenfk_worktree_panel', '{"not":"a view"}');
    withChanges();
    renderTab(<TerminalTab {...baseProps()} showWorktree />);
    expect(await changedButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps the pair apart from the editor button, which does a different thing', async () => {
    /*
     * "Open in VS Code" launches an application; these two change what is on
     * screen. Three identical buttons in a row would read as three of the same
     * kind of control, so the pair is grouped and the group is named.
     */
    withChanges();
    renderTab(<TerminalTab {...baseProps()} showWorktree editors={[{ id: 'vscode', label: 'VS Code' }]} />);
    const group = await screen.findByRole('group', { name: /worktree/i });
    expect(group).toContainElement(await changedButton());
    expect(group).toContainElement(await stagedButton());
    expect(group).not.toContainElement(screen.getByRole('button', { name: /open in vs code/i }));
  });

  it('asks git nothing when the worktree panel is not offered at all', async () => {
    // `showWorktree` is off for any caller that does not want a git poll every
    // four seconds. The counts are part of that panel, so they must not be the
    // thing that starts it.
    renderTab(<TerminalTab {...baseProps()} />);
    await new Promise(r => setTimeout(r, 20));
    expect(api.getGitStatus).not.toHaveBeenCalled();
  });
});
