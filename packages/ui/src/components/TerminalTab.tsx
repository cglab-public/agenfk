/**
 * The Terminal tab: N open terminals, one per card (CGLAB-169).
 *
 * The load-bearing rule is that **every pane stays mounted**. Unmounting a
 * TerminalPane kills its session and destroys its scrollback, so a tab bar that
 * swapped panes in and out would mean switching tabs silently killed the agent
 * you switched away from — the exact catastrophe the panel-level `hidden`
 * already exists to prevent one level up. Inactive panes are hidden, never
 * removed.
 *
 * That also makes "click a card that already has a terminal" free: it is a
 * selection, not a spawn.
 */
import React from 'react';
import { clsx } from 'clsx';
import { tabIndicator, tabDotClass } from '../tabState';
import { WORKTREE_PANEL_PX } from '../splitAvailability';
import { clampSplitRatio, splitRatioBounds, DEFAULT_SPLIT_RATIO } from '../splitRatio';
import { layoutPanes } from '../splitGeometry';
import { dropZone, setRatioAtPath, ratioAtPath, leaves, type DropZone, type PaneTree, type SplitDirection } from '../splitTree';

/** The drag payload: which session a tab is carrying. */
export const SESSION_DRAG_MIME = 'application/x-agenfk-session';

/** The half of a pane a zone covers, for the drag hint. */
function dropHintStyle(zone: DropZone): React.CSSProperties {
  return zone.direction === 'horizontal'
    ? { top: 0, height: '100%', width: '50%', ...(zone.placement === 'before' ? { left: 0 } : { right: 0 }) }
    : { left: 0, width: '100%', height: '50%', ...(zone.placement === 'before' ? { top: 0 } : { bottom: 0 }) };
}
import type { SessionState } from '../sessionRow';
import { agentLabel } from '../agentLabels';
import { WorktreePanel } from './WorktreePanel';
import { useGitStatus, type WorktreeView } from '../gitStatus';
import { Columns2, X, Plus, GitBranch, FileDiff, Activity } from 'lucide-react';
import { TerminalPane } from './TerminalPane';
import { EmptyState } from './EmptyState';
import { AgentIcon } from './AgentIcon';
import { EditorIcon } from './EditorIcon';

export interface TerminalSession {
  /** Stable per open terminal, not per card: a card may have more than one. */
  readonly id: string;
  readonly itemId: string;
  readonly title: string;
  readonly agentId: string;
  readonly autoApprove: boolean;
  /**
   * Whether this session runs inside tmux.
   *
   * Listed here for the same reason as autoApprove: this type is the contract
   * between the shell and the pane, and a field the shell sets but this type
   * omits is silently dropped on the way through. That is precisely how it was
   * lost the first time — the shell computed it, the pane never received it,
   * and the setting looked wired end to end while doing nothing.
   */
  readonly persist: boolean;
  /**
   * Whether this session's process has ended.
   *
   * Set from the pane's own `pty:exit`, and the reason it lives on the session
   * rather than staying in the pane: the sessions rail was calling an exited
   * session "running", because the only signal it had was recency of OUTPUT —
   * and the exit message is itself output. A dead process is a FACT; it must
   * not have to age out of a liveness window.
   *
   * Per SESSION, never per card. Two agents can share a card, and one exiting
   * says nothing about the other — which is exactly why clearing liveness by
   * itemId would have been the wrong fix.
   */
  readonly exited?: boolean;
  /**
   * The code it exited WITH. Only meaningful alongside `exited`.
   *
   * Zero, or a user typing `exit`, is an ordinary end. Anything else is the
   * one failure this app can observe directly, and the rail keeps failures
   * however old — so losing this turned a crashed agent into a row that just
   * disappeared.
   */
  readonly exitCode?: number;
  /**
   * What the agent itself says it is doing, when it says anything.
   *
   * Undefined means NO OPINION, not idle. Two of our four agents publish
   * nothing on the terminal title — pi and gemini — and treating their silence
   * as rest would read as "asleep" for half the fleet. Where this is undefined
   * the rail falls back to output recency, which is wrong in the other
   * direction but at least is the behaviour that existed before.
   */
  readonly activity?: 'working' | 'blocked' | 'idle';
  /**
   * The state read off the rendered screen, for agents that publish no title.
   *
   * Kept apart from `activity` because the sources are not equivalent: one is
   * the agent's own word, the other is our reading of its drawing. A single
   * field would let whichever fired last win a disagreement in silence.
   */
  readonly screenActivity?: 'working' | 'blocked' | 'idle';
  /** Carried so the remembered row can be scoped to a project on restore. */
  readonly projectId?: string;
  /**
   * When this terminal was opened.
   *
   * Its own truth, not something derived at render: the rail's memo recomputes
   * whenever any card lights up, and stamping the time there reset every
   * terminal's elapsed display to "0s" on an unrelated card's event.
   */
  readonly openedAt: string;
  /** The conversation this tab holds, when the agent can be told one. */
  readonly agentSessionId?: string;
  /** True only for a tab being PUT BACK, never for one the user just opened. */
  readonly resume?: boolean;
  /** The server row remembering this tab, once it has been written. */
  readonly recordId?: string;
  /** The branch this card's worktree is on. */
  readonly branchName?: string | null;
  /** Shown as the breadcrumb root, so you know which repo you are in. */
  readonly projectName?: string;
}

