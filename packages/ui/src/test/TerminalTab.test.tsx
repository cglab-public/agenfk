/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TerminalTab } from '../components/TerminalTab';
import { clampSplitRatio } from '../splitRatio';
import { splitLeaf, type PaneTree } from '../splitTree';
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

/**
 * Two terminals, or a reason why not (CGLAB-192).
 *
 * splitAvailability.test.ts proves the decision. This proves the control
 * exists, is DISABLED RATHER THAN ABSENT, and carries its reason where a
 * person will read it.
 */
describe('splitting the view', () => {
  /*
   * jsdom's window is 1024 px wide, which is BELOW the two-pane floor - so
   * without this every split here would be disabled for the right reason and
   * the tests would pass while proving nothing about the enabled path.
   */
  beforeEach(() => { Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true }); });

  const two = () => ({
    ...baseProps(),
    sessions: [
      { id: 's1', itemId: 'i1', title: 'A card', agentId: 'claude-code', autoApprove: false, persist: false, openedAt: new Date().toISOString() },
      { id: 's2', itemId: 'i2', title: 'Another card', agentId: 'codex', autoApprove: false, persist: false, openedAt: new Date().toISOString() },
    ],
    activeId: 's1',
  });

  it('offers a split on the tab that is not on screen', () => {
    renderTab(<TerminalTab {...two()} onToggleSplit={vi.fn()} />);
    const controls = screen.getAllByTestId('tab-split');
    // Not on the active tab: splitting a session with itself is not a thing,
    // and a disabled control there is noise rather than instruction.
    expect(controls).toHaveLength(1);
    expect(controls[0]).toBeEnabled();
  });

  it('asks the shell, and never splits itself', () => {
    // "Split is asked for, never automatic." The component reports the intent
    // and the shell decides, so nothing here can open a second pane on its own.
    const onToggleSplit = vi.fn();
    renderTab(<TerminalTab {...two()} onToggleSplit={onToggleSplit} />);
    fireEvent.click(screen.getByTestId('tab-split'));
    expect(onToggleSplit).toHaveBeenCalledWith('s2', 'horizontal');
  });

  it('is DISABLED WITH ITS REASON rather than absent', () => {
    /*
     * THE test. A control that vanishes teaches nothing and invites the same
     * attempt tomorrow; a greyed one that says why teaches once.
     */
    renderTab(<TerminalTab {...two()} onToggleSplit={vi.fn()} splitDisabledReason="Close the git panel to fit two terminals." />);
    const control = screen.getByTestId('tab-split');
    expect(control, 'the control was removed instead of disabled').toBeInTheDocument();
    expect(control).toBeDisabled();
    expect(control.getAttribute('title')).toMatch(/close the git panel/i);
    expect(control.getAttribute('aria-label'), 'a screen reader was told nothing').toMatch(/unavailable/i);
  });

  it('does not offer a split at all when the shell cannot take one', () => {
    // No handler means the feature is not wired here; rendering a dead button
    // would be worse than rendering none.
    renderTab(<TerminalTab {...two()} />);
    expect(screen.queryAllByTestId('tab-split')).toHaveLength(0);
  });

  it('shows the second pane beside the first, without unmounting either', () => {
    // Hidden, never unmounted: unmounting kills the process. Both panes are
    // visible, and the rest stay mounted and hidden.
    const { container } = renderTab(<TerminalTab {...two()} splitId="s2" onToggleSplit={vi.fn()} />);
    const panes = [...container.querySelectorAll('[hidden]')];
    expect(panes, 'a pane was left on screen that should be hidden').toHaveLength(0);
  });
});

/**
 * The split path that actually SHIPS (review of eda62114).
 *
 * The test above named "is DISABLED WITH ITS REASON" injects
 * `splitDisabledReason` - a prop AppShell never passes. So it exercised a prop
 * that is dead in production and never touched the code that ships: mutating
 * `splitBlocked` to a constant null left 21 of 21 green. These drive the real
 * path, through the component's own width arithmetic.
 */
