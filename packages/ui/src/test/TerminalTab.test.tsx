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
 * The worktree, reached by ONE button in the top bar (CGLAB-193).
 *
 * CHANGED and STAGED were a header row INSIDE the panel: two static labels
 * above a list that showed both kinds of file together with a badge on the
 * staged ones. Not a switch at all.
 *
 * They were briefly promoted to TWO buttons in the bar, each opening the panel
 * on its own list. That was wrong and the user said so: the two are halves of
 * one question about one worktree, so splitting them made a reader close one
 * half to look at the other. One button opens the panel; the halves are tabs
 * inside it, where both counts are in view at once.
 *
 * WHAT THE CHANGE IS FOR IS SPACE. The panel is 288px of fixed width beside
 * the terminal and there was no way to be rid of it. The vertical pixels the
 * header row gave back are the small half.
 *
 * WHICH FORCES THE COUNTS INTO THE BUTTON rather than merely inviting it: with
 * the panel closed they are the only thing on screen saying the worktree has
 * changes at all, so a control that hid its own count would close the panel
 * and take away the reason to open it again.
 */
describe('the worktree button in the terminal bar', () => {
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

  /* Found by its counts, which is the contract: a button that stops showing
     them still matches a looser selector and the test would not notice. */
  const worktreeButton = () => screen.findByRole('button', { name: /2\s*\/\s*1/ });
  const openTab = () => renderTab(<TerminalTab {...baseProps()} showWorktree />);
  const panel = () => screen.queryByRole('complementary', { name: /worktree/i });

  it('offers one control, not one per list', async () => {
    // THE correction. Two buttons meant closing one half to see the other.
    withChanges();
    openTab();
    await worktreeButton();
    expect(screen.queryByRole('button', { name: /^changed/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^staged/i })).toBeNull();
  });

  it('carries both counts, so the panel need not be open to see them', async () => {
    withChanges();
    openTab();
    expect(await worktreeButton()).toBeInTheDocument();
    expect(panel()).toBeNull();
  });

  it('starts closed, so the terminal has the full width', async () => {
    withChanges();
    openTab();
    await worktreeButton();
    expect(panel()).toBeNull();
  });

  it('opens the panel, with both lists reachable inside it', async () => {
    withChanges();
    openTab();
    fireEvent.click(await worktreeButton());
    expect(panel()).not.toBeNull();
    // Both halves in view at once, which is what the single button buys.
    expect(screen.getByRole('tab', { name: /changed/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /staged/i })).toBeInTheDocument();
  });

  it('closes again when pressed a second time', async () => {
    // A toggle rather than open-only. Open-only needs a separate close control
    // on the panel, which is two controls for one piece of state.
    withChanges();
    openTab();
    fireEvent.click(await worktreeButton());
    fireEvent.click(await worktreeButton());
    expect(panel()).toBeNull();
  });

  it('is unmounted when closed, not merely hidden', async () => {
    /*
     * The assertion the whole change rests on. A hidden 288px aside still
     * occupies its column, so hiding it would have given the terminal nothing
     * while looking exactly like a fix.
     */
    withChanges();
    openTab();
    fireEvent.click(await worktreeButton());
    fireEvent.click(await worktreeButton());
    expect(document.querySelector('[aria-label="Worktree"][class*="w-72"]')).toBeNull();
  });

  it('says whether it is showing, rather than leaving it to be guessed', async () => {
    withChanges();
    openTab();
    const button = await worktreeButton();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect((await worktreeButton()).getAttribute('aria-pressed')).toBe('true');
  });

  it('remembers that it was closed, or closing it means nothing', async () => {
    withChanges();
    const first = openTab();
    fireEvent.click(await worktreeButton());
    first.unmount();
    cleanup();
    openTab();
    expect((await worktreeButton()).getAttribute('aria-pressed')).toBe('true');
  });

  it('reads a value written by the two-button version as closed', async () => {
    /*
     * That version stored WHICH list was showing, so the stored value is a
     * string where this one expects a boolean. Closed is the right landing
     * place: it is the state with a way out of it in one click.
     */
    localStorage.setItem('agenfk_worktree_panel', JSON.stringify('staged'));
    withChanges();
    openTab();
    expect((await worktreeButton()).getAttribute('aria-pressed')).toBe('false');
  });
});

/**
 * The tab for the pane you are NOT looking at (CGLAB-191).
 *
 * tabState.test.ts proves the decision is right. This proves it is REACHED:
 * the dot was wired into the strip and the whole UI suite stayed green, which
 * says nothing about a branch no test renders.
 *
 * It also pins the wiring mistake that actually happened. The state map was
 * first built with a `useMemo` INSIDE the JSX, which sits behind whatever
 * conditions wrap that branch while React counts hooks by order. It took 54
 * tests red at once - the good outcome, since the same mistake in a
 * rarely-rendered branch would have shipped.
 */
describe('what the tab strip says about each session', () => {
  const two = () => ({
    ...baseProps(),
    sessions: [
      { id: 's1', itemId: 'i1', title: 'A card', agentId: 'claude-code', autoApprove: false, persist: false, openedAt: new Date().toISOString() },
      { id: 's2', itemId: 'i2', title: 'Another card', agentId: 'codex', autoApprove: false, persist: false, openedAt: new Date().toISOString() },
    ],
  });

  it('marks a failed session on its tab, while you are looking at the other one', async () => {
    /*
     * THE test. Five sessions, one visible - an agent that failed behind
     * another tab is otherwise invisible until you click it, so failures get
     * found by going looking, one tab at a time.
     */
    renderTab(<TerminalTab {...two()} activeId="s1" sessionStates={new Map([['s2', 'failed' as const]])} />);
    const dots = await screen.findAllByTestId('tab-state');
    expect(dots, 'the unselected tab said nothing about its agent').toHaveLength(1);
    expect(dots[0].getAttribute('data-state')).toBe('failed');
    expect(dots[0].className).toContain('red');
  });

  it('says nothing on a quiet tab, so the strip does not become noise', () => {
    renderTab(<TerminalTab {...two()} sessionStates={new Map([['s1', 'idle' as const], ['s2', 'idle' as const]])} />);
    expect(screen.queryAllByTestId('tab-state')).toHaveLength(0);
  });

  it('still says a running agent is alive', () => {
    // "the tab for the pane you are not looking at still tells you it is
    // alive" - the good case is visible, just not loud.
    renderTab(<TerminalTab {...two()} sessionStates={new Map([['s2', 'running' as const]])} />);
    const dot = screen.getByTestId('tab-state');
    expect(dot.getAttribute('data-state')).toBe('running');
    expect(dot.className, 'a healthy agent was painted in an alarm colour').not.toContain('red');
  });

  it('renders nothing when the shell passes no states at all', () => {
    // Every existing caller in the tests omits the prop; it must not throw or
    // paint a dot on everything.
    renderTab(<TerminalTab {...two()} />);
    expect(screen.queryAllByTestId('tab-state')).toHaveLength(0);
  });
});