export interface TerminalTabProps {
  readonly sessions: readonly TerminalSession[];
  /**
   * How each session is doing, keyed by session id (CGLAB-191).
   *
   * Passed in rather than computed here: `SessionRow.state` already holds this
   * and the rail already renders from it. A second opinion about whether an
   * agent is well is how the rail and the terminal came to disagree earlier in
   * this epic, and a disagreement is worse than either answer alone because
   * nothing on screen says which to believe.
   *
   * Optional, and absence is quiet rather than alarming: a tab exists from the
   * moment it is opened and its row appears when the agent first produces
   * something.
   */
  readonly sessionStates?: ReadonlyMap<string, SessionState>;
  /**
   * The second session on screen, or null for one pane (CGLAB-192).
   *
   * Owned by the shell rather than here: which pair belongs side by side is a
   * decision a person makes, and the shell is the only thing that knows what
   * else is open. Never set automatically on fan-out - three agents running
   * does not mean two panes open, and guessing the pair is wrong most of the
   * time and costs a pane to undo.
   */
  readonly splitId?: string | null;
  /**
   * The layout AS A TREE, owned by the shell (7a717cb8, 3b).
   *
   * When provided this is AUTHORITATIVE: it can hold any number of leaves and
   * nest, which the `splitId` pair cannot. When absent, the pair below is
   * derived from `activeId`/`splitId` so a caller that only ever wanted two
   * panes keeps working unchanged.
   */
  readonly paneTree?: PaneTree | null;
  /** The tree, after a split, a move or a divider drag. */
  readonly onPaneTreeChange?: (tree: PaneTree | null) => void;
  /**
   * A tab was dropped on a pane EDGE. The shell applies it to the tree.
   *
   * Separate from `onToggleSplit` because the pair could only ever toggle, and
   * a drop on the third pane of a nested tree is neither a toggle nor a pair.
   */
  readonly onDropSession?: (draggedId: string, targetId: string, zone: DropZone) => void;
  /** A tab was dropped on ANOTHER TAB: reorder the strip, before or after it. */
  readonly onReorder?: (draggedId: string, overId: string, side: 'before' | 'after') => void;
  /** Ask the shell to split with, or unsplit from, this session. */
  /**
   * Ask the shell to split with this session, ON THIS EDGE.
   *
   * The direction is not decoration: dropping a tab on the BOTTOM edge has to
   * stack, and this used to carry only the id - so every drop produced a
   * side-by-side pair and the bottom edge simply did not obey.
   */
  readonly onToggleSplit?: (sessionId: string, direction: SplitDirection) => void;
  /** Which way the pair is split right now. Horizontal by default. */
  readonly splitDirection?: SplitDirection;
  /**
   * Why Split cannot be used, or null when it can.
   *
   * Present rather than absent when unavailable: a control that vanishes
   * teaches nothing and invites the same attempt tomorrow.
   */
  readonly splitDisabledReason?: string | null;
  /**
   * How wide the sidebar is right now, in px.
   *
   * Passed in because it COLLAPSES - 224 px open, a 40 px rail closed - and
   * hardcoding 224 here refused the split on any window between 1224 and 1407
   * px with the sidebar collapsed, with 184 px going unused and a message that
   * was false: it said the window needs 1184 px while the row already had more
   * than that. Collapsing the sidebar fires no `resize`, so the wrong answer
   * did not even re-evaluate when the user tried the obvious remedy.
   */
  readonly sidebarWidthPx?: number;
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onClose: (id: string) => void;
  /** Opens the dialog for another terminal. */
  readonly onNew: () => void;
  /**
   * A pane reporting the conversation id its agent actually got.
   *
   * Routed through here rather than the pane talking to the server directly:
   * the shell owns what is remembered, and a component that both runs a
   * terminal and writes records is two jobs in one place.
   */
  readonly onSpawned?: (sessionId: string, agentSessionId: string | undefined) => void;
  /** A pane reporting that its terminal is producing output. */
  readonly onOutput?: (itemId: string) => void;
  /** A session's process ended. Carried by SESSION, never by card: two agents
   *  can share a card, and one exiting says nothing about the other. */
  /**
   * The process ended, and with WHICH code.
   *
   * The code used to be dropped here — `() => onExited?.(session.id)` swapped
   * the pane's only argument for the session id — so an agent that crashed was
   * indistinguishable from one the user typed `exit` into. Nothing downstream
   * could mark it failed, which left the rail's "a failure always stays" rule
   * guarding a state nothing could produce.
   */
  readonly onExited?: (sessionId: string, exitCode: number) => void;
  /** The agent published its state. By SESSION: two agents can share a card. */
  readonly onActivity?: (sessionId: string, activity: 'working' | 'blocked' | 'idle') => void;
  /** State read off the rendered screen. By SESSION, like the rest. */
  readonly onScreenActivity?: (sessionId: string, activity: 'working' | 'blocked' | 'idle') => void;
  /**
   * Editors installed on this machine, if any.
   *
   * Empty means no button at all: one that opens nothing and explains nothing
   * is worse than none, and the worktree path is already on screen in the
   * header for anyone who wants it.
   */
  readonly editors?: ReadonlyArray<{ id: string; label: string }>;
  /**
   * Open this CARD's worktree in that editor.
   *
   * A card and an editor id — never a path. The directory comes from the
   * server's record of which worktree the card owns, and the schemes the OS
   * can be asked to launch are a closed list in the main process.
   */
  readonly onOpenInEditor?: (itemId: string, editorId: string) => void;
  /**
   * Show the worktree panel beside the terminal.
   *
   * Off unless asked, because it polls git every few seconds and that is not
   * something to start doing on somebody's behalf.
   */
  readonly showWorktree?: boolean;
  /**
   * Whether the run feed is showing below the terminal.
   *
   * Passed in rather than owned here: the feed is a sibling of the terminal in
   * the shell's column, so the shell is the only thing that can say. Undefined
   * means the caller does not offer the control at all.
   */
  readonly runsOpen?: boolean;
  readonly onToggleRuns?: () => void;
}