describe('a narrow window fits and ADVISES, it does not refuse', () => {
  const two = () => ({
    ...baseProps(),
    sessions: [
      { id: 's1', itemId: 'i1', title: 'A card', agentId: 'claude-code', autoApprove: false, persist: false, openedAt: new Date().toISOString() },
      { id: 's2', itemId: 'i2', title: 'Another card', agentId: 'codex', autoApprove: false, persist: false, openedAt: new Date().toISOString() },
    ],
    activeId: 's1',
  });
  const width = (px: number) => Object.defineProperty(window, 'innerWidth', { value: px, configurable: true });

  it('does NOT refuse the split on a narrow window', () => {
    /*
     * The gate was 1184px - two 592px panes - and it let the product refuse an
     * arrangement the person could see and wanted. The arithmetic behind it is
     * ADVICE (a narrow pane wraps its lines), not a rule; the reader is looking
     * at the terminal and can judge.
     */
    width(1000);
    renderTab(<TerminalTab {...two()} onToggleSplit={vi.fn()} />);
    expect(screen.getByTestId('tab-split'), 'the width gate refused it again').toBeEnabled();
  });

  it('is still enabled with the sidebar open, on a window it used to refuse', () => {
    width(1300);
    renderTab(<TerminalTab {...two()} onToggleSplit={vi.fn()} sidebarWidthPx={224} />);
    expect(screen.getByTestId('tab-split')).toBeEnabled();
  });

  it('SAYS a pane got narrow once the split is on, instead of blocking it', () => {
    width(900);
    renderTab(<TerminalTab {...two()} splitId="s2" onToggleSplit={vi.fn()} sidebarWidthPx={224} />);
    expect(screen.getByTestId('split-narrow-reason'), 'nothing told the reader the pane was tight').toBeInTheDocument();
  });
});