/**
 * Whether the worktree panel is open, and on which list.
 *
 * `null` is closed, which is the third state the pair of buttons has to be
 * able to be in: neither list is showing, and neither button is pressed.
 *
 * Remembered, because a panel that reopens itself on the next launch was never
 * closed - and closing it is the point, since it is a fixed 288px the terminal
 * does not get back any other way. Same treatment the sidebar and the Runs
 * dock already get.
 */
const WORKTREE_PANEL_KEY = 'agenfk_worktree_panel';
/**
 * Is the worktree panel showing?
 *
 * Open or closed, and nothing else. It briefly stored WHICH list was showing,
 * from when the bar had two buttons; that choice belongs to the panel's own
 * tabs now. A stored value from that version is not a boolean, so it reads as
 * closed - which is the right landing place, because closed is the state with
 * a way out of it in one click.
 */
function readWorktreeOpen(): boolean {
  try { return JSON.parse(localStorage.getItem(WORKTREE_PANEL_KEY) ?? 'false') === true; }
  catch { return false; }
}

/**
 * Where the split divider sits, as a ratio of the row (b014cc86).
 *
 * Remembered so a person who widened the pane they are reading does not have
 * to do it again on the next launch. A ratio, not pixels, so it survives a
 * window resize with no second value to reconcile. Anything that is not a
 * ratio between 0 and 1 is ignored - a stored `0` would collapse a pane.
 */
const SPLIT_RATIO_KEY = 'agenfk_split_ratio';
function readSplitRatio(): number {
  try {
    const stored = Number(localStorage.getItem(SPLIT_RATIO_KEY));
    return Number.isFinite(stored) && stored > 0 && stored < 1 ? stored : DEFAULT_SPLIT_RATIO;
  } catch { return DEFAULT_SPLIT_RATIO; }
}
function writeSplitRatio(ratio: number): void {
  try { localStorage.setItem(SPLIT_RATIO_KEY, String(ratio)); } catch { /* private mode */ }
}