describe('the split divider', () => {
  beforeEach(() => { Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true }); });

  const withSplit = (splitId: string | null) => ({
    ...baseProps(),
    sessions: [
      { id: 's1', itemId: 'i1', title: 'A card', agentId: 'claude-code', autoApprove: false, persist: false, openedAt: new Date().toISOString() },
      { id: 's2', itemId: 'i2', title: 'Another card', agentId: 'codex', autoApprove: false, persist: false, openedAt: new Date().toISOString() },
    ],
    activeId: 's1',
    splitId,
  });

  it('is on screen when two panes are', () => {
    renderTab(<TerminalTab {...withSplit('s2')} onToggleSplit={vi.fn()} />);
    const divider = screen.getByTestId('terminal-split-divider');
    expect(divider).toBeInTheDocument();
    expect(divider).toHaveAttribute('role', 'separator');
    expect(divider).toHaveAttribute('aria-orientation', 'vertical');
    // Reachable without a pointer, which jsdom cannot provide.
    expect(divider).toHaveAttribute('tabindex', '0');
  });

  it('is absent with a single pane, split or not', () => {
    renderTab(<TerminalTab {...baseProps()} onToggleSplit={vi.fn()} />);
    expect(screen.queryByTestId('terminal-split-divider')).toBeNull();

    // splitId naming the ACTIVE pane is still one pane, not two.
    renderTab(<TerminalTab {...withSplit('s1')} onToggleSplit={vi.fn()} />);
    expect(screen.queryByTestId('terminal-split-divider')).toBeNull();
  });

  it('does NOT give a lone pane a split width when the splitId dangles', () => {
    /*
     * The regression review caught: splitId is not cleared when its tab is
     * closed or when it becomes the active pane. Before the ratio style
     * existed that was a harmless no-op; giving the only pane a 50% basis
     * would collapse the terminal to half the row with no divider to drag it
     * back. `leadingPaneId` is gated on showDivider, not on splitId.
     */
    renderTab(<TerminalTab {...withSplit('s1')} onToggleSplit={vi.fn()} sidebarWidthPx={224} />);
    expect(screen.queryByTestId('terminal-split-divider')).toBeNull();
    const fullRow = 1600 - 224;
    const width = parseFloat(screen.getAllByTestId('terminal-pane')[0].style.width);
    expect(width, 'the lone pane was given half the row').toBeGreaterThan(fullRow / 2);
  });

  it('does not arm a drag on a right-click', () => {
    localStorage.setItem('agenfk_split_ratio', '0.3');
    renderTab(<TerminalTab {...withSplit('s2')} onToggleSplit={vi.fn()} sidebarWidthPx={224} />);
    const panes = screen.getAllByTestId('terminal-pane');
    const before = panes[0].style.width;
    const divider = screen.getByTestId('terminal-split-divider');
    fireEvent.pointerDown(divider, { button: 2, pointerId: 1 });
    // A move WITH a button held, which only acts if the right-click armed it.
    fireEvent.pointerMove(divider, { clientX: 999, buttons: 1, pointerId: 1 });
    expect(panes[0].style.width, 'a right-click armed a drag').toBe(before);
  });

  it('persists the position when the drag ends, not on every move', () => {
    localStorage.removeItem('agenfk_split_ratio');
    renderTab(<TerminalTab {...withSplit('s2')} onToggleSplit={vi.fn()} sidebarWidthPx={224} />);
    const divider = screen.getByTestId('terminal-split-divider');
    fireEvent.pointerDown(divider, { button: 0, pointerId: 1 });
    expect(localStorage.getItem('agenfk_split_ratio'), 'a mid-drag move wrote the preference').toBeNull();
    fireEvent.pointerUp(divider, { pointerId: 1 });
    expect(localStorage.getItem('agenfk_split_ratio')).not.toBeNull();
  });

  it('applies a stored ratio, and clamps only one that would erase a pane', () => {
    /*
     * The old floor (592px, the 80-column width) clamped 0.75 down and left the
     * divider a ~32px range, which is why dragging left looked broken. A ratio
     * that leaves both panes real is now honoured; only one that would erase a
     * pane is clamped, and the header SAYS a pane got narrow.
     */
    const fullRow = 1600 - 224;
    localStorage.setItem('agenfk_split_ratio', '0.75');
    renderTab(<TerminalTab {...withSplit('s2')} onToggleSplit={vi.fn()} sidebarWidthPx={224} />);
    expect(parseFloat(screen.getAllByTestId('terminal-pane')[0].style.width)).toBeCloseTo(0.75 * fullRow, 0);
  });

  it('clamps a stored ratio that would leave a pane with no width at all', () => {
    const fullRow = 1600 - 224;
    const clamped = clampSplitRatio(0.999, fullRow);
    localStorage.setItem('agenfk_split_ratio', '0.999');
    renderTab(<TerminalTab {...withSplit('s2')} onToggleSplit={vi.fn()} sidebarWidthPx={224} />);
    expect(parseFloat(screen.getAllByTestId('terminal-pane')[0].style.width)).toBeCloseTo(clamped * fullRow, 0);
    expect(clamped).toBeLessThan(1);
  });

  /** jsdom lays nothing out, so the pane is given the rectangle the gesture reads. */
  const rectFor = (pane: HTMLElement) => {
    (pane as any).getBoundingClientRect = () => ({
      left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400, x: 0, y: 0, toJSON: () => ({}),
    });
  };

  /**
   * jsdom has no DragEvent, and fireEvent.drop does not carry clientX or a
   * dataTransfer through - so the event React will actually read is built by
   * hand. Without this the handler sees `undefined - undefined` and the test
   * would pass by computing null, which proves nothing.
   */
  const dropOn = (pane: HTMLElement, dropped: string, clientX: number, clientY: number) => {
    rectFor(pane);
    const evt = new Event('drop', { bubbles: true, cancelable: true }) as any;
    evt.clientX = clientX;
    evt.clientY = clientY;
    evt.dataTransfer = { getData: () => dropped };
    pane.dispatchEvent(evt);
  };

  it('splits when a tab is dropped on a pane EDGE', () => {
    const onToggleSplit = vi.fn();
    renderTab(<TerminalTab {...withSplit(null)} onToggleSplit={onToggleSplit} sidebarWidthPx={224} />);
    dropOn(screen.getAllByTestId('terminal-pane')[0], 's2', 595, 200);
    expect(onToggleSplit, 'the right edge did not split').toHaveBeenCalledWith('s2', 'horizontal');
  });

  it('stacks when the drop is on the BOTTOM edge', () => {
    /*
     * THE BUG: the direction was computed and thrown away - `onToggleSplit`
     * carried only the session id - so every drop produced a side-by-side pair
     * and the bottom edge simply did not obey.
     */
    const onToggleSplit = vi.fn();
    renderTab(<TerminalTab {...withSplit(null)} onToggleSplit={onToggleSplit} sidebarWidthPx={224} />);
    dropOn(screen.getAllByTestId('terminal-pane')[0], 's2', 300, 395);
    expect(onToggleSplit, 'the bottom edge did not stack').toHaveBeenCalledWith('s2', 'vertical');
  });

  it('does not split on a drop in the MIDDLE - that is a move', () => {
    const onToggleSplit = vi.fn();
    renderTab(<TerminalTab {...withSplit(null)} onToggleSplit={onToggleSplit} sidebarWidthPx={224} />);
    dropOn(screen.getAllByTestId('terminal-pane')[0], 's2', 300, 200);
    expect(onToggleSplit).not.toHaveBeenCalled();
  });

  /** A dragover carrying the tab MIME - the only thing readable mid-drag. */
  const dragOver = (pane: HTMLElement, clientX: number, clientY: number) => {
    rectFor(pane);
    const evt = new Event('dragover', { bubbles: true, cancelable: true }) as any;
    evt.clientX = clientX;
    evt.clientY = clientY;
    evt.dataTransfer = { types: ['application/x-agenfk-session'], getData: () => '' };
    act(() => { pane.dispatchEvent(evt); });
  };

  it('shows WHERE it will land while the drag is in the air', () => {
    /*
     * The zone exists either way; SHOWING it is the difference between a
     * gesture you aim and one you guess at. Before this the pane simply split
     * when you let go, with nothing telling you which half you were over.
     */
    renderTab(<TerminalTab {...withSplit(null)} onToggleSplit={vi.fn()} sidebarWidthPx={224} />);
    const pane = screen.getAllByTestId('terminal-pane')[0];
    dragOver(pane, 595, 200);
    const hint = screen.getByTestId('drop-zone-hint');
    expect(hint).toHaveAttribute('data-zone', 'horizontal-after');
    expect(hint.style.right, 'the hint did not cover the right half').toBe('0px');
  });

  it('shows the whole side, not a sliver, for the other edges', () => {
    renderTab(<TerminalTab {...withSplit(null)} onToggleSplit={vi.fn()} sidebarWidthPx={224} />);
    const pane = screen.getAllByTestId('terminal-pane')[0];
    dragOver(pane, 300, 395);
    expect(screen.getByTestId('drop-zone-hint')).toHaveAttribute('data-zone', 'vertical-after');
    expect(screen.getByTestId('drop-zone-hint').style.height).toBe('50%');
  });

  it('shows NO hint in the middle, where a drop would not split', () => {
    renderTab(<TerminalTab {...withSplit(null)} onToggleSplit={vi.fn()} sidebarWidthPx={224} />);
    const pane = screen.getAllByTestId('terminal-pane')[0];
    dragOver(pane, 300, 200);
    expect(screen.queryByTestId('drop-zone-hint')).toBeNull();
  });

  it('will not split a pane with the session it already shows', () => {
    const onToggleSplit = vi.fn();
    renderTab(<TerminalTab {...withSplit(null)} onToggleSplit={onToggleSplit} sidebarWidthPx={224} />);
    dropOn(screen.getAllByTestId('terminal-pane')[0], 's1', 595, 200);
    expect(onToggleSplit).not.toHaveBeenCalled();
  });
});

/**
 * The tree owns the layout (7a717cb8, 3b).
 *
 * Two panes were the ceiling because the shell kept a `splitId`: one id, one
 * direction, one divider. The shape above is a binary tree, so the partition
 * works at three panes and nests - and every split gets its OWN divider, whose
 * ratio is measured in its own node rather than in the window.
 */
describe('a pane tree of more than two', () => {
  beforeEach(() => { Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true }); });

  const sessions = () => [
    { id: 's1', itemId: 'i1', title: 'A card', agentId: 'claude-code', autoApprove: false, persist: false, openedAt: new Date().toISOString() },
    { id: 's2', itemId: 'i2', title: 'Another card', agentId: 'codex', autoApprove: false, persist: false, openedAt: new Date().toISOString() },
    { id: 's3', itemId: 'i3', title: 'A third card', agentId: 'pi', autoApprove: false, persist: false, openedAt: new Date().toISOString() },
  ];
  /* a | (b / c) - the nested case the pair could not express. */
  const nested = () => {
    let t: PaneTree = { type: 'leaf', sessionId: 's1' };
    t = splitLeaf(t, 's1', 'horizontal', 's2')!;
    return splitLeaf(t, 's2', 'vertical', 's3')!;
  };
  const treeProps = () => ({
    ...baseProps(),
    sessions: sessions(),
    activeId: 's1',
    paneTree: nested(),
    onPaneTreeChange: vi.fn(),
    onDropSession: vi.fn(),
    onToggleSplit: vi.fn(),
  });

  it('draws every leaf, and one divider per split', () => {
    const { container } = renderTab(<TerminalTab {...treeProps()} />);
    const visible = [...container.querySelectorAll('[data-testid="terminal-pane"]')]
      .filter(p => !p.hasAttribute('hidden'));
    expect(visible, 'not every pane in the tree reached the screen').toHaveLength(3);
    // One per split, not one for the pair: the nested boundary needs its own.
    expect(screen.getAllByTestId('terminal-split-divider')).toHaveLength(2);
  });

  it('says a pane tab is a PANE, not "split with"', () => {
    // The strip read `splitId` to decide this, and the shell no longer passes
    // one - so every pane tab would have said "Split with X" while clicking it
    // REMOVED the pane. The label has to describe the action it performs.
    renderTab(<TerminalTab {...treeProps()} />);
    const controls = screen.getAllByTestId('tab-split');
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) {
      expect(c.getAttribute('aria-label')).toMatch(/unsplit/i);
    }
  });

  it('routes a drop on a pane edge to the tree, carrying the edge', () => {
    const onDropSession = vi.fn();
    renderTab(<TerminalTab {...treeProps()} onDropSession={onDropSession} />);
    const pane = screen.getAllByTestId('terminal-pane')[0];
    (pane as any).getBoundingClientRect = () => ({
      left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400, x: 0, y: 0, toJSON: () => ({}),
    });
    // s3 is not in the tree; dropping it here SPLITS s1. The right edge is
    // horizontal-after, which is what the shell turns into splitLeaf.
    const evt = new Event('drop', { bubbles: true, cancelable: true }) as any;
    evt.clientX = 595; evt.clientY = 200;
    evt.dataTransfer = { getData: () => 's3' };
    act(() => { pane.dispatchEvent(evt); });
    expect(onDropSession).toHaveBeenCalledWith('s3', 's1', { direction: 'horizontal', placement: 'after' });
  });
});