export function TerminalTab({
  sessions,
  sessionStates,
  splitId,
  paneTree,
  onPaneTreeChange,
  onDropSession,
  onReorder,
  onToggleSplit,
  splitDirection = 'horizontal',
  splitDisabledReason,
  sidebarWidthPx = 224,
  activeId,
  onSelect,
  onClose,
  onNew,
  onSpawned,
  onOutput,
  onExited,
  onActivity,
  onScreenActivity,
  editors,
  onOpenInEditor,
  showWorktree,
  runsOpen,
  onToggleRuns,
}: TerminalTabProps): React.ReactElement {
  // Seeded from storage in the initializer, so there is no first paint with
  // the panel open for someone who closed it.
  const [panelOpen, setPanelOpen] = React.useState<boolean>(() => readWorktreeOpen());

  /*
   * Whether two terminals fit right now (CGLAB-192).
   *
   * Decided HERE rather than in the shell because the git panel's open state
   * lives here, and the panel is 288 px of the same row the panes share - so
   * the shell cannot answer the question without being told the one thing it
   * does not know.
   */
  const [rowWidth, setRowWidth] = React.useState<number>(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth);
  React.useEffect(() => {
    const onResize = (): void => setRowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  /*
   * THE WIDTH GATE IS GONE. It was 1184px - two 592px panes - and it let the
   * product REFUSE an arrangement the person could see and wanted. The
   * arithmetic behind it (80 columns per pane) is ADVICE, not a rule: a pane
   * that gets narrow wraps its lines, and the reader is looking straight at it
   * and can judge what that costs. So panes are fitted and MARKED instead
   * (`layoutPanes().narrow`), and the only thing that can still block the Split
   * control is an explicit reason from the shell.
   */
  const splitBlocked = splitDisabledReason ?? null;

  /*
   * The divider position, clamped by the floor wherever it moves. The width is
   * MEASURED from the row, not derived from the window, because the worktree
   * panel shares the row and would otherwise be counted twice.
   */
  const [splitRatio, setSplitRatio] = React.useState<number>(() => readSplitRatio());
  const splitRowRef = React.useRef<HTMLDivElement | null>(null);
  const draggingDivider = React.useRef(false);
  /*
   * The width the panes actually get: window, minus the sidebar, minus the
   * worktree panel when it shares the row. Derived rather than measured so the
   * floor holds BEFORE the first paint and after a window resize - a stored
   * ratio clamped against a wider window is not a ratio the floor allows here.
   */
  const paneRowPx = rowWidth - sidebarWidthPx - (panelOpen ? WORKTREE_PANEL_PX : 0);
  const shownRatio = clampSplitRatio(splitRatio, paneRowPx);
  const ratioBounds = splitRatioBounds(paneRowPx);
  /*
   * The panes are FLAT and positioned by RECTANGLE, not by a recursive tree of
   * flex boxes (7a717cb8). Two reasons, and the first is not negotiable: a
   * recursive render re-parents a pane when the tree changes, and re-parenting
   * unmounts it - which kills the PTY and the scrollback with it. Flat panes
   * keep one stable parent each, so the layout can change freely.
   *
   * The second: the arithmetic lives in `layoutPanes`, so where a boundary
   * lands and which pane is narrow is testable without a DOM.
   */
  const [rowSize, setRowSize] = React.useState<{ width: number; height: number }>({ width: 0, height: 0 });
  /** Which edge the drag in flight would land on, per pane. Null when none. */
  const [dropHint, setDropHint] = React.useState<{ sessionId: string; zone: DropZone } | null>(null);
  /** Where a tab drag would insert, while it is over the strip. */
  const [reorderHint, setReorderHint] = React.useState<{ overId: string; side: 'before' | 'after' } | null>(null);
  React.useLayoutEffect(() => {
    const el = splitRowRef.current;
    if (!el) return;
    const measure = (): void => setRowSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sessions.length]);

  const persistSplit = React.useCallback((): void => {
    draggingDivider.current = false;
    setSplitRatio(current => { writeSplitRatio(current); return current; });
  }, []);
  /*
   * The tree this component draws. The SHELL's tree when it provides one -
   * that is what 3b is: more than two leaves, nested, a divider per split. The
   * pair derived from `splitId`/`activeId` is the fallback for a caller that
   * only ever wanted two panes, and it is a one-split tree like any other, so
   * there is no second rendering path.
   */
  const derivedPair: PaneTree = splitId && activeId && splitId !== activeId
    ? {
        type: 'split', direction: splitDirection,
        first: { type: 'leaf', sessionId: activeId },
        second: { type: 'leaf', sessionId: splitId },
        ratio: shownRatio,
      }
    : { type: 'leaf', sessionId: activeId ?? '' };
  const owningTree: PaneTree = paneTree !== undefined
    ? (paneTree ?? { type: 'leaf', sessionId: activeId ?? '' })
    : derivedPair;
  const showDivider = owningTree.type === 'split';
  /** Which sessions a pane is showing right now. */
  const paneIds = React.useMemo(() => new Set(leaves(owningTree)), [owningTree]);
  // A session exiting mid-drag removes the divider, and a detached node never
  // delivers lostpointercapture to React. Clearing here keeps a remount from
  // inheriting an armed drag.
  React.useEffect(() => {
    if (!showDivider) draggingDivider.current = false;
  }, [showDivider]);
  // Fallbacks cover the first paint (and jsdom, whose clientHeight is 0): the
  // window is the closest honest guess before the row has been measured.
  const layout = layoutPanes(
    owningTree,
    rowSize.width || paneRowPx,
    rowSize.height || (typeof window !== 'undefined' ? window.innerHeight : 0),
  );
  /**
   * Write a ratio into the tree, measured in the split that divider belongs to.
   * The shell owns the tree when it provides one; otherwise this is the pair's
   * single preference, persisted on release.
   */
  const applyRatio = React.useCallback((path: readonly number[], ratio: number): void => {
    if (paneTree !== undefined) onPaneTreeChange?.(setRatioAtPath(owningTree, path, ratio));
    else setSplitRatio(clampSplitRatio(ratio, paneRowPx));
  }, [paneTree, onPaneTreeChange, owningTree, paneRowPx]);
  /** Fitted and narrow: said, never refused. */
  const anyNarrow = layout.panes.some(p => p.narrow);
  const rectFor = new Map(layout.panes.map(p => [p.sessionId, p]));
  const current = sessions.find(s => s.id === activeId);
  /*
   * Asked even with the panel CLOSED, which is what makes moving the counts
   * out of the panel worth anything: shut, these two numbers are the only
   * thing on screen saying the worktree has changes at all.
   *
   * Still gated on `showWorktree`, because that flag is a caller saying it
   * does not want a git poll every four seconds - and the counts are part of
   * the same feature, so they must not be what starts one.
   */
  const { data: git } = useGitStatus(current?.itemId ?? null, Boolean(showWorktree));

  /**
   * A TOGGLE, not open-only.
   *
   * Open-only would need a separate close control on the panel, which is two
   * controls for one piece of state. One button, one fact.
   */
  const toggleWorktree = React.useCallback(() => {
    setPanelOpen(cur => {
      const next = !cur;
      try { localStorage.setItem(WORKTREE_PANEL_KEY, JSON.stringify(next)); } catch { /* a lost preference, not a failure */ }
      return next;
    });
  }, []);

  // AFTER the hooks, never before: an early return above them would change how
  // many run between a render with sessions and one without, which React
  // rejects outright.
  if (sessions.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title="No terminal open"
          body="Click a card in the sidebar to open a terminal on it. It runs in that card's own worktree, so the agent works on its branch and nothing else."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
       * WHICH WORKTREE you are typing into - and HIDDEN once there is more than
       * one pane.
       *
       * It names the ACTIVE card and branch, which is a second, conflicting
       * answer the moment every pane carries its own line (ccbe7ba4): for
       * every pane but the focused one it is simply wrong, and sending a
       * command to the wrong branch is exactly the expensive mistake this bar
       * was added to prevent. It also gives the split panes the row back.
       */}
      {paneIds.size <= 1 && (
      <div data-testid="terminal-header" className="flex shrink-0 items-center gap-2 border-b border-border-soft bg-nav-surface px-3 py-1.5 text-xs">
        <span className="truncate text-ink-secondary">
          {current?.projectName && <span className="text-ink-tertiary">{current.projectName} / </span>}
          {current?.title}
        </span>
        {current?.branchName ? (
          <span
            title={current.branchName}
            data-testid="session-branch"
            className="ml-auto flex min-w-0 shrink items-center gap-1.5 rounded-lg border border-border-soft bg-canvas px-2 py-0.5"
          >
            <GitBranch size={11} className="shrink-0 text-ink-tertiary" />
            <span className="truncate font-mono text-[11px] text-ink">{current.branchName}</span>
          </span>
        ) : (
          // Said, not hidden. A card with no branch yet is a worktree that has
          // not been created, and that is worth knowing BEFORE you type.
          <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-tertiary">no branch yet</span>
        )}

        {/* Its OWN group, separated from the editor button by a divider.
            "Open in VS Code" launches an application; these two change what is
            on screen, and three identical buttons in a row would read as three
            of the same kind of control.

            Buttons with `aria-pressed`, not a tablist. A tablist has to have a
            selected tab, and the state this pair spends most of its time in is
            the one where neither list is showing. */}
        {showWorktree && (
          <div
            role="group"
            aria-label="Worktree"
            className="flex shrink-0 items-center gap-1 border-r border-border-soft pr-2"
          >
            {/* ONE control, not two. Changed and staged are two halves of one
                question about one worktree, so splitting them into two buttons
                made a reader close one half to see the other. The button opens
                the panel; choosing between the halves happens inside it, where
                both counts are in view.

                The counts stay out here because with the panel shut they are
                the only sign the worktree has changes at all - which is the
                whole reason this moved into the bar. */}
            <button
              type="button"
              aria-pressed={panelOpen}
              onClick={toggleWorktree}
              title={panelOpen ? 'Hide the worktree files' : 'Show the worktree files beside the terminal'}
              className={clsx(
                'flex shrink-0 items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors',
                panelOpen
                  ? 'border-brand bg-canvas font-semibold text-ink'
                  : 'border-border-soft text-ink-tertiary hover:border-brand hover:text-ink',
              )}
            >
              <FileDiff size={11} />
              {(git?.changed ?? 0)} / {(git?.staged ?? 0)}
            </button>

            {/* Runs in the same group, because it answers the same kind of
                question - "show me something beside the terminal" - and it is
                the only other thing competing for that space. Docked below it
                costs the terminal 192px whether or not anything is running,
                and until now the only way to reclaim that was to send Runs to
                its own screen, which is not the same as closing it. */}
            {onToggleRuns && (
              <button
                type="button"
                aria-pressed={runsOpen === true}
                onClick={onToggleRuns}
                title={runsOpen ? 'Hide the run feed' : 'Show the run feed below the terminal'}
                className={clsx(
                  'flex shrink-0 items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors',
                  runsOpen
                    ? 'border-brand bg-canvas font-semibold text-ink'
                    : 'border-border-soft text-ink-tertiary hover:border-brand hover:text-ink',
                )}
              >
                <Activity size={11} />
                Runs
              </button>
            )}
          </div>
        )}

        {/* Here because this is where the user already is when they want it:
            looking at what the agent just did and wanting to see the files. */}
        {current && editors?.map(editor => (
          <button
            key={editor.id}
            type="button"
            onClick={() => onOpenInEditor?.(current.itemId, editor.id)}
            className="flex shrink-0 items-center gap-1.5 rounded border border-border-soft px-2 py-0.5 font-mono text-[10px] text-ink-secondary transition-colors hover:border-brand hover:text-ink"
          >
            <EditorIcon editorId={editor.id} />
            Open in {editor.label}
          </button>
        ))}
      </div>
      )}

      <div role="tablist" aria-label="Open terminals" className="flex shrink-0 items-stretch border-b border-border-soft bg-nav-surface">
        {sessions.map((session, index) => {
          const selected = session.id === activeId;
          /*
           * The AGENT and the position, not the card title.
           *
           * Every tab in a set is usually on the same card, so titling them
           * with the card repeats the same string across the whole strip and
           * distinguishes nothing — which is exactly what it did while the
           * restored tabs were also falling back to a raw uuid: three tabs,
           * one indistinguishable id. The card's name is in the header above,
           * where it belongs, said once.
           */
          const tabLabel = `${agentLabel(session.agentId)} ${index + 1}`;
          return (
            <div
              key={session.id}
              data-testid="terminal-tab"
              /*
               * A DROP TARGET FOR REORDER (e488bcdd). The same payload the
               * pane edges take; a drop HERE reorders the strip, a drop on a
               * pane splits. The pane's top droppable zone excludes this strip
               * precisely so the two gestures do not fight.
               */
              onDragOver={e => {
                if (!onReorder || !e.dataTransfer?.types?.includes(SESSION_DRAG_MIME)) return;
                e.preventDefault();
                const box = e.currentTarget.getBoundingClientRect();
                const side = e.clientX - box.left < box.width / 2 ? 'before' : 'after';
                setReorderHint({ overId: session.id, side });
              }}
              onDragLeave={() => setReorderHint(cur => (cur?.overId === session.id ? null : cur))}
              onDrop={e => {
                if (!onReorder) return;
                e.preventDefault();
                setReorderHint(null);
                const dropped = e.dataTransfer?.getData(SESSION_DRAG_MIME);
                if (!dropped || dropped === session.id) return;
                const box = e.currentTarget.getBoundingClientRect();
                const side = e.clientX - box.left < box.width / 2 ? 'before' : 'after';
                onReorder(dropped, session.id, side);
              }}
              className={clsx(
                'group relative flex max-w-[220px] items-center gap-2 border-r border-border-soft px-3 py-2',
                selected ? 'bg-canvas' : 'hover:bg-canvas/50',
              )}
            >
              {reorderHint?.overId === session.id && (
                <span
                  data-testid="tab-reorder-hint"
                  data-side={reorderHint.side}
                  className={clsx(
                    'pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-brand',
                    reorderHint.side === 'before' ? 'left-0' : 'right-0',
                  )}
                />
              )}
              <button
                role="tab"
                /*
                 * DRAGGABLE (7a717cb8). Dropping it on a pane EDGE splits
                 * there - right edge side by side, bottom edge stacked - which
                 * is the gesture the Split button only approximated. The
                 * payload is the session id, the one thing the pane needs.
                 */
                draggable
                onDragStart={e => e.dataTransfer?.setData(SESSION_DRAG_MIME, session.id)}
                aria-selected={selected}
                onClick={() => onSelect(session.id)}
                // The card stays in the tooltip: the strip says which agent,
                // hovering says which card.
                title={session.title}
                /*
                 * The state belongs in the NAME, not only in a coloured dot.
                 * The dot is a span with no role carrying a title, which is a
                 * description at best and is not reliably announced - so an
                 * agent that failed reached nobody using assistive tech. Size
                 * was the answer to "colour alone is not a signal everybody
                 * receives", and size helps nobody here either.
                 */
                aria-label={(() => {
                  const ind = tabIndicator(sessionStates?.get(session.id));
                  return ind.label ? `${tabLabel}, ${ind.label}` : undefined;
                })()}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                {(() => {
                  /*
                   * The state of the pane you are NOT looking at. Without it,
                   * an agent that failed behind another tab is invisible until
                   * you click it - so failures are found by going looking, one
                   * tab at a time.
                   */
                  const ind = tabIndicator(sessionStates?.get(session.id));
                  if (!ind.state) return null;
                  return (
                    <span
                      data-testid="tab-state"
                      data-state={ind.state}
                      title={ind.label ?? undefined}
                      className={clsx('shrink-0 rounded-full', tabDotClass(ind.state),
                        // Urgent states are bigger as well as louder: colour
                        // alone is not a signal everybody receives.
                        ind.urgent ? 'h-2 w-2' : 'h-1.5 w-1.5')}
                    />
                  );
                })()}
                <AgentIcon agentId={session.agentId} size={13} />
                <span className={clsx('truncate text-xs', selected ? 'text-ink' : 'text-ink-secondary')}>
                  {tabLabel}
                </span>
                {session.autoApprove && (
                  // Marked on the tab itself, not only inside the pane: with
                  // several terminals open, which one is running without the
                  // agent's own prompts has to be visible without switching to
                  // it.
                  <span title="Permissions skipped" className="shrink-0 text-[10px] text-red-400">●</span>
                )}
              </button>
              {onToggleSplit && (() => {
                /*
                 * DISABLED WITH ITS REASON, never absent (CGLAB-192). A
                 * control that vanishes teaches nothing and invites the same
                 * attempt tomorrow; a greyed one that says why teaches once.
                 *
                 * Not offered on the pane already on screen: splitting a
                 * session with itself is not a thing, and a disabled control
                 * there would be noise rather than instruction.
                 */
                if (session.id === activeId) return null;
                // A pane is a LEAF OF THE TREE, not "the second id". Reading
                // splitId here said "Split with" on a tab that clicking would
                // actually REMOVE - the control misdescribing its own action.
                const isSplit = paneIds.has(session.id);
                const blocked = !isSplit && (splitDisabledReason ?? splitBlocked);
                return (
                  <button
                    type="button"
                    data-testid="tab-split"
                    disabled={Boolean(blocked)}
                    title={blocked || (isSplit ? 'Close this pane' : `Show beside ${sessions.find(x => x.id === activeId)?.title ?? 'the current terminal'}`)}
                    aria-label={blocked ? `Split unavailable: ${blocked}` : isSplit ? `Unsplit ${session.title}` : `Split with ${session.title}`}
                    onClick={() => onToggleSplit(session.id, 'horizontal')}
                    className={clsx(
                      'shrink-0 rounded p-0.5 transition-opacity',
                      blocked
                        ? 'cursor-not-allowed text-ink-tertiary opacity-40'
                        : isSplit
                          ? 'text-brand opacity-100'
                          : 'text-ink-tertiary opacity-0 hover:text-ink focus:opacity-100 group-hover:opacity-100',
                    )}
                  >
                    <Columns2 size={11} />
                  </button>
                );
              })()}
              <button
                onClick={() => onClose(session.id)}
                aria-label={`Close terminal on ${session.title}`}
                className="shrink-0 rounded p-0.5 text-ink-tertiary opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
        {/*
         * THE REASON, ON SCREEN. The Split control is disabled with its reason
         * only in a tooltip, and a tooltip is not reachable for everybody - the
         * module's own rule is "disabled with its reason, never absent", and a
         * hover-only reason is the absent case wearing a title attribute.
         *
         * Shown only when there IS a second terminal: with one, "open a second
         * terminal" is advice the plus button beside it already gives.
         */}
        {anyNarrow && (
          <span
            data-testid="split-narrow-reason"
            className="ml-auto flex shrink-0 items-center px-2 text-[11px] text-amber-600 dark:text-amber-400"
            title="A pane this narrow wraps every line of a terminal. It is a warning, not a limit."
          >
            Narrow pane
          </span>
        )}
        <button
          onClick={onNew}
          aria-label="New terminal"
          className={clsx(
            'flex shrink-0 items-center px-3 text-ink-tertiary transition-colors hover:text-ink',
            !anyNarrow && 'ml-auto',
          )}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* All of them, always. Hiding is a style; unmounting kills a process. */}
      {/* Panes and the worktree panel share the row, so the panel sits beside
          what it describes rather than under it. min-w-0 on the panes: without
          it a long line of terminal output refuses to shrink and pushes the
          panel off screen. */}
      <div className="flex min-h-0 flex-1">
      <div
        ref={splitRowRef}
        className={clsx('relative min-w-0 flex-1', showDivider && 'bg-border-soft')}
      >
      {sessions.map((session, index) => {
        const rect = rectFor.get(session.id);
        return (
        <div
          key={session.id}
          /*
           * Hidden, never unmounted: unmounting kills the process. Off-screen
           * sessions keep their pane mounted and the flex slot they always
           * had; on-screen ones take their rectangle from the layout.
           */
          hidden={!rect}
          data-testid="terminal-pane"
          /*
           * A DROP ZONE, measured in the pane's own rectangle: 20% of each
           * edge, with the tab strip excluded from the top (that is where a
           * drag is a REORDER). The middle is not a split - it is a move.
           */
          onDragOver={e => {
            // The payload is not readable during a drag (only its TYPES are),
            // so a tab drag is recognised by its type and the zone computed
            // from the pointer.
            if (!e.dataTransfer?.types?.includes(SESSION_DRAG_MIME)) return;
            e.preventDefault();
            const box = e.currentTarget.getBoundingClientRect();
            const zone = dropZone(box.width, box.height, e.clientX - box.left, e.clientY - box.top);
            setDropHint(zone ? { sessionId: session.id, zone } : null);
          }}
          onDragLeave={() => setDropHint(cur => (cur?.sessionId === session.id ? null : cur))}
          onDrop={e => {
            e.preventDefault();
            setDropHint(null);
            const dropped = e.dataTransfer?.getData(SESSION_DRAG_MIME);
            if (!dropped || dropped === session.id) return;
            const box = e.currentTarget.getBoundingClientRect();
            const zone = dropZone(box.width, box.height, e.clientX - box.left, e.clientY - box.top);
            if (!zone) return;
            // The shell's tree when there is one: a drop on the third pane of a
            // nested tree is a split or a move at THAT pane, not a toggle of
            // the pair.
            if (onDropSession) onDropSession(dropped, session.id, zone);
            else onToggleSplit?.(dropped, zone.direction);
          }}
          className={clsx('flex min-h-0 flex-col', rect ? 'absolute overflow-hidden bg-canvas' : 'flex-1')}
          /* Inline style only, never a DOM move: re-parenting a pane would
             unmount it and kill the agent. */
          style={rect ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : undefined}
        >
          {/*
           * THE PANE'S OWN IDENTITY, when there is more than one (ccbe7ba4).
           *
           * The header above shows ONE branch - the active session's - so with
           * a split the other pane's branch was unreadable without clicking its
           * tab, which is exactly when more than one agent is running. The name
           * comes first because it is the same string the tab strip builds
           * (`Claude Code 1`), so a pane and its tab are recognisably the same
           * thing. Composed from what the strip already has: no new data.
           *
           * Only when split: a lone pane is already named in the header, and a
           * second copy beside it is noise.
           */}
          {paneIds.size > 1 && (
            <div
              data-testid="pane-identity"
              className="flex shrink-0 items-center gap-1.5 border-b border-border-soft bg-nav-surface px-2 py-0.5 text-[10px]"
            >
              <AgentIcon agentId={session.agentId} size={10} />
              <span className="truncate text-ink-secondary">{`${agentLabel(session.agentId)} ${index + 1}`}</span>
              <span
                className="truncate font-mono text-ink-tertiary"
                title={session.branchName ?? undefined}
              >
                {session.branchName ?? 'no branch yet'}
              </span>
            </div>
          )}
          {/* min-h-0 so a long line of output cannot push the pane taller. */}
          <div className="min-h-0 flex-1">
          <TerminalPane
            itemId={session.itemId}
            agentId={session.agentId}
            autoApprove={session.autoApprove}
            persist={session.persist}
            agentSessionId={session.agentSessionId}
            resume={session.resume}
            onSpawned={agentSessionId => onSpawned?.(session.id, agentSessionId)}
            onOutput={() => onOutput?.(session.itemId)}
            onExited={code => onExited?.(session.id, code)}
            onActivity={a => onActivity?.(session.id, a)}
            onScreenActivity={a => onScreenActivity?.(session.id, a)}
          />
          </div>
          {/*
           * WHERE IT WILL LAND, while the drag is still in the air.
           *
           * The zone exists either way; showing it is the difference between
           * a gesture you aim and one you guess at. Four halves - left, right,
           * top, bottom - which is the 2x2 the edges describe.
           */}
          {dropHint?.sessionId === session.id && (
            <div
              data-testid="drop-zone-hint"
              data-zone={`${dropHint.zone.direction}-${dropHint.zone.placement}`}
              className="pointer-events-none absolute z-20 rounded-sm border-2 border-brand bg-brand/20"
              style={dropHintStyle(dropHint.zone)}
            />
          )}
        </div>
        );
      })}

      {/* ONE DIVIDER PER SPLIT (7a717cb8, 3b). An ABSOLUTE overlay on the seam
          rather than a flex child, because inserting an element between two
          mapped panes would change their parent and unmount them. Pointer
          events, so mouse and touch share one path; the arrows move it without
          a drag. Each one writes only ITS OWN node's ratio, measured in that
          node's rect, so a nested boundary moves the nested panes. */}
      {layout.dividers.map(d => {
        // The axis follows the SPLIT, not a constant: a stacked split has a
        // horizontal boundary and a row-resize cursor, and the drag reads the
        // pointer on the other coordinate.
        const vertical = d.direction === 'vertical';
        const ratio = paneTree !== undefined ? (ratioAtPath(owningTree, d.path) ?? 0.5) : shownRatio;
        const min = paneTree !== undefined ? 0.02 : ratioBounds.min;
        const max = paneTree !== undefined ? 0.98 : ratioBounds.max;
        // Relative to THIS split's rect, never the window - a nested divider
        // dragged as if it were the root moves the wrong boundary.
        const ratioAtPointer = (clientX: number, clientY: number): number =>
          vertical
            ? (clientY - d.parent.y) / d.parent.height
            : (clientX - d.parent.x) / d.parent.width;
        return (
        <div
          key={d.path.length ? d.path.join('.') : 'root'}
          role="separator"
          aria-orientation={vertical ? 'horizontal' : 'vertical'}
          aria-label="Resize the two terminals"
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={Math.round(min * 100)}
          aria-valuemax={Math.round(max * 100)}
          tabIndex={0}
          data-testid="terminal-split-divider"
          className={clsx(
            'absolute z-10 touch-none bg-transparent transition-colors hover:bg-brand/40 focus-visible:bg-brand/40 focus-visible:outline-none',
            vertical ? 'cursor-row-resize' : 'cursor-col-resize',
          )}
          style={vertical
            ? { left: d.x, top: d.y - 2, width: d.length, height: 4 }
            : { left: d.x - 2, top: d.y, width: 4, height: d.length }}
          onPointerDown={e => {
            // Primary button only: a right-click should open its menu, not arm
            // a drag that the next move would then run with.
            if (e.button !== 0) return;
            draggingDivider.current = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            e.preventDefault();
          }}
          onPointerMove={e => {
            if (!draggingDivider.current) return;
            // `buttons === 0` means no button is down: the drag ended without a
            // pointerup (cancelled, released off-window), and following an
            // unpressed cursor is the stuck-drag bug.
            if (e.buttons === 0) { persistSplit(); return; }
            applyRatio(d.path, ratioAtPointer(e.clientX, e.clientY));
          }}
          onPointerUp={e => {
            e.currentTarget.releasePointerCapture?.(e.pointerId);
            persistSplit();
          }}
          // Covers up, cancel and removal in one: whatever ended the drag, the
          // flag is cleared.
          onLostPointerCapture={persistSplit}
          onKeyDown={e => {
            const step = e.shiftKey ? 0.1 : 0.02;
            const back = vertical ? 'ArrowUp' : 'ArrowLeft';
            const on = vertical ? 'ArrowDown' : 'ArrowRight';
            if (e.key === back) { e.preventDefault(); applyRatio(d.path, ratio - step); }
            if (e.key === on) { e.preventDefault(); applyRatio(d.path, ratio + step); }
          }}
        />
        );
      })}
      </div>

      {/* Asks about the session you are LOOKING at, not all of them: the panel
          answers "what has this agent touched", and that question only has a
          meaning for one worktree at a time.

          Absent rather than hidden when closed, which is the whole point: it
          is a fixed 288px of the row, and hiding it would leave the terminal
          exactly as narrow as before. Nothing is lost by unmounting it - it
          holds a query, not a process, and the query is the shared one the
          bar's counts keep alive anyway. */}
      {showWorktree && panelOpen && (
        <WorktreePanel itemId={current?.itemId ?? null} />
      )}
      </div>
    </div>
  );
}