/**
 * Reordering the strip (e488bcdd).
 *
 * The order was the order the sessions were opened and could not change. With
 * three or more sessions the tab you want beside the active one can sit at the
 * far end, and with a split open, choosing the pair is a person's decision -
 * dragging is how a person expresses order without thinking.
 *
 * The drag payload is the SAME one the pane edges use; the tab strip answers a
 * drop on a TAB as a reorder, and a drop on a pane as a split. The pane's top
 * zone already excludes the strip for exactly this reason.
 */
describe('reordering the tab strip', () => {
  const three = () => ({
    ...baseProps(),
    sessions: [
      { id: 's1', itemId: 'i1', title: 'A card', agentId: 'claude-code', autoApprove: false, persist: false, openedAt: new Date().toISOString() },
      { id: 's2', itemId: 'i2', title: 'Another card', agentId: 'codex', autoApprove: false, persist: false, openedAt: new Date().toISOString() },
      { id: 's3', itemId: 'i3', title: 'A third card', agentId: 'pi', autoApprove: false, persist: false, openedAt: new Date().toISOString() },
    ],
    activeId: 's1',
    onReorder: vi.fn(),
  });

  /** jsdom lays nothing out, so the tab is given the rect the gesture reads. */
  const rect = (el: HTMLElement, width: number) => {
    (el as any).getBoundingClientRect = () => ({
      left: 0, top: 0, width, height: 40, right: width, bottom: 40, x: 0, y: 0, toJSON: () => ({}),
    });
  };
  const dropOnTab = (tab: HTMLElement, dropped: string, clientX: number, width: number) => {
    rect(tab, width);
    const evt = new Event('drop', { bubbles: true, cancelable: true }) as any;
    evt.clientX = clientX; evt.clientY = 20;
    evt.dataTransfer = { getData: () => dropped, types: ['application/x-agenfk-session'] };
    act(() => { tab.dispatchEvent(evt); });
  };

  it('reports the tab dropped on, and which half', () => {
    const onReorder = vi.fn();
    renderTab(<TerminalTab {...three()} onReorder={onReorder} />);
    const tabs = screen.getAllByTestId('terminal-tab');
    dropOnTab(tabs[0], 's3', 150, 200);        // right half of the first tab
    expect(onReorder).toHaveBeenCalledWith('s3', 's1', 'after');
  });

  it('says BEFORE on the left half', () => {
    const onReorder = vi.fn();
    renderTab(<TerminalTab {...three()} onReorder={onReorder} />);
    const tabs = screen.getAllByTestId('terminal-tab');
    dropOnTab(tabs[1], 's3', 20, 200);         // left half
    expect(onReorder).toHaveBeenCalledWith('s3', 's2', 'before');
  });

  it('offers no drop target at all when the shell cannot reorder', () => {
    // No handler means the feature is not wired; a drop then falls through and
    // does nothing, rather than moving a tab into an order nobody owns.
    renderTab(<TerminalTab {...three()} onReorder={undefined} />);
    const tabs = screen.getAllByTestId('terminal-tab');
    dropOnTab(tabs[0], 's3', 150, 200);
    expect(screen.queryByTestId('tab-reorder-hint')).toBeNull();
  });
});
