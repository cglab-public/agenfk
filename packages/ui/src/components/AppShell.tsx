/**
 * The desktop shell around the board (CGLAB-168).
 *
 * Kanban stays the centre of the app — this adds the cockpit around it:
 * a sidebar of projects and agent sessions, tabs so a session can be watched
 * without losing the board, and a status bar for the things only the desktop
 * knows (which server it is talking to, whether the socket is live).
 *
 * Two rules shape the implementation:
 *
 * 1. The board is rendered once and never unmounted. Tab switching hides it
 *    with `hidden`, not by swapping it out, so its React state survives —
 *    filters, expanded cards, a half-typed title. A Kanban that reloaded every
 *    time you glanced at a session would cost more than the tabs are worth.
 *    Scroll position is the exception and does not survive: `display: none`
 *    destroys the layout box, and with it scrollTop.
 * 2. `titleBarStyle: 'hiddenInset'` removes the OS title bar, so the window can
 *    only be moved by an explicit drag region. Anything clickable inside that
 *    region has to opt back out, or it silently stops receiving clicks.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { agentLabel } from '../agentLabels';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Book, Check, ChevronDown, ChevronRight, Folder, FolderOpen, GitBranch, LayoutGrid, ListFilter, PanelLeftClose, PanelLeftOpen, Pin, PinOff, Plus, Settings, SquareTerminal, type LucideIcon } from 'lucide-react';
import { useSocketEvent, useSocket } from '../SocketContext';
import { AgenfkWordmark } from './AgenfkWordmark';
import { desktopInfo, useFullScreen } from '../desktop';
import { FleetSheet } from './FleetSheet';
import { workingByItem, sessionForItem, adoptions } from '../workingSessions';
import { SHELL_AGENT_ID } from '../agentIds';
import { mayFanOutLocal } from '../fleetPlan';
import { useActiveProject } from '../ActiveProject';
import {
  sortProjectsByPin,
  readExpanded, toggleExpanded, writeExpanded,
  readProjectSort, writeProjectSort, readAgentFilter, writeAgentFilter, orderProjects, type ProjectSort,
} from '../sidebarPrefs';
import { api } from '../api';
import { herdrAttachSession, shouldFocusOnAttach, herdrSessionRows, herdrProjectRows, type OwnedPane, type ProjectPaneRow } from '../herdrTreeRows';
import { HerdrMark } from './HerdrMark';
import { API_URL } from '../apiUrl';
import type { AgEnFKItem, Project } from '../types';
import { TerminalTab, type TerminalSession } from './TerminalTab';
import { treeForDrop, treeForToggle, pruneTree, treeForFocus } from '../paneLayout';
import { moveInOrder } from '../tabOrder';
import type { PaneTree, DropZone, SplitDirection } from '../splitTree';
import { withItemBranches } from '../sessionBranch';
import { NewTerminalDialog } from './NewTerminalDialog';
import {
  listAgentsFromBridge, readPrefsFromBridge,
  listEditorsFromBridge, openInEditorFromBridge,
} from './agentBridge';
import { SettingsPanel } from './SettingsPanel';
/*
 * Types only. The rail component itself is no longer rendered anywhere - the
 * SESSIONS section it lived in was removed (1a1b8df6) - and importing it kept
 * a dead component alive to every reader and to the bundler. Its TYPES are
 * still the shared vocabulary for a session row, which is why the module
 * stays imported at all.
 */
import { runState, nextStateChangeAt } from '../sessionRow';

/**
 * A timestamp as ISO, or undefined when there isn't one.
 *
 * The distinction matters downstream: `stallWarning` reads a missing
 * `lastSeenAt` as "no evidence of silence" and says nothing, which is the
 * honest answer for a card nobody has ever heard from. Defaulting to `now`
 * here would manufacture evidence; defaulting to the start time is the bug
 * this replaced.
 */
const isoOrUndefined = (ms: number | undefined): string | undefined =>
  ms === undefined ? undefined : new Date(ms).toISOString();
import type { SessionRow, SessionState } from '../sessionRow';
import { LiveAgents } from '../liveAgents';
import { ReadmeModal } from './ReadmeModal';
import { FlowEditorModal } from './FlowEditorModal';
import { WhatsNewModal } from './WhatsNewModal';
import { liveSessions } from '../liveSessions';
import { CardPicker } from './CardPicker';
import { ProjectPage } from './ProjectPage';
import { AskAgenfk } from './AskAgenfk';
import { CardStateDot } from './CardStateDot';
import { CardProcessRow } from './CardProcessRow';
import { ORDER, SessionStateIndicator } from './sessionPresentation';
import { AgentIcon } from './AgentIcon';
import {
  availableAgentFilters, collectFilterableRows, projectMatchesAgentFilter, cardMatchesAgentFilter, projectChildCount,
  settleIds,
  pruneAgentFilter, matchesAgentFilter, type AgentFilterOption,
} from '../agentFilter';
import { cardState, itemsNeedingAPerson, NEEDS_A_PERSON } from '../cardState';
import { AttentionAlerts } from './AttentionAlerts';
import { VerifyRunsChip } from './VerifyRunsChip';
import { clampSidebarWidth, sidebarIsResizable, SIDEBAR_MIN_PX, SIDEBAR_MAX_PX, SIDEBAR_COLLAPSED_PX } from '../sidebarWidth';

/**
 * A view the main column can show.
 *
 * Called an id rather than a TAB id because there is no tab bar any more. The
 * Kanban button went first, Terminal followed it, and with Runs docked below
 * the board there was nothing left to put in a strip - so the strip went too.
 * Every view here is reached from the sidebar or from a session, and each one
 * is a panel that stays mounted and is hidden rather than unmounted.
 */
type ViewId = 'kanban' | 'terminal' | 'settings' | 'project';

/**
 * The WORK group at the top of the sidebar (CGLAB-164).
 *
 * Navigation belongs beside the thing being navigated, not in a strip floating
 * over the content — so picking a view moved here. `Tasks` is the board, which
 * is the view that is always there. The `Agents` row that used to live here
 * went with the screen it opened (396c8350): what shows what is running is the
 * agent rows under the cards.
 *
 * Not every row here is a view. `Flows` opens the flow editor over whatever you
 * are looking at and leaves you there, which is why the rows carry a `kind`:
 * only a view can be the current page, and giving an action `aria-current`
 * would tell a screen reader you had navigated somewhere you have not. The
 * alternative — a separate list rendered after this one — would have fixed the
 * order of the group to "views first", and Flows belongs in the second slot.
 *
 * This is now the ONLY list of top-level destinations. It used to sit beside a
 * `TABS` constant that named the same views again for the tab strip, so there
 * were two routes to the board and two lists to keep in step; the strip is
 * gone and this list is what is left.
 */
type WorkRow =
  | { kind: 'view'; id: ViewId; label: string; Icon: LucideIcon }
  | { kind: 'action'; id: 'flows' | 'terminal'; label: string; Icon: LucideIcon };

const WORK_ROWS: WorkRow[] = [
  // One direct entry to the user's shell, available before choosing a project.
  { kind: 'action', id: 'terminal', label: 'Open terminal', Icon: SquareTerminal },
  { kind: 'view', id: 'kanban', label: 'Tasks', Icon: LayoutGrid },
  // GitBranch, the same icon the board's Manage Flow button uses: one concept,
  // two routes to it, and a second glyph would read as a second feature.
  { kind: 'action', id: 'flows', label: 'Flows', Icon: GitBranch },
  /*
   * DELETED: the Agents row (396c8350). It opened the run feed as a dedicated
   * screen, which was never defined and never used; the agent rows under the
   * cards are what actually shows what is running. The runs themselves stay -
   * AgentRun is still written and still read by the card detail modal.
   */
];

type Connection = 'connecting' | 'connected' | 'offline';

const SIDEBAR_KEY = 'agenfk_shell_sidebar';
/** Separate from SIDEBAR_KEY: collapsing must not forget the width you chose. */
const SIDEBAR_WIDTH_KEY = 'agenfk_shell_sidebar_width';

/**
 * The hover hint for a control that has lost its label to the rail.
 *
 * CSS-only, because the anchor is already there: every one of these rows is a
 * `group`, so a hint needs no state, no ref, no portal and no measurement. A
 * component holding state could not be used inside the nav's `.map()` anyway -
 * hooks in a loop.
 *
 * THIS REPLACES `title` ON THESE CONTROLS rather than sitting beside it. Native
 * tooltips arrive after about a second and are drawn by the OS; on a 56px
 * column of four similar glyphs, a hint that appears once the pointer has moved
 * on is not a hint. Keeping both would also show both.
 *
 * `group-focus-within` as well as hover: the rail is fully keyboard navigable,
 * and a pointer-only hint leaves a keyboard user with four unlabelled glyphs.
 *
 * No `aria-describedby` onto this text, deliberately: the hint says what the
 * button's accessible name already says, so describing it by the same string
 * makes a screen reader announce the control twice.
 */
const RAIL_TIP_BASE =
  'pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap '
  + 'rounded border border-border-soft bg-canvas px-2 py-1 text-[11px] font-normal text-ink shadow-sm '
  + 'opacity-0 transition-opacity';

/** For a row that IS the hover target: the `li` or the block around one control. */
const RAIL_TIP = `${RAIL_TIP_BASE} group-hover:opacity-100 group-focus-within:opacity-100`;

/**
 * For a control that must show its OWN hint and nobody else's.
 *
 * `peer` binds it to the element immediately before it, which is what the
 * toggle needs: it shares its row with the FK mark, so `group` there would fire
 * the hint while the pointer was over the mark instead.
 *
 * A wrapper <span> around the button would say the same thing, and was the
 * first attempt - it broke a test that reads the toggle's PARENT to get the
 * row's traffic-light padding, which is a real assumption about this markup
 * rather than a coincidence.
 */
const RAIL_TIP_PEER = `${RAIL_TIP_BASE} peer-hover:opacity-100 peer-focus-visible:opacity-100`;

/**
 * When this run of the app began.
 *
 * Read once at module load, which is both the earliest honest answer and the
 * only place it can be read — `Date.now()` during render is impure. The rail
 * uses it to tell a run still working in silence from one orphaned by a
 * previous launch: both read `running` forever, and only the start time
 * separates them. See liveSessions.ts.
 */
const APP_STARTED_AT = Date.now();


/*
 * WHAT THE TAB STRIP TOOK WITH IT.
 *
 * Kanban left the bar for the sidebar's Tasks and Terminal followed it. A bar
 * with nothing in it orders nothing, so everything built to order it is gone:
 * the `agenfk_shell_tabs` order and the reader that repaired it across
 * versions, `moveTab` and its module, the drag reorder, the move-left button,
 * and the live region that announced a tab's new position.
 *
 * The Agents row and the Runs dock went the same way (396c8350): the feed had
 * a screen, a docked strip and a stored position (`agenfk_runs_dock`), all of
 * which promised a defined view that never existed. Only the data - AgentRun,
 * read by the card detail modal - survives.
 *
 * Written down because a deleted mechanism leaves nothing behind to notice. If
 * two top-level views ever have to be on screen at once, this is the list to
 * rebuild from.
 */

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  offline: 'Offline',
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const [active, setActive] = React.useState<ViewId>('kanban');
  // A latch, not a mirror of `active`. Opening a terminal launches an agent
  // CLI, so it must not happen before the user asks — but once it has, the
  // session outlives every view switch.
  const [terminalOpened, setTerminalOpened] = React.useState(false);
  // Same latch idea as the terminal, for a much smaller reason: no request goes
  // out for a screen the user has never opened.
  const [settingsOpened, setSettingsOpened] = React.useState(false);
  const { activeProjectId, focusedItemId, setActiveProjectId, markProjectWorked, focusItem, terminalRequest } = useActiveProject();
  /**
   * The installation's settings, for the tmux default the dialog starts from.
   *
   * Same query key the settings screen uses, so turning it on there is
   * reflected here without a reload: one cache entry, one source of truth.
   */
  const { data: appSettings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  /*
   * Work in flight, for the "which card?" picker.
   *
   * The SAME query key the sidebar uses, so this is one cache entry and one
   * request rather than a second source of the same list — two lists of the
   * same thing is how the rail and the terminal came to disagree earlier in
   * this epic.
   */
  const { data: activeWork = [] } = useQuery<AgEnFKItem[]>({
    queryKey: ['active-items'],
    queryFn: api.listActiveItems,
  });
  /*
   * Project id to name, for the picker's rows.
   *
   * Same key the sidebar's own projects query uses, so it is the same cache
   * entry and the same request. The list of cards is cross-project — the route
   * takes no project filter — and the sidebar only gets away with bare titles
   * because it groups by project.
   */
  const { data: allProjects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const projectNames = React.useMemo(
    () => new Map((allProjects as Project[]).map(p => [p.id, p.name])),
    [allProjects],
  );
  // Same query key the settings screen uses, so a change there is reflected
  // here without a reload. Auto-approve is desktop-owned, not on the server.
  const { data: desktopPrefs } = useQuery({ queryKey: ['desktop-prefs'], queryFn: readPrefsFromBridge });
  // Which editors this machine has. A fact about the machine, so it is asked
  // once rather than on every focus.
  const { data: editors = [] } = useQuery({
    queryKey: ['editors'],
    queryFn: listEditorsFromBridge,
    staleTime: 60_000,
  });
  /**
   * Whether the "which card?" picker is up.
   *
   * A step BEFORE `pending` rather than a field inside it: the agent dialog's
   * identity is "open a terminal on THIS card", and three other callers reach
   * it having already decided which card they mean.
   */
  const [pickingCard, setPickingCard] = React.useState(false);
  /** The project the Ask AgEnFK panel is open for, or null when it is shut. */
  const [asking, setAsking] = React.useState<string | null>(null);
  /** The project whose page is open, or null when no page has been opened. */
  const [pageProjectId, setPageProjectId] = React.useState<string | null>(null);

  /** The card a terminal is being opened FOR, while the dialog is up. */
  /**
   * Cards waiting for their agent to be picked - A QUEUE, not one.
   *
   * It was a single slot, and that turned the fleet sheet's headline promise
   * into a lie. "Launch 3" ran a loop calling requestTerminal three times in
   * one handler; each call did setPending({...}) on the same slot, so the last
   * write won and exactly ONE dialog appeared, for the last child in the list.
   * The other two were dropped with no row, no message and no error, while the
   * person watched the sheet close believing a three-way fan-out had started.
   *
   * The count was never the problem - the sheet counts honestly. The dispatch
   * end could only ever deliver one, which is the same interface lie relocated
   * one layer down, and no test saw it because none of them render the shell
   * and press the button.
   *
   * The head is the dialog on screen; answering or dismissing it shifts to the
   * next. One question at a time, and every card gets asked.
   */
  const [pendingQueue, setPendingQueue] = React.useState<
    { itemId?: string; projectId?: string; title: string; agentId?: string; branchName?: string | null }[]
  >([]);
  const pending = pendingQueue[0] ?? null;
  /**
   * Ask about one more card. Appends; never replaces.
   *
   * `allowSecond` exists because the two ways in mean different things. A card
   * CLICK means "take me to my work", so asking twice about the same card is a
   * duplicate question. The tab bar's + means "give me another terminal on this
   * card", which is a supported thing to want - agent names are numbered
   * precisely so two on one card are distinguishable. Deduplicating both would
   * quietly delete that feature, so the caller says which it is.
   */
  const enqueuePending = React.useCallback(
    (
      entry: { itemId?: string; projectId?: string; title: string; agentId?: string; branchName?: string | null },
      allowSecond = false,
    ): void => {
      setPendingQueue(prev => (
        // Deduplicated on the TARGET, which is a card or a project. Two
        // requests for a terminal on the same project are the same request.
        !allowSecond && prev.some(p => (
          entry.itemId ? p.itemId === entry.itemId : p.projectId === entry.projectId
        )) ? prev : [...prev, entry]
      ));
    },
    [],
  );
  /** Done with the head, whether it was answered or dismissed. */
  const shiftPending = React.useCallback((): void => setPendingQueue(prev => prev.slice(1)), []);
  /**
   * The card a terminal is currently open ON, with the choices made for it.
   *
   * Separate from `pending` on purpose: the agent and the auto-approve flag are
   * decided once, at open time, and must not change under a running session.
   */
  // A LIST, not one. Holding a single session meant opening a terminal on a
  // second card replaced the first — which unmounted its pane, killed its agent
  // mid-run and destroyed its scrollback, in two clicks through the supported
  // path. That is the same catastrophe the panel-level `hidden` exists to
  // prevent one level up.
  const [sessions, setSessions] = React.useState<TerminalSession[]>([]);
  const [activeSession, setActiveSession] = React.useState<string | null>(null);
  /**
   * The agent conversation each session was handed at spawn, by session id.
   *
   * KEPT OFF THE SESSION ON PURPOSE. `agentSessionId` is a prop of
   * `TerminalPane`, so writing it back into session state goes undefined ->
   * uuid, tears the pane down and spawns a SECOND agent (see `rememberSession`).
   *
   * But the matching rules — `workingByItem`, `sessionForItem` and
   * `adoptions`, all in workingSessions.ts — identify a run's owner by exactly
   * that conversation id. Dropping it made every freshly opened terminal
   * unmatchable: a run on a card read `elsewhere` ("Running"), and a terminal
   * opened on a project could never adopt the card its agent wrote.
   *
   * So it is remembered HERE, keyed by session, and this map is the only thing
   * the matchers see. The restored path keeps its id on the session itself and
   * needs no entry.
   */
  const [conversationsBySession, setConversationsBySession] =
    React.useState<Record<string, string>>({});
  /** Sessions with any conversation id the shell holds, so the matchers see it. */
  const sessionsWithConversation = React.useMemo(
    () => sessions.map(s => (
      s.agentSessionId || !conversationsBySession[s.id]
        ? s
        : { ...s, agentSessionId: conversationsBySession[s.id] }
    )),
    [sessions, conversationsBySession],
  );
  /**
   * The pane layout, as a TREE, owned here (7a717cb8, 3b).
   *
   * It replaced a `splitId`/`splitDirection` pair, and the reason is the
   * ceiling that pair imposed: one id cannot describe three panes, and one
   * direction cannot describe a boundary that points a different way three
   * panes down. The shell owns it because which panes belong together is the
   * person's decision and the shell is the only thing that knows what else is
   * open - never derived from fan-out.
   *
   * Null means "no explicit arrangement": the pane showing the active session
   * is the whole layout. TerminalTab draws that single leaf itself, so nothing
   * here has to seed it on open.
   */
  const [paneTree, setPaneTree] = React.useState<PaneTree | null>(null);

  /*
   * The card whose fan-out is being planned, or null (CGLAB-207).
   *
   * Opened by a gesture, never by dispatching: the sheet exists so a person
   * sees the collisions BEFORE spending, and popping it up on its own would
   * turn a deliberate review into an interruption.
   */
  const [fleetParentId, setFleetParentId] = React.useState<string | null>(null);
  /*
   * Every item, for the sheet. Cached and socket-refreshed, never refetched on
   * focus: GET /items returns full records, and re-pulling them on every window
   * focus costs megabytes to read one field.
   */
  const { data: allItemsForFleet = [] } = useQuery<AgEnFKItem[]>({
    queryKey: ['items-all'],
    queryFn: () => api.listItems(),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const fleetParent = React.useMemo(
    () => allItemsForFleet.find(i => i.id === fleetParentId) ?? null,
    [allItemsForFleet, fleetParentId],
  );

  /*
   * THE BRANCH COMES FROM THE ITEM, kept in step (BUG: it was lost on reopen).
   *
   * A session's `branchName` was only ever set on the path that OPENS it, so a
   * restored session had none and the terminal header fell back to "no branch
   * yet" - on a card whose branch the sidebar, reading the same item, showed
   * correctly. Two answers about one fact, which is the defect this epic keeps
   * finding. Deriving it from the item means the restore fills it in as soon as
   * the items load, and a branch created or renamed later stays accurate
   * instead of freezing the value the tab happened to open with.
   */
  React.useEffect(() => {
    setSessions(prev => withItemBranches(prev, allItemsForFleet));
  }, [allItemsForFleet]);
  /**
   * Cards that already have a terminal, for the fleet sheet's count.
   *
   * IN THE COMPONENT BODY, not in the JSX. `<FleetSheet>` renders inside
   * `{fleetParent ? ... : null}`, so a hook written inline there sits behind
   * that condition - and React counts hooks by order. It took 54 tests red at
   * once the last time, which was the good outcome; the same mistake in a
   * rarely-rendered branch ships.
   */
  const itemsWithATerminal = React.useMemo(
    // Card-less sessions are not cards with a terminal; they are terminals
    // waiting for the card their agent is about to write.
    () => new Set(sessions.map(s => s.itemId).filter(Boolean) as string[]),
    [sessions],
  );

  const sessionSeq = React.useRef(0);

  /**
   * A terminal on the PROJECT, with no card.
   *
   * The way work starts without a form: the agent opens in the project's
   * checkout and writes the card itself with the CLI, which is what the
   * workflow rules already tell it to do. No worktree is cut — there is no
   * card to cut one from, and cutting one would mean creating the card this
   * terminal exists to let the agent propose.
   */
  /**
   * Open a terminal for a queued request, with the agent already decided.
   *
   * Extracted so the dialog and the no-dialog path share ONE implementation. A
   * second copy would be the place the two drift, and the drift would show as a
   * terminal that opens differently depending on which way you asked for it.
   */
  const openPendingTerminal = React.useCallback((
    entry: { itemId?: string; projectId?: string; title: string; agentId?: string; branchName?: string | null },
    agentId: string,
  ): void => {
    // Both read from Settings rather than asked in the dialog. They are
    // preferences, answered the same way every time, and a dialog in the path of
    // a frequent action should only ask what actually varies — which agent.
    const autoApprove = desktopPrefs?.autoApprove === true;
    const persist = appSettings?.tmuxByDefault === true;
    // Open FIRST. Recording which agent a card uses is a nicety; letting it fail
    // must never stop the terminal from opening. Ordering is the guarantee here,
    // not a try/catch.
    sessionSeq.current += 1;
    /*
     * EXACTLY ONE of card and project, so the pane knows which directory to
     * open. A project terminal has no card yet; sending both would fail main's
     * exclusivity check, and sending neither would leave it with no directory at
     * all.
     */
    const id = `${entry.itemId ?? entry.projectId ?? 'project'}#${sessionSeq.current}`;
    setSessions(prev => [...prev, {
      id,
      ...(entry.itemId ? { itemId: entry.itemId } : { projectId: entry.projectId }),
      title: entry.title,
      agentId,
      autoApprove,
      persist,
      openedAt: new Date().toISOString(),
      branchName: entry.branchName,
    }]);
    setActiveSession(id);
    setTerminalOpened(true);
    setActive('terminal');
    // Remember the choice ON THE CARD, where it belongs: the server keeps it in
    // the item's own record, so it follows the card across machines and clients
    // instead of living in one browser's storage. Only a card can carry it — a
    // project terminal has no item to write it onto.
    if (entry.itemId && agentId !== entry.agentId) {
      void api.updateItem(entry.itemId, { agentId }).catch(() => {});
    }
  }, [desktopPrefs, appSettings, setActive, setActiveSession, setSessions, setTerminalOpened]);

  const requestProjectTerminal = React.useCallback((projectId: string, title: string): void => {
    setActiveProjectId(projectId);
    markProjectWorked(projectId);
    /*
     * ONE GESTURE, when the user asked for one.
     *
     * `askBeforeOpening` off means the dialog has nothing left to ask that a
     * preference does not already answer — and for a PROJECT terminal that is
     * literally true: no card, no existing session, nothing but the agent.
     *
     * A CARD terminal keeps its dialog, which says more than which agent runs:
     * whether the work is already going, and whether the button means Continue
     * or Create. Skipping THAT screen would be removing information rather than
     * a question.
     */
    if (desktopPrefs?.askBeforeOpening === false) {
      openPendingTerminal({ projectId, title }, desktopPrefs.defaultAgentId || 'claude-code');
      return;
    }
    enqueuePending({ projectId, title });
  }, [setActiveProjectId, markProjectWorked, enqueuePending, openPendingTerminal, desktopPrefs]);

  const requestTerminal = React.useCallback((item: AgEnFKItem): void => {
    setActiveProjectId(item.projectId);
    // An ACTION, not navigation: this launches an agent CLI in that project's
    // worktree, which is the strongest "I am working here" signal the app has.
    // Removing the old stamp-on-every-glance left nothing writing the rank at
    // all, so the sidebar's ordering quietly degraded to updatedAt.
    markProjectWorked(item.projectId);
    // Already open? Go to it. Opening a second terminal on the same card is
    // possible (the + in the tab bar), but it is not what clicking the card
    // means — that is "take me to my work", and spawning a duplicate agent in
    // the same worktree would be the opposite of helpful.
    const existing = sessions.find(s => s.itemId === item.id);
    if (existing) {
      setActiveSession(existing.id);
      setTerminalOpened(true);
      setActive('terminal');
      return;
    }
    // agentId comes off the ITEM, which is where it lives — the server keeps it
    // in the item's own record, so it follows the card rather than the machine.
    enqueuePending({
      itemId: item.id,
      title: item.title,
      agentId: item.agentId,
      branchName: (item as { branchName?: string | null }).branchName ?? null,
    });
  }, [setActiveProjectId, sessions, enqueuePending]);

  /**
   * Steer herdr to the pane that was clicked.
   *
   * Fired alongside the attach, not instead of it: the terminal is the thing
   * being opened, and this decides WHAT IS ON IT. Clicking a row means "take
   * me to that agent", the same thing clicking a card means everywhere else
   * here.
   *
   * It is the one call in this feature that reaches outside our own window.
   * herdr's clients are not separate views - MEASURED: a second client gets
   * the first's byte stream exactly - so focusing moves the pane, the tab and
   * the workspace on the operator's real screen too. Skipped when herdr is
   * already showing it, and failure is swallowed: the terminal opening is the
   * promise, and landing on the right pane is the courtesy.
   */
  const steerHerdr = React.useCallback((row: ProjectPaneRow): void => {
    if (!shouldFocusOnAttach(row)) return;
    void fetch(`${API_URL}/herdr/panes/${encodeURIComponent(row.paneId)}/focus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ socket: row.socketPath }),
    }).catch(() => {});
  }, []);

  /**
   * Open a herdr session in the terminal this app already has.
   *
   * No dialog, because there is nothing to choose: the session exists, started
   * by somebody else, and the only question a dialog could ask - which agent -
   * was answered before this app was open.
   *
   * DEDUPED BY SOCKET, not by pane. Attaching shows the whole herdr workspace,
   * so two rows from the same session are the same terminal; opening one per
   * row would stack identical clients on one daemon and reflow its layout once
   * per click.
   */
  const attachHerdr = React.useCallback((row: ProjectPaneRow | null): void => {
    if (!row) { setHerdrAttachedFrom(null); return; }
    const session = herdrAttachSession(row, new Date().toISOString());
    steerHerdr(row);
    setHerdrAttachedFrom(row.paneId);
    setTerminalOpened(true);
    setActive('terminal');
    // Already attached? Go to it. A second client on the same daemon buys
    // nothing and costs the operator's own window a resize.
    if (sessions.some(s => s.id === session.id)) { setActiveSession(session.id); return; }
    setSessions(prev => [...prev, session]);
    setActiveSession(session.id);
  }, [sessions, steerHerdr]);



  /**
   * The board asked for a terminal on a card.
   *
   * Through a ref, and the NONCE is the only dependency. `requestTerminal`
   * closes over `sessions`, so depending on it directly would re-run this every
   * time any session starts or stops — reopening the agent dialog for a card
   * the user already dealt with, with no click behind it.
   */
  const handledTerminalRequest = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!terminalRequest) return;
    // The guard, not the dependency array, is what makes this fire once.
    // `requestTerminal` closes over `sessions`, so it is a new function every
    // time any session starts or stops — leaving it in the deps without this
    // would reopen the agent dialog for a card the user already dealt with,
    // with no click behind it.
    if (handledTerminalRequest.current === terminalRequest.nonce) return;
    handledTerminalRequest.current = terminalRequest.nonce;
    requestTerminal(terminalRequest.item);
  }, [terminalRequest, requestTerminal]);

  /**
   * What the Sessions rail shows.
   *
   * Liveness comes from the RECENCY of run events, never from AgentRun.status:
   * the hook never issues the closing PATCH (BUG df4b3343), so status stays
   * 'running' forever and a rail trusting it would list every run this machine
   * has ever started.
   */
  const shellQueryClient = useQueryClient();
  const live = React.useRef(new LiveAgents()).current;
  const [liveTick, setLiveTick] = React.useState(0);
  /** Bumped when a silent run crosses the contact grace. See the effect below. */
  const [graceTick, setGraceTick] = React.useState(0);
  React.useEffect(() => {
    const off = live.subscribe(() => setLiveTick(t => t + 1));
    return () => { off(); live.dispose(); };
  }, [live]);

  const { data: runs = [] } = useQuery({
    queryKey: ['runs'],
    /*
     * No status filter, and that is the fix.
     *
     * Filtering to `running` meant a FAILED run could not reach the client at
     * all — so the rail's failed state was unreachable no matter what the
     * component did with it. The runs come back newest-first and bounded, so
     * asking for all of them is asking for the recent ones.
     */
    queryFn: () => api.listRuns({}),
  });
  useSocketEvent('run:event', (payload: { itemId?: string }) => {
    if (payload?.itemId) live.touch(payload.itemId);
  });
  useSocketEvent('run:updated', () => shellQueryClient.invalidateQueries({ queryKey: ['runs'] }));

  /**
   * Two sources, deliberately merged.
   *
   * `GET /agent-runs` lists AgentRun records, which are written by the Claude
   * Code hook — opening a terminal here creates a PTY and no run at all, so a
   * rail fed only by runs stayed empty for the sessions the user had just
   * started. That is what "Sessions" means to someone looking at it: the
   * terminals they have open, plus whatever else is running.
   *
   * Keyed by card, so a card with both a terminal and a recorded run appears
   * once — the terminal wins, because that is the one you can be taken to.
   */
  /**
   * Two sources, merged by card.
   *
   * `GET /agent-runs` lists AgentRun records, which the Claude Code hook
   * writes. Opening a terminal here creates a PTY and NO run at all — so a rail
   * fed only by runs stayed empty for the session the user had just started,
   * in a panel called Sessions. Both belong.
   *
   * Keyed by card so one card appears once: listing it twice would read as two
   * agents working where there is one. An open terminal wins over a recorded
   * run, because that is the one the user can actually be taken to.
   */
  /**
   * Which cards an agent has touched recently.
   *
   * RECENCY of events, never AgentRun.status — the hook never issues the
   * closing PATCH (BUG df4b3343), so status stays 'running' and endedAt stays
   * null forever. A dot driven by that would go green on a card's first run and
   * never go out, which is the same no-information dot in a different colour.
   *
   * Recency is also the truer claim: "an agent touched this 90 seconds ago" is
   * what someone wants to know, and a wedged agent stops glowing on its own
   * without anyone having to close a run.
   *
   * `liveTick` is the dependency that matters. Going dark is driven by a clock
   * rather than by an event, so without it the dot would stay lit until the
   * next unrelated render.
   */
  const liveItems: ReadonlySet<string> = React.useMemo(
    () => {
      // Read, so `liveTick` is a genuine dependency rather than one the linter
      // is told to ignore — the same trick `sessionRows` below already uses.
      // The disable comment this replaces sat on the callback, while the rule
      // reports on the dependency array, so it suppressed nothing at all.
      void liveTick;
      return new Set(live.liveIds());
    },
    [live, liveTick],
  );

  /**
   * The panes herdr is holding, so work this product did not start still shows
   * up where work lives: in the tree, under the project or card it belongs to.
   *
   * One query for the whole shell rather than one per row, and a plain interval
   * rather than a socket: herdr pushes events, but subscribing from the browser
   * would mean a second transport for a list that is cheap to re-read.
   */
  const { data: herdrBody } = useQuery<{ sessions: { reachable: boolean; panes: OwnedPane[] }[] }>({
    queryKey: ['herdr-tree'],
    queryFn: async () => {
      const r = await fetch(`${API_URL}/herdr/sessions`);
      if (!r.ok) throw new Error(`herdr: ${r.status}`);
      const body = await r.json();
      if (!body || !Array.isArray(body.sessions)) throw new Error('herdr: unexpected shape');
      return body;
    },
    // A machine with no herdr answers 200 with an empty list, so a failure here
    // is a real one and must not retry forever behind the user's back.
    retry: 1,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  const herdrPanes: OwnedPane[] = React.useMemo(
    () => (herdrBody?.sessions ?? []).filter(x => x.reachable).flatMap(x => x.panes ?? []),
    [herdrBody],
  );

  /** Panes that belong to a project but to no card. Most of them, today. */
  /** The herdr pane the tree has open, if any. */
  /**
   * Which herdr row opened the terminal we are attached through.
   *
   * Kept only so the tree can show WHERE you are. There is no second surface
   * any more: clicking a herdr row opens a terminal, and the terminal runs
   * herdr.
   */
  const [herdrAttachedFrom, setHerdrAttachedFrom] = React.useState<string | null>(null);

  const herdrProject = React.useMemo(() => {
    const socketOf = new Map<string, string>();
    for (const sess of herdrBody?.sessions ?? []) {
      for (const p of sess.panes ?? []) socketOf.set(p.pane_id, (sess as { socketPath?: string }).socketPath ?? '');
    }
    return herdrProjectRows(herdrPanes, id => socketOf.get(id) ?? '');
  }, [herdrPanes, herdrBody]);

  const sessionRows: SessionRow[] = React.useMemo(() => {
    // liveTick is a dependency on purpose: going dark is driven by a clock, not
    // by new data, so without it the dots would only ever turn off when
    // something else happened to re-render.
    void liveTick;
    /*
     * Keyed by card AND agent, not by card alone.
     *
     * Keying by the card made every row a claim about whichever session
     * happened to be written last: two terminals on one card collapsed into
     * one row that carried the second's identity while clicking it activated
     * the first and STOP killed the second. A hook-recorded run and a terminal
     * with different agents on one card became a single row naming only the
     * terminal's, so a second agent running in the same worktree was invisible
     * in the one component whose job is to list every agent you have running.
     */
    const byAgent = new Map<string, SessionRow>();
    const key = (itemId: string, agentId: string) => `${itemId}\u0000${agentId}`;

    for (const run of runs as Array<Record<string, string>>) {
      byAgent.set(key(run.itemId, run.harness ?? 'claude-code'), {
        runId: run.id,
        itemId: run.itemId,
        projectId: run.projectId,
        title: run.itemId.slice(0, 8),
        // No mapping: a run's `harness` IS an agent id. They used to be two
        // vocabularies — 'claude-code' against 'claude' — which is what
        // produced "Unknown agent" the first time one reached a spawn.
        agentId: run.harness ?? 'claude-code',
        agentLabel: run.harness ? agentLabel(run.harness) : 'agent',
        // The worker's own conversation id. Matched against our sessions to
        // tell "a subagent inside a terminal we have" from "an agent we
        // cannot reach".
        agentSessionId: run.sessionId,
        // A run that ENDED badly stays failed however long ago it was: a
        // failure that ages into 'idle' is a failure nobody sees. Recency only
        // decides between running and idle.
        /*
         * Three answers, not two (CGLAB-195). The rule and the grace window
         * live in runState, so the rail, the tabs and this all say the same
         * thing about the same run.
         */
        state: runState(run, live.isLive(run.itemId)),
        startedAt: run.startedAt,
        // When we last HEARD from it, which is a different fact from when it
        // started. The stall warning needs this one; given startedAt it
        // reported session age as silence.
        lastSeenAt: isoOrUndefined(live.lastSeenAt(run.itemId)),
        // A run from the hook has a transcript but no terminal this app owns,
        // so clicking must not pretend to attach to one.
        hasTerminal: false,
        // Carried raw, for liveSessions to decide with. `state` above has
        // already collapsed it into running/idle and cannot answer "did this
        // end?" — which is the question the rail's membership turns on.
        runStatus: run.status,
      });
    }

    for (const open of sessionsWithConversation) {
      /*
       * A session with no card belongs to a project, and the rail is a list of
       * WORK — a row keyed by a card that does not exist yet would be a row
       * with nothing to open. It appears once the card does (c8e29c9e).
       */
      if (!open.itemId) continue;
      byAgent.set(key(open.itemId, open.agentId), {
        runId: open.id,
        itemId: open.itemId,
        agentSessionId: open.agentSessionId,
        projectId: open.projectId,
        title: open.title,
        agentId: open.agentId,
        // The name, not the id: the rail sat beside a picker showing
        // "Claude Code" while itself showing "claude-code".
        agentLabel: agentLabel(open.agentId),
        /*
         * A process that has ended is not running, whatever the liveness
         * window says. `live` is fed by terminal OUTPUT, and the exit message
         * is output — so without this the row stayed green for the full TTL
         * after the session died, which is what was reported.
         */
        /*
         * What the AGENT says, when it says anything (BUG 192).
         *
         * Claude Code and Codex publish a spinner in the terminal title while
         * they work, so for them this is the agent's own word rather than our
         * inference. `live.isLive` stays as the fallback for pi and gemini,
         * which publish nothing — it is wrong in the familiar direction, a
         * repainting footer reading as work, but it is what existed before and
         * replacing it needs the screen-text path, not a guess.
         *
         * A dead process still wins over both: that is a fact, not a claim.
         */
        /*
         * Four sources, in order of how much they actually know.
         *
         * A dead process is a FACT and beats everything. Then the agent's own
         * word, published in the terminal title — claude-code and codex. Then
         * what we read off its rendered screen — pi and gemini, which publish
         * no title. Only when none of those has an opinion does it fall back to
         * output recency, which is the signal a repainting footer keeps
         * permanently true and which this whole line of work exists to retire.
         */
        state: open.exited
          /*
           * A process that ended BADLY is a failure, and failures outlive
           * everything — see liveSessions. While the exit code was discarded
           * this branch could only ever say 'idle', so a crashed agent left no
           * trace in the rail at all: the row simply vanished once dead rows
           * started being filtered, and the only evidence was the terminal tab
           * reading "Session exited (1)".
           */
          ? (open.exitCode ? 'failed' : 'idle')
          : open.activity === 'blocked'
            ? 'blocked'
            : open.activity === 'working'
              ? 'running'
              : open.activity === 'idle'
                ? 'idle'
              : open.screenActivity === 'blocked'
                ? 'blocked'
                : open.screenActivity === 'working'
                  ? 'running'
                  : open.screenActivity === 'idle'
                    ? 'idle'
                    : live.isLive(open.itemId) ? 'running' : 'idle',
        // The run's start time when this terminal IS that run, never a fresh
        // stamp: this memo recomputes whenever any card lights up, and stamping
        // here reset every terminal's elapsed time to "0s" on an unrelated
        // card's event. `openedAt` is the terminal's own truth.
        startedAt: byAgent.get(key(open.itemId, open.agentId))?.startedAt ?? open.openedAt,
        lastSeenAt: isoOrUndefined(live.lastSeenAt(open.itemId)),
        hasTerminal: true,
        // Carried so the rail can drop it once the process is gone. The row
        // stays while the terminal is merely idle — the tab is still there.
        exited: open.exited === true,
      });
    }

    /*
     * Only what is still alive.
     *
     * The rail listed everything it had ever heard of — exited terminals and
     * AgentRuns from previous launches, the rows that read as a bare
     * `323cd4ad`. A list of things that finished hours ago buries the two or
     * three that are actually yours.
     *
     * A failed run is the exception and survives this, however old: it is the
     * row that needs a person.
     */
    /*
     * `liveItems` rather than a closure over `live`: the set is already
     * computed above, on the same inputs, and handing the filter a callback
     * that reaches into the ref would let it read whenever it happened to run.
     *
     * Sound only because `LiveAgents.touch` was fixed to test LIVENESS rather
     * than mere presence. While it tested presence, a card that expired
     * unswept and was touched again emitted nothing, so this set stayed staler
     * than `live.isLive()` — and the same pass could call a row `running` from
     * the fresh read and then drop it on the stale one.
     */
    const ours = liveSessions([...byAgent.values()], {
      isLive: id => liveItems.has(id),
      appStartedAt: APP_STARTED_AT,
    });
    /*
     * herdr panes that belong to a card join the same list, AFTER ours - a pane
     * we started is described better by our own record than by a mirror of the
     * terminal it happens to be in. `liveSessions` is not applied to them: it
     * decides liveness from OUR clocks, and herdr already answered the question
     * for its own panes.
     */
    const theirs = herdrSessionRows(herdrPanes)
      .filter(r => !ours.some(o => o.itemId === r.itemId && o.agentId === r.agentId));
    return [...ours, ...theirs];
  }, [runs, sessionsWithConversation, live, liveItems, liveTick, graceTick, herdrPanes]);

  /*
   * THE CLOCK THAT MAKES `unverifiable` REACHABLE (CGLAB-195).
   *
   * The memo above reads the wall clock through `runState`, and every other
   * dependency is event-driven: `liveTick` comes from the live-agent sweep,
   * which STOPS ITSELF once the last card goes dark, and ['runs'] is
   * invalidated by a socket event a silent agent by definition does not send.
   * So a run that went quiet was drawn `Idle` and stayed `Idle` for ever - the
   * exact sentence this card exists to stop the app saying, arrived at through
   * the render rather than through the rule.
   *
   * One timeout at the moment the answer actually changes, not a poll: waking
   * an idle board on a fixed interval would trade this bug for the one the
   * sweep's self-shutdown was avoiding. When no row can change on its own,
   * nothing is scheduled at all.
   */
  React.useEffect(() => {
    const at = nextStateChangeAt(runs as any[], (id: string) => liveItems.has(id));
    if (at === null) return;
    // +1s so the timer lands strictly PAST the boundary rather than on it,
    // which is where `runState` still answers idle.
    const timer = setTimeout(() => setGraceTick(t => t + 1), Math.max(0, at - Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [runs, liveItems, graceTick]);
  /*
   * How each OPEN TERMINAL is doing, keyed by session id (CGLAB-191).
   *
   * In the component body, not in the JSX: a hook called inside a render
   * expression sits behind whatever conditions wrap that branch, and React
   * counts hooks by order. Written inline first, it took 54 tests red at once
   * - which is the good outcome, since the same mistake in a rarely-rendered
   * branch would have shipped.
   *
   * Built from the SAME rows the rail renders, so the strip and the rail
   * cannot disagree about whether an agent is well.
   */
  const sessionStates = React.useMemo(() => {
    const m = new Map<string, SessionState>();
    /*
     * Matched on itemId AND agentId, which is the pair sessionRows is keyed by.
     *
     * Matching on itemId alone was worse than showing nothing: a card can run
     * a lead and a sub-agent, both rows carry that itemId, and both resolved to
     * the FIRST session. So a failed sub-agent painted its red dot on the
     * lead's tab while its own tab stayed silent - a signal pointing at the
     * wrong agent, which is the one outcome worse than no signal. Found by
     * adversarial review; my own docblock in tabState.ts said this is counted
     * by session precisely because one agent failing says nothing about the
     * other, and the wiring did the opposite.
     */
    const taken = new Set<string>();
    for (const row of sessionRows) {
      const owned = sessions.find(s =>
        !taken.has(s.id) && s.itemId === row.itemId && s.agentId === row.agentId);
      if (owned) { taken.add(owned.id); m.set(owned.id, row.state); }
    }
    return m;
  }, [sessionRows, sessions]);

  const openSession = React.useCallback((row: SessionRow): void => {
    // Always the terminal. The rail lists AGENTS, and clicking an agent means
    // "take me to it" — an earlier version sent rows with no PTY to the
    // read-only Runs view, which is technically defensible and wrong in use:
    // you clicked a running agent and landed on a log.
    // Matched on the AGENT too: with two terminals on one card, matching by
    // card alone activated whichever was first regardless of which row was
    // clicked.
    const own = sessions.find(s => s.itemId === row.itemId && s.agentId === row.agentId);
    if (own) {
      setActiveSession(own.id);
      setTerminalOpened(true);
      setActive('terminal');
      return;
    }
    /*
     * THE SESSION THAT HOSTS IT, before offering to make another.
     *
     * A subagent reports its own run against the card it is working on, while
     * the terminal it lives in belongs to the PARENT. Matching by card alone
     * found nothing and the row offered a new terminal — for work already on
     * screen, one tab away.
     */
    const host = sessionForItem(row.itemId, sessionRows, sessions);
    if (host) {
      setActiveSession(host);
      setTerminalOpened(true);
      setActive('terminal');
      return;
    }
    // Nothing of ours is showing this work — a run recorded by the hook, or
    // one from a previous launch. Offer to open one ON THAT CARD rather than
    // silently doing nothing; the dialog names the card so it is clear this
    // starts a session rather than resuming the one that is running.
    enqueuePending({ itemId: row.itemId, title: row.title, agentId: row.agentId });
  }, [sessions, sessionRows, enqueuePending]);

  /**
   * Take the board to a card.
   *
   * The rail's row opens a terminal — asked for explicitly — which left
   * `focusItem` without a production caller and made the board's
   * scroll-to-and-highlight unreachable. This gives it one back without taking
   * the row's click away from the terminal.
   */
  /*
   * What the project page shows. Derived here rather than fetched: the
   * projects, the work in flight and the running sessions are all already in
   * this component, and a second source for any of them would be a second
   * truth to reconcile.
   */
  const pageProject = React.useMemo(
    () => (allProjects as Project[]).find(p => p.id === pageProjectId) ?? null,
    [allProjects, pageProjectId],
  );
  /*
   * THE PROJECT'S CARDS — all of them, which is what the tab is called.
   *
   * This was derived from `activeWork` to avoid a second request, and that
   * quietly changed the question: `listActiveItems` is the "which card?"
   * picker's list, and the server excludes TODO and DONE from it by design.
   * So a project whose cards were all still in TODO — including every project
   * whose cards had JUST been created — showed an empty page while the board
   * beside it showed them.
   *
   * Fetched per project, and only for the page that is open. "In flight" is
   * still worth counting; it is a statistic about this list, not the list.
   */
  const { data: pageCards = [] } = useQuery<AgEnFKItem[]>({
    queryKey: ['project-items', pageProjectId],
    queryFn: () => api.listItems({ projectId: pageProjectId as string }),
    enabled: Boolean(pageProjectId),
  });
  /*
   * What is already working on each card, and which session shows it.
   *
   * Both from ONE rule, in workingSessions.ts, because computing them apart is
   * exactly how the label and the press came to disagree: the label matched a
   * run's conversation against our sessions, the press looked for a session
   * whose `itemId` was the card, and a subagent's session belongs to the
   * PARENT card — so "Open" on a child tried to spawn.
   */
  const working = React.useMemo(
    () => workingByItem(sessionRows, sessionsWithConversation),
    [sessionRows, sessionsWithConversation],
  );
  /*
   * A terminal opened on a PROJECT takes the card its agent wrote.
   *
   * Until it does, that work is invisible: no row in the tree, no run to read
   * and no card to attribute its tokens to — which is exactly what a person
   * sees after opening a card-less terminal and watching it create cards.
   *
   * Matched on the CONVERSATION rather than on timing: the hook stamps each
   * run with the session it belongs to, and that id is the one this terminal
   * was given at spawn. "The first card created after this opened" would be
   * wrong the moment two agents work in one project.
   */
  React.useEffect(() => {
    const taken = adoptions(sessionsWithConversation, sessionRows);
    if (!taken.length) return;
    setSessions(prev => prev.map(s => {
      const mine = taken.find(t => t.sessionId === s.id);
      return mine ? { ...s, itemId: mine.itemId, title: mine.title ?? s.title } : s;
    }));
  }, [sessionsWithConversation, sessionRows]);

  const openSessionFor = React.useCallback(
    (itemId: string) => sessionForItem(itemId, sessionRows, sessionsWithConversation),
    [sessionRows, sessionsWithConversation],
  );
  const { data: pageFlow } = useQuery({
    queryKey: ['project-flow', pageProjectId],
    queryFn: () => api.getProjectFlow(pageProjectId as string),
    enabled: Boolean(pageProjectId),
    staleTime: 30_000,
  });
  const pageAgents = React.useMemo(
    () => sessionRows.filter(r => r.state === 'running'
      && pageCards.some(card => card.id === r.itemId)).length,
    [sessionRows, pageCards],
  );

  const revealOnBoard = React.useCallback((row: { itemId: string; projectId?: string }): void => {
    focusItem(row.itemId, row.projectId);
    setActive('kanban');
  }, [focusItem]);

  /*
   * `stopSession` used to live here and is GONE, not merely uncalled.
   *
   * Card 63bd3b13 removed the STOP control because it closed the terminal
   * rather than stopping the agent - killing the pane and its scrollback under
   * a label promising to interrupt. The commit deleted the two `onStop` props
   * and edited this function's comment, leaving the handler compiled with no
   * caller. Its own card says that state "must not stay", and the reason is
   * specific: the next person wiring a stop control onto a process row finds a
   * ready-made handler with exactly the right name and ships the bug back.
   *
   * Removing it means the next attempt has to write the behaviour, and writing
   * it is where somebody notices what it actually does.
   */

  /**
   * Remember a terminal, once the agent has told us which conversation it got.
   *
   * Written here and not in the pane: the shell owns what is remembered, and a
   * component that both runs a terminal and writes records is two jobs in one
   * place. Fire and forget — remembering is a nicety, and failing at it must
   * never disturb a terminal the user is already using.
   */
  const rememberSession = React.useCallback(
    (sessionId: string, agentSessionId: string | undefined): void => {
      // Read from a ref, never from inside a state updater. An updater must be
      // pure: React invokes it twice in development, which would have written
      // the record twice and left a duplicate terminal to put back.
      const session = sessionsRef.current.find(s => s.id === sessionId);
      // Nothing to do for a tab that was PUT BACK: it already has a row, and
      // recording it again would double the remembered terminals on every
      // launch until the tenth one opens a wall of them.
      if (!session || session.resume || session.recordId) return;
      /*
       * Kept for the MATCHERS, before any early return that is about
       * persistence. A terminal on a project is deliberately not remembered
       * across launches (`if (!session.itemId)` below), but its conversation
       * id is exactly what lets a run on a card it hosts read as ours and lets
       * the session adopt that card.
       */
      if (agentSessionId) {
        setConversationsBySession(prev => (
          prev[sessionId] ? prev : { ...prev, [sessionId]: agentSessionId }
        ));
      }
      /*
       * Only a card's session is remembered across launches. A session on a
       * project is a conversation about a card that does not exist yet —
       * restoring it would reopen an agent with nothing to resume and no work
       * to point at.
       */
      if (!session.itemId) return;
      void api.recordTerminalSession({
        itemId: session.itemId,
        projectId: session.projectId,
        agentId: session.agentId,
        // Absent for an agent that cannot be told its own id (codex). The tab
        // is still worth putting back; the conversation is not recoverable,
        // and the record must not claim an id it never had.
        agentSessionId,
        /*
         * The session's IDENTITY, and the reason restore could never find a
         * surviving tmux session (BUG 63fcf702).
         *
         * `persist` decides whether the terminal lives inside tmux at all, and
         * `autoApprove` is baked into its tmux NAME. Recording neither meant
         * every restored tab came back outside tmux, orphaning the session
         * that was still running and starting a second agent beside it in the
         * same worktree — and since the replacement did not persist either,
         * nothing survived the next close.
         */
        persist: session.persist,
        autoApprove: session.autoApprove,
      })
        .then(row => {
          // The tab may already be gone: the user can close it while the POST
          // is in flight. Forgetting it here is the only chance — nothing else
          // ever learns the row exists, and it would come back on every launch
          // with an agent spawned into that worktree.
          if (!sessionsRef.current.some(s => s.id === sessionId)) {
            void api.forgetTerminalSession(row.id).catch(() => {});
            return;
          }
          /*
           * Only the ROW id goes back into session state.
           *
           * Writing `agentSessionId` here too killed every fresh terminal it
           * touched: it is a prop of TerminalPane and sits in that pane's
           * effect dependencies, so going undefined -> uuid tore the terminal
           * down and spawned a second agent — which minted a DIFFERENT
           * conversation id, because a fresh spawn does not carry one. The row
           * then remembered a conversation that had been killed before it
           * existed, and restoring pi opened that empty session.
           *
           * Claude was spared only by accident: `--continue` ignores the
           * recorded id and finds the surviving conversation by directory.
           *
           * `onSpawned` is excluded from those deps for exactly this hazard,
           * with a comment saying so. This was the same channel coming back
           * down as an input, and did not get the same treatment.
           */
          setSessions(cur => cur.map(s => (s.id === sessionId ? { ...s, recordId: row.id } : s)));
        })
        .catch(() => { /* the terminal is open and working; this is bookkeeping */ });
    },
    [],
  );

  // Mirrors `sessions` for callbacks that must not read stale state and must
  // not run inside a state updater.
  const sessionsRef = React.useRef(sessions);
  sessionsRef.current = sessions;

  const closeSession = React.useCallback((id: string): void => {
    // Read from the ref and act BEFORE the updater, for the same reason as
    // rememberSession: an updater must be pure, and React invokes it twice in
    // development.
    //
    // Closing a tab is the user saying they are done with it. Putting it back
    // on the next launch would be the app arguing with them.
    const closing = sessionsRef.current.find(s => s.id === id);
    if (closing?.recordId) void api.forgetTerminalSession(closing.recordId).catch(() => {});
    // The conversation id is only needed while the tab exists; dropping it
    // keeps the map from growing for the life of the window.
    setConversationsBySession(prev => {
      if (!prev[id]) return prev;
      const { [id]: _closed, ...rest } = prev;
      return rest;
    });
    /*
     * Removes the session. Which tab becomes active is NOT decided here.
     *
     * `setActiveSession` used to be called from INSIDE this updater, which is
     * impure — React invokes updaters twice in development and may replay the
     * queue. My first fix moved that choice out but read the list from the
     * ref, and review caught what that cost: the ref is assigned during render,
     * so two closes in one batch both saw the SAME pre-batch list. The second
     * one computed its "last remaining" from a list that still contained the
     * session the first had just removed, and left `activeSession` pointing at
     * a tab that no longer exists — tabs on screen with nothing under them,
     * the exact outcome this is supposed to prevent. The original impure
     * version did not have that bug, because both halves read one `prev`.
     *
     * So the choice moves to an effect over the COMMITTED list, below. One
     * source, read after the dust settles, however many closes landed together.
     */
    setSessions(prev => prev.filter(s => s.id !== id));
  }, []);
  /**
   * Keep the selected tab pointing at a tab that exists.
   *
   * Reconciliation rather than a decision made at close time, and that is what
   * makes it correct under batching: it reads the list React actually
   * committed, so N closes in one tick produce one answer computed from the
   * result of all of them.
   *
   * Falls to the LAST remaining tab — not an adjacent one, despite what
   * "neighbour" would suggest. Either is defensible; what is not is leaving
   * the panel blank with tabs still showing, which reads as a crash.
   */
  React.useEffect(() => {
    if (activeSession === null) return;
    if (sessions.some(s => s.id === activeSession)) return;
    setActiveSession(sessions.at(-1)?.id ?? null);
  }, [sessions, activeSession]);

  /**
   * A closed tab leaves the tree (7a717cb8).
   *
   * The arrangement is the person's, so it is not thrown away when one pane
   * goes: its leaf collapses into the sibling and every other boundary stays
   * where it was. Null only when the LAST pane went.
   */
  React.useEffect(() => {
    setPaneTree(prev => pruneTree(prev, id => sessions.some(s => s.id === id)));
  }, [sessions]);

  /**
   * A tab dropped on a pane edge: split there, or MOVE it there if it is
   * already a pane. Moving is what keeps a nested arrangement reachable -
   * without it the only way to a new shape is closing panes and starting over.
   */
  const applyDrop = React.useCallback((draggedId: string, targetId: string, zone: DropZone): void => {
    setPaneTree(prev => treeForDrop(prev, activeSession, draggedId, targetId, zone));
  }, [activeSession]);

  /** The tab strip's Split control: add beside the focused pane, or take it out. */
  const toggleSplit = React.useCallback((sessionId: string, direction: SplitDirection): void => {
    setPaneTree(prev => treeForToggle(prev, activeSession, sessionId, direction));
  }, [activeSession]);

  /**
   * Reorder the strip (e488bcdd). The ARRAY order is the strip order, so the
   * move is the whole feature - and the panes address sessions by id, not by
   * position, so a reorder never disturbs a split.
   */
  const reorderSessions = React.useCallback((draggedId: string, overId: string, side: 'before' | 'after'): void => {
    setSessions(prev => moveInOrder(prev, draggedId, overId, side));
  }, []);

  /**
   * Focusing a tab that is NOT on screen shows it in the focused pane.
   *
   * In an EFFECT rather than in each caller, so a tab opened by the restore
   * path or the new-terminal dialog lands in a pane too - not only a click on
   * the strip.
   */
  const prevActiveRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const prev = prevActiveRef.current;
    prevActiveRef.current = activeSession;
    setPaneTree(tree => treeForFocus(tree, prev, activeSession));
  }, [activeSession]);


  /**
   * Terminals from last time, put back with their conversations.
   *
   * The server has already dropped any whose card is gone or trashed, so
   * everything here is something that can actually be opened.
   */
  const { data: rememberedSessions } = useQuery({
    queryKey: ['terminal-sessions'],
    queryFn: () => api.listTerminalSessions(),
    // Only where terminals can actually run. The board is served to a browser
    // too, and without this it restored every remembered tab as a panel saying
    // terminals are desktop-only — and closing them to tidy up DELETED the
    // rows the desktop app was relying on.
    enabled: Boolean(desktopInfo()),
    // A restore, not a live view. Refetching would re-run the effect below
    // against rows we have already put back.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // Exactly once per launch. The guard is a ref rather than state because a
  // second run would open a SECOND agent in the same worktree, both editing
  // the same files — the failure this whole component is arranged to avoid.
  const restored = React.useRef(false);
  React.useEffect(() => {
    if (restored.current || !rememberedSessions?.length) return;
    restored.current = true;
    /*
     * Which agents resume by DIRECTORY rather than by id.
     *
     * claude does (`--continue`), and a directory holds one most recent
     * conversation — not two. Two claude tabs on one card would both resume
     * it, attaching two processes to a single transcript: the first tab would
     * not be resumed at all, it would be showing the second's history.
     *
     * So at most one tab per card+agent resumes; the rest come back as fresh
     * conversations, which is honest. Agents that resume by an explicit id
     * (pi's `--session-id`) are unaffected — two of those resume two different
     * conversations and neither has to give way.
     */
    const RESUMES_BY_DIRECTORY = new Set(['claude-code']);
    const directoryResumeTaken = new Set<string>();

    const putBack = rememberedSessions.map(row => {
      sessionSeq.current += 1;
      return {
        id: `${row.itemId}#restored-${sessionSeq.current}`,
        itemId: row.itemId,
        projectId: row.projectId,
        // The card's title, which the server sends because it has the item
        // loaded anyway. Falling back to the id put a uuid where a card name
        // belongs — on the tab, and in the header above it.
        title: row.itemTitle ?? row.itemId,
        agentId: row.agentId,
        /*
         * From the RECORD, not hardcoded. These two were `false` here, which
         * is what kept every restore outside tmux however the session was
         * created. Older rows have no such fields and default to false, which
         * is the conservative answer for a session whose identity was never
         * written down — not a guess dressed up as data.
         */
        autoApprove: row.autoApprove === true,
        persist: row.persist === true,
        agentSessionId: row.agentSessionId,
        openedAt: row.openedAt,
        // Only where there is a conversation to resume. For codex there is
        // not, and asking anyway would either fail the launch or resume
        // somebody else's session.
        resume: (() => {
          if (!row.agentSessionId) return false;
          if (!RESUMES_BY_DIRECTORY.has(row.agentId)) return true;
          const key = `${row.itemId}\u0000${row.agentId}`;
          if (directoryResumeTaken.has(key)) return false;
          directoryResumeTaken.add(key);
          return true;
        })(),
        recordId: row.id,
      };
    });
    setSessions(prev => [...prev, ...putBack]);
    setActiveSession(cur => cur ?? putBack[0]?.id ?? null);
    // Mounted, but NOT switched to. Reopening the app should put the terminals
    // back where the user left them, not yank them off the board into a
    // terminal they did not ask to look at right now.
    setTerminalOpened(true);
  }, [rememberedSessions]);

  const socket = useSocket();
  // Seeded from the socket rather than assumed: mounting onto an already-
  // connected socket would otherwise sit on "Connecting…" until a reconnect
  // that may never come. Done in the initializer, not an effect, so there is
  // no first paint with a value we already know is wrong.
  const [connection, setConnection] = React.useState<Connection>(
    () => (socket?.connected ? 'connected' : 'connecting'),
  );
  const [sidebarOpen, setSidebarOpen] = React.useState(() => {
    // Guarded: `getItem` itself throws where storage is blocked, and an
    // exception here happens during render — a white screen, not a lost
    // preference.
    try { return localStorage.getItem(SIDEBAR_KEY) !== 'collapsed'; } catch { return true; }
  });
  /**
   * How wide the open sidebar is, in pixels.
   *
   * Stored next to the open/collapsed flag rather than inside it: they are two
   * preferences and collapsing must not forget the width you chose.
   *
   * Read through `clampSidebarWidth` on the way IN as well as on the way out,
   * because a width dragged on a big monitor and reopened on a 960px window is
   * the same question as a drag - and a stored value that skipped the clamp is
   * how a preference becomes a layout bug that survives restarts.
   */
  const [sidebarWidth, setSidebarWidth] = React.useState(() => {
    try {
      return clampSidebarWidth(Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)), window.innerWidth);
    } catch {
      // `getItem` throws outright where storage is blocked, and an exception
      // here happens during render: a white screen, not a lost preference.
      return SIDEBAR_MIN_PX;
    }
  });
  /** True only while the pointer is down on the handle. See the effect below. */
  const [draggingSidebar, setDraggingSidebar] = React.useState(false);
  const [windowWidth, setWindowWidth] = React.useState(() => {
    try { return window.innerWidth; } catch { return 1440; }
  });
  const [readmeOpen, setReadmeOpen] = React.useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = React.useState(false);
  const [flowsOpen, setFlowsOpen] = React.useState(false);

  /*
   * Close the flow editor when the project changes, rather than letting it
   * follow along.
   *
   * Two defects, one cause. The editor binds a flow to whatever `projectId` it
   * is holding at the moment you press the button, but it reads the project's
   * CURRENT flow only once, when it mounts — so a project change under an open
   * editor would leave A's selection on screen and write it to B. And because
   * the render below is guarded on `activeProjectId`, a project going away
   * (the board clears a stale id when its project has been deleted) would hide
   * the editor while leaving `flowsOpen` true, so it reappeared unbidden the
   * next time a project was picked.
   *
   * Adjusted during render rather than in an effect, which is React's own
   * answer for state that has to reset when a value changes: an effect would
   * commit the stale pairing first and only then take it back.
   */
  const [flowsProject, setFlowsProject] = React.useState(activeProjectId);
  if (flowsProject !== activeProjectId) {
    setFlowsProject(activeProjectId);
    setFlowsOpen(false);
  }

  /*
   * Which flow the open project is on, so the editor opens on it rather than on
   * nothing selected.
   *
   * Same query key as the board's, so the two share one cache entry and the
   * sidebar route costs no extra request once the board has loaded. Fetched
   * only while the editor is open: the shell has no other use for it, and the
   * board is the one that needs it eagerly.
   */
  const { data: shellFlow, isPending: flowPending } = useQuery({
    queryKey: ['flow', activeProjectId],
    queryFn: () => api.getProjectFlow(activeProjectId!),
    // Also while the FAN-OUT SHEET is up: its count needs the flow's exit step
    // so a finished card on a custom flow is not counted as launchable
    // (fae59deb).
    enabled: (flowsOpen || fleetParentId != null) && !!activeProjectId,
    staleTime: 30_000,
  });

  /**
   * The flow's own exit step, for the fan-out count (fae59deb).
   *
   * An item's status IS its flow step's name, so a card finished on a flow
   * whose last step is called something else is not in fleetPlan's literal
   * DONE/ARCHIVED list - and "Launch 4" counted a card that was already done.
   * The LAST step by order, which is the exit whatever it is named. Absent when
   * the flow was not read, which keeps the old behaviour rather than guessing.
   */
  const fleetTerminalStatuses = React.useMemo(() => {
    const steps = [...((shellFlow as any)?.steps ?? [])].sort((a: any, b: any) => a.order - b.order);
    const last = steps[steps.length - 1] as any;
    return last?.name ? new Set<string>([last.name]) : undefined;
  }, [shellFlow]);

  const info = desktopInfo();
  const isMac = info?.platform === 'darwin';
  /*
   * The shell draws a title bar only on macOS, and only for a WINDOW: in full
   * screen there are no traffic lights to clear and no window to drag, so the
   * bar would be dead space over the terminal (e7ad8020).
   */
  const fullScreen = useFullScreen();
  const drawsTitleBar = isMac && !fullScreen;
  const { data: versionData } = useQuery({ queryKey: ['version'], queryFn: api.getVersion });
  const version = versionData?.version;

  // Navigating from the sidebar has to land somewhere the user can see. The
  // board sits in a tabpanel with `hidden`, and the card-detail modal is
  // rendered inside the board tree — so with another tab selected a sidebar
  // click opens a draft nobody can see, scrolls a board nobody is looking at,
  // and expires the highlight off-screen.
  //
  // Both values start null and are nonced, so this fires on a real navigation
  // and never on mount: whatever view the user is on stays selected until they
  // actually ask for a card.
  React.useEffect(() => {
    // Only focusing a card reaches the board now: the new-item request went
    // with the form it used to open (82345ab9).
    if (!focusedItemId) return;
    setActive('kanban');
  }, [focusedItemId]);

  // One place, so the latch cannot be missed by a new route into the view -
  // the sessions rail, the sidebar's card list and the board all reach it.
  React.useEffect(() => {
    if (active === 'terminal') setTerminalOpened(true);
  }, [active]);

  // The sidebar normally clears the window buttons on its own; collapsed, it
  // is narrower than they are, so the main column has to make room instead.
  const reservesWindowControls = drawsTitleBar && !sidebarOpen;

  /*
   * With the terminal up, its tab strip IS the title bar: it is the top row of
   * the column, so it takes the drag region and the traffic-light reserve, and
   * the empty row above it goes. The user's words: if the bar has to be
   * there, the terminals should be in it.
   *
   * Only while there are tabs. With no session the panel is an empty state
   * with no strip, and the window still needs something to be dragged by.
   */
  const tabsAreTitleBar = active === 'terminal' && terminalOpened && sessions.length > 0;

  /**
   * Keep the width legal when the WINDOW changes, not only when the handle does.
   *
   * Without this, a sidebar dragged wide on a large window survives the window
   * being made narrow and squeezes the terminal under its floor - the failure
   * the ceiling exists to prevent, arriving from the other direction.
   */
  React.useEffect(() => {
    const onResize = (): void => {
      setWindowWidth(window.innerWidth);
      setSidebarWidth(prev => clampSidebarWidth(prev, window.innerWidth));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /**
   * The drag itself, on the WINDOW rather than on the handle.
   *
   * Listening on the handle loses the pointer the moment it moves faster than
   * React re-renders, which on a drag is immediately - the sidebar sticks and
   * the user lets go somewhere they did not mean. The window keeps receiving
   * moves however far the cursor has run ahead.
   */
  React.useEffect(() => {
    if (!draggingSidebar) return;
    const onMove = (e: PointerEvent): void => {
      // The pointer's x IS the width: the sidebar starts at the left edge, so
      // there is no offset to track and nothing to drift.
      setSidebarWidth(clampSidebarWidth(e.clientX, window.innerWidth));
    };
    const onUp = (): void => {
      setDraggingSidebar(false);
      setSidebarWidth(prev => {
        try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(prev)); } catch { /* non-fatal */ }
        return prev;
      });
    };
    window.addEventListener('pointermove', onMove);
    // `pointerup` alone leaks a drag that ends outside the window - the button
    // is released where we never hear it and the sidebar follows the cursor for
    // ever after.
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [draggingSidebar]);

  /** Arrow keys on the focused handle. A drag-only feature is a mouse-only feature. */
  const nudgeSidebar = React.useCallback((deltaPx: number) => {
    setSidebarWidth(prev => {
      const next = clampSidebarWidth(prev + deltaPx, window.innerWidth);
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next)); } catch { /* non-fatal */ }
      return next;
    });
  }, []);

  const toggleSidebar = React.useCallback(() => {
    setSidebarOpen(prev => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_KEY, next ? 'open' : 'collapsed'); } catch { /* non-fatal */ }
      return next;
    });
  }, []);

  useSocketEvent('connect', () => setConnection('connected'));
  useSocketEvent('disconnect', () => setConnection('offline'));
  useSocketEvent('connect_error', () => setConnection('offline'));

  return (
    <div className="flex h-screen flex-col bg-canvas text-ink">
      {/* Renders nothing. It watches `sessionRows` for a row arriving at a
          state in NEEDS_A_PERSON and makes the sound or raises the banner the
          settings screen's Notifications block switches on. Mounted HERE
          because this is the only place both halves of that list exist: a run
          recorded by the Claude Code hook has no terminal of ours, and a
          terminal just opened has no run, so anything watching one of them
          would be silent for exactly half the cases. */}
      <AttentionAlerts sessionRows={sessionRows} />
      {/* No full-width title bar. The sidebar runs the whole height and owns
          the traffic-light strip, so the window reads as two columns rather
          than a banner stacked on a split — and the board gets that row back. */}
      <div className="flex min-h-0 flex-1">
        <Sidebar
          widthPx={sidebarWidth}
          resizable={sidebarIsResizable(windowWidth)}
          dragging={draggingSidebar}
          onResizeStart={() => setDraggingSidebar(true)}
          onNudge={nudgeSidebar}
          open={sidebarOpen}
          onToggle={toggleSidebar}
          drawsTitleBar={drawsTitleBar}
          requestTerminal={requestTerminal}
          onOpenProjectTerminal={requestProjectTerminal}
          sessionRows={sessionRows}
          herdrProject={herdrProject}
          openPane={herdrAttachedFrom}
          onOpenPane={attachHerdr}
          liveItems={liveItems}
          openSession={openSession}
          openSettings={() => { setSettingsOpened(true); setActive('settings'); }}
          revealOnBoard={revealOnBoard}
          activeView={active}
          onSelectView={setActive}
          onOpenProject={projectId => { setPageProjectId(projectId); setActive('project'); }}
          onOpenFlows={() => setFlowsOpen(true)}
          onOpenTerminal={() => {
            // Opened here, not through a dialog: the shell needs no agent and
            // no target, so there is nothing to ask about.
            sessionSeq.current += 1;
            const id = `${SHELL_AGENT_ID}#${sessionSeq.current}`;
            setSessions(prev => [...prev, {
              id, title: 'Shell', agentId: SHELL_AGENT_ID,
              autoApprove: false, persist: false, openedAt: new Date().toISOString(),
            }]);
            setActiveSession(id);
            setTerminalOpened(true);
            setActive('terminal');
          }}
        onOpenFleet={setFleetParentId}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {/*
            THE TITLE-BAR ROW, and all that is left of it.

            This row WAS the view tab strip. The tabs are gone and the row is
            empty, and it still has to be here: on macOS `titleBarStyle:
            'hiddenInset'` removes the native bar, so without an explicit drag
            region the top edge of the main column cannot move the window at
            all. The sidebar's own top row is a handle too, but only over its
            own width - grabbing the window anywhere to the right of it would
            do nothing.

            Only on macOS. Windows and Linux still draw their own title bar, so
            a row here would stack a second empty one under the real one.

            The left padding is the traffic-light reserve. Collapsed, the
            sidebar rail is 56px against the ~78px the lights occupy from the
            window edge, so this column's top-left corner is underneath them -
            and anything put in this row without the reserve would render under
            the window buttons: unclickable, with the OS window menu opening on
            top of it. Nothing sits here today, which is exactly why the
            reserve is written down rather than discovered again by whatever is
            put here next.

            `pl-8` is 32px, and it is 32 rather than 48 because the rail grew:
            the lights reach ~78px and the rail covers 56 of them, leaving 22 to
            round up. The arithmetic is in sidebarWidth.ts beside the number
            that drives it, and a test pins the pair.
          */}
          {/* Only while the sidebar is COLLAPSED, which is the only time this row
              earns its 36px. Open, the sidebar is wider than the traffic lights
              and already carries its own drag region with the wordmark in it -
              so this row would be reserving space for buttons that are not over
              it and offering a second handle for a window that already has one.
              Collapsed, the rail is 56px against the lights' ~78px, and
              without this the first control renders underneath them.

              The 36px goes to the terminal, which is the whole reason the git
              panel moved into a button as well.

              And not at all in FULL SCREEN, or with the terminal's tabs on
              screen (e7ad8020). Full screen has no lights and no window to
              drag; over the terminal the tab strip is the top row and carries
              the handle and the reserve itself. What is left is the board,
              windowed, with the sidebar collapsed. */}
          {reservesWindowControls && !tabsAreTitleBar && (
            <div
              data-app-region="drag"
              data-reserves-window-controls="true"
              className={clsx(
                'flex h-9 shrink-0 items-center border-b border-border-soft bg-nav-surface',
                'pl-8',
              )}
            />
          )}

          {/* The panels and the Runs strip share this column, and the board
              stays exactly where it is in the tree: moving `children` to a
              different parent would unmount and remount it, losing scroll
              position, open menus and anything half-typed. */}
          {/* Rendered, not conditionally mounted — see rule 1 above. */}
          {/* A REGION, not a tabpanel. It was a tabpanel labelled by `tab-kanban`
              until the Kanban tab was removed, and then the label pointed at a
              button that no longer existed: no accessible name at all, and a
              role whose whole contract is to be paired with a tab in the
              tablist. A tabpanel with no tab is not a tabpanel.

              Named for the sidebar entry that now opens it, so what a screen
              reader announces matches what the user clicked. */}
          <div
            role="region"
            id="panel-kanban"
            aria-label="Tasks"
            tabIndex={0}
            hidden={active !== 'kanban'}
            className="min-h-0 flex-1 overflow-auto scrollbar-slim"
          >
            {children}
          </div>

          {/*
            * The project's own page. Mounted only once it has been opened:
            * unlike the board and Settings there is nothing to preserve before
            * somebody asks for it, and rendering one per project in the
            * sidebar would hold a page in memory for every row.
            */}
          <div
            role="region"
            id="panel-project"
            aria-label="Project"
            tabIndex={0}
            hidden={active !== 'project'}
            className="min-h-0 flex-1 overflow-hidden"
          >
            {pageProject && (
              <ProjectPage
                project={pageProject}
                cards={pageCards}
                runningAgents={pageAgents}
                onOpenBoard={projectId => { setActiveProjectId(projectId); setActive('kanban'); }}
                onOpenCard={item => { setActiveProjectId(item.projectId); setActive('kanban'); revealOnBoard({ itemId: item.id, projectId: item.projectId }); }}
                /*
                 * The same call the board makes: resume the session if this
                 * card already has one, otherwise ask WHICH AGENT. Both
                 * decisions live there; the page only supplies the card.
                 */
                onStartAgent={item => {
                  /*
                   * The session that is already showing this work, whether it
                   * was opened ON this card or hosts the subagent doing it.
                   * Only when there is none does this become a spawn.
                   */
                  const open = openSessionFor(item.id);
                  if (open) {
                    setActiveSession(open);
                    setTerminalOpened(true);
                    setActive('terminal');
                    return;
                  }
                  requestTerminal(item);
                }}
                /*
                 * An agent we do not host: the card's own runs, read-only.
                 * Never a spawn — that is the whole point of the third state.
                 */
                onShowRuns={item => { setActiveProjectId(item.projectId); setActive('kanban'); revealOnBoard({ itemId: item.id, projectId: item.projectId }); }}
                onOpenTerminal={() => requestProjectTerminal(pageProject.id, pageProject.name)}
                working={working}
                /*
                 * The project's own flow, so the state filter names the states
                 * THIS project has. Same query key the board uses, so it is
                 * one cache entry and one request.
                 */
                flow={pageFlow ?? null}
                onAsk={projectId => setAsking(projectId)}
              />
            )}
          </div>

          {/* Hidden, not unmounted, for the same reason as the board: coming
              back from Settings must not have thrown away scroll position or
              an edit in flight. It holds no process, so nothing worse than
              that is at stake here. */}
          <div
            /* A region, not a tabpanel. No button carries
               aria-controls="panel-settings" — it is reached from the sidebar,
               not from the tablist — and a tabpanel with no owning tab is an
               ARIA authoring error that reports a tablist with nothing
               selected. */
            role="region"
            id="panel-settings"
            aria-label="Settings"
            tabIndex={0}
            hidden={active !== 'settings'}
            /* overflow-hidden, not auto: the settings body scrolls itself so
               the section rail stays put. Two nested scrollers would give the
               user two scrollbars and move the rail out of reach. */
            className="min-h-0 flex-1 overflow-hidden"
          >
            {settingsOpened && <SettingsPanel />}
          </div>

          {/* Rendered, not conditionally mounted — and more load-bearing here
              than for the board. Unmounting tears the session down, so
              switching to Kanban to look something up would kill the agent
              mid-run and take the whole scrollback with it. Holding a shell
              open for a card the user stepped away from is by far the cheaper
              mistake. */}
          {/* A REGION, not a tabpanel, for the same reason the board became one
              when the Kanban tab went: this was labelled by `tab-terminal`, and
              with that button deleted the reference dangled - a panel with no
              accessible name, claiming a role whose whole contract is to be
              paired with a tab in a tablist.

              Named "Terminal" rather than for a route into it, because there
              are several: the sessions rail, a card in the sidebar tree, and
              the board's own request. */}
          <div
            role="region"
            id="panel-terminal"
            aria-label="Terminal"
            tabIndex={0}
            hidden={active !== 'terminal'}
            /*
             * A FLEX COLUMN, and that is the whole fix for the terminal that
             * would not show its input line.
             *
             * The child below is `flex-1`, which means nothing unless its
             * PARENT is a flex container — so it was never told to stop at the
             * bottom of this region, and `h-full` inside it resolved against a
             * height of `auto`. The pane therefore grew to whatever height its
             * content wanted, and xterm's fit addon dutifully measured THAT:
             * 64 rows where about 36 were visible. The agent drew its input
             * box on the last row it believed in, nearly thirty rows below the
             * window's edge, and no amount of scrolling could reach it —
             * nothing had overflowed, the box simply was not on screen.
             *
             * `overflow-hidden` for the same reason the other regions have it:
             * the pane manages its own scrollback, and a second scrollbar out
             * here would scroll the terminal away from its own viewport.
             */
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            {/*
              * ONE surface. A herdr session opens as a terminal tab beside the
              * others, because that is what it is - the previous version put a
              * read-only mirror in front of this column and hid the terminals
              * behind it, which was a second place to look at the same work.
              */}
            {terminalOpened && (
              <div className="flex min-h-0 flex-1 flex-col">
              <TerminalTab
                sessions={sessions}
                sessionStates={sessionStates}
                /*
                 * The layout is a TREE, owned here (7a717cb8, 3b). The pair
                 * the Split control asks for is one split in it; a drop on a
                 * pane edge adds or moves a leaf, and each split draws its own
                 * divider, so the arrangement can nest.
                 */
                paneTree={paneTree}
                onPaneTreeChange={setPaneTree}
                onDropSession={applyDrop}
                onToggleSplit={toggleSplit}
                onReorder={reorderSessions}
                /*
                 * The REAL width, not the old fixed 224. TerminalTab computes
                 * how many COLUMNS fit from this, so a resizable sidebar feeding
                 * it a constant would size the terminal for a sidebar that is no
                 * longer there - and the symptom is not visual, it is the
                 * agent's own output wrapping at the wrong column.
                 */
                sidebarWidthPx={sidebarOpen ? sidebarWidth : SIDEBAR_COLLAPSED_PX}
                activeId={activeSession}
                onSelect={setActiveSession}
                onClose={closeSession}
                editors={editors}
                showWorktree
                titleBar={drawsTitleBar ? { reserveWindowControls: !sidebarOpen } : undefined}
                onOpenInEditor={(itemId, editorId) => {
                  // Fire and forget: failing to open an editor must not
                  // disturb the terminal the user is working in.
                  void openInEditorFromBridge(itemId, editorId).catch(() => {});
                }}
                onSpawned={rememberSession}
                // Our own terminals have no AgentRun and therefore no run
                // events, so their output is what tells the rail they are
                // working. Without it they read as idle forever — and the rail
                // only offers STOP for running or waiting, so the one state
                // they could reach was the one with no controls.
                onOutput={itemId => { live.touch(itemId); }}
                onScreenActivity={(sessionId, screenActivity) => {
                  setSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, screenActivity } : s)));
                }}
                onActivity={(sessionId, activity) => {
                  // Recorded on the SESSION, like the exit: two agents can
                  // share a card, and one working says nothing about the other.
                  setSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, activity } : s)));
                }}
                onExited={(sessionId, exitCode) => {
                  // Recorded on the SESSION. Clearing liveness by card would
                  // darken a second agent still working in the same worktree.
                  //
                  // The CODE is kept, not just the fact: a nonzero exit is the
                  // one failure this app can actually observe, and discarding
                  // it made a crashed agent look exactly like `exit`.
                  setSessions(prev => prev.map(s => (
                    s.id === sessionId ? { ...s, exited: true, exitCode } : s
                  )));
                }}
                /*
                 * Asks WHICH CARD, instead of assuming the active one.
                 *
                 * It used to reopen on the active session's card and nothing
                 * else, so there was no route from the Terminal view to any
                 * other card — back to the sidebar every time. And with no
                 * active session it did nothing whatsoever: no dialog, no
                 * message, not even a disabled state. A control that does not
                 * respond reads as a broken app, not as one with nothing to
                 * act on.
                 */
                onNew={() => setPickingCard(true)}
              />
              </div>
            )}
          </div>

        </main>
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-border-soft bg-nav-surface px-3 text-[11px] text-ink-tertiary">
        <span className="flex items-center gap-1.5">
          <span
            className={clsx(
              'inline-block h-1.5 w-1.5 rounded-full',
              connection === 'connected' ? 'bg-status-ok-text' : 'bg-ink-tertiary',
            )}
          />
          <span data-testid="connection-state">{CONNECTION_LABEL[connection]}</span>
        </span>
        <span className="font-mono">{window.location.host}</span>

        {/* beae41a0: on every tab - the board's header, which has it in a browser, is hidden behind a terminal. */}
        <VerifyRunsChip placement="up" />

        <button
          onClick={() => setWhatsNewOpen(true)}
          data-testid="app-version"
          title="What's new"
          className="font-mono transition-colors hover:text-ink-secondary"
        >
          v{version ?? '—'}
        </button>

        <button
          onClick={() => setReadmeOpen(true)}
          className="flex items-center gap-1 font-semibold transition-colors hover:text-ink-secondary"
        >
          <Book size={10} />
          README
        </button>

        {info && <span className="ml-auto font-mono">Electron {info.versions.electron}</span>}
      </footer>

      {/*
        The fan-out sheet (CGLAB-207).
        Opened by a gesture and never by dispatching: it exists so a person
        sees the collisions BEFORE spending, and popping it up on its own turns
        a deliberate review into an interruption.
      */}
      {fleetParent ? (
        <div
          // `no-drag`: a drag region beats whatever is stacked over it, so
          // without this the top of the window ignores the click that closes
          // this. The terminal's tab strip is a drag region on macOS.
          data-app-region="no-drag"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setFleetParentId(null)}
        >
          <div onClick={e => e.stopPropagation()}>
            <FleetSheet
              parent={fleetParent}
              all={allItemsForFleet}
              depth={mayFanOutLocal(fleetParent.id, allItemsForFleet)}
              /*
               * What the DISPATCHER will refuse, told to the thing that counts.
               * requestTerminal takes you to an existing terminal rather than
               * starting a second agent in the same worktree - correct, and a
               * rule the plan did not know, so the button counted a card it was
               * never going to launch.
               */
              running={itemsWithATerminal}
              terminalStatuses={fleetTerminalStatuses}
              onClose={() => setFleetParentId(null)}
              onLaunch={(ids: readonly string[]) => {
                setFleetParentId(null);
                /*
                 * One terminal per cleared child, and ONLY the cleared ones -
                 * the sheet already refused the rest, and re-deciding here
                 * would be a second opinion with nothing to say which is
                 * right.
                 */
                for (const id of ids) {
                  const child = allItemsForFleet.find(i => i.id === id);
                  if (child) requestTerminal(child as never);
                }
              }}
            />
          </div>
        </div>
      ) : null}

      {/*
        * The room behind the door (780182ff). Opened from the picker's empty
        * state, into the same project a card would have been created in — the
        * terminal's project first, the remembered one as fallback, exactly as
        * `onCreateCard` above decides it. With no project there is nowhere to
        * put the cards, so the door stays shut rather than opening onto a
        * panel that cannot finish.
        */}
      {asking && (
        <div
          // `no-drag`: see the fleet sheet's backdrop above.
          data-app-region="no-drag"
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-8 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setAsking(null); }}
        >
          <div className="max-h-full w-full max-w-2xl overflow-auto rounded-2xl border border-border-soft bg-surface shadow-2xl">
            <AskAgenfk
              projectId={asking}
              /*
               * LAND ON THE RESULT. Closing onto the screen they started from
               * meant the cards they had just approved were somewhere else,
               * and the only way to see them was to go looking. The project's
               * page is where they are listed.
               *
               * The page, NOT a terminal. Cards appearing is cheap and
               * reversible; an agent starting is neither, and the gate between
               * those two is what that panel exists for (artifact aca414c7
               * §06). Starting work stays a thing somebody presses.
               */
              onCreated={(_count, projectId) => {
                setAsking(null);
                setPageProjectId(projectId);
                setActive('project');
              }}
              onProjectAdded={projectId => {
                setAsking(null);
                setPageProjectId(projectId);
                setActive('project');
              }}
              onClose={() => setAsking(null)}
            />
          </div>
        </div>
      )}

      {pickingCard && (
        <CardPicker
          items={activeWork}
          projectNames={projectNames}
          currentItemId={sessions.find(s => s.id === activeSession)?.itemId}
          /*
           * The way out of an empty picker, which is now the door that
           * PROPOSES (82345ab9). Writing a card by hand went with the manual
           * form, and the picker closes first so the panel is not opened
           * underneath a dialog.
           *
           * THE TERMINAL'S project wins over the sidebar's selection, and that
           * order is not arbitrary. This dialog is opened from the terminal
           * strip and every row in it is about that terminal's world.
           */
          onAsk={(() => {
            const intoProject = sessions.find(s => s.id === activeSession)?.projectId
              || activeProjectId;
            if (!intoProject) return undefined;
            return () => { setPickingCard(false); setAsking(intoProject); };
          })()}
          onClose={() => setPickingCard(false)}
          onPick={item => {
            setPickingCard(false);
            /*
             * A NEW terminal, always — including on the card the strip is
             * already showing.
             *
             * Routing this through `requestTerminal` was wrong, and review
             * caught it: that function's job is "take me to my work", so it
             * switches to an existing terminal instead of opening one. From
             * the `+` that made the picker's FIRST row — the current card,
             * hoisted to the top and labelled — a click that closed the dialog
             * and changed nothing on screen. The dead control this card exists
             * to fix, one layer deeper.
             *
             * It also removed the only route to a second agent on one card,
             * which the surrounding code is built for: tabs are labelled
             * "<agent> <n>" precisely so two on one card are distinguishable,
             * and MAX_SESSIONS_PER_WINDOW is 30.
             *
             * The existing-terminal guard is not lost — it lives where it
             * belongs, on clicking a card in the sidebar or on the board,
             * which means "take me to it" rather than "give me another".
             */
            setActiveProjectId(item.projectId);
            markProjectWorked(item.projectId);
            // allowSecond: this is the + , which exists to give one card a
            // second terminal. Deduping here would make the button do nothing
            // whenever the card already had one queued.
            enqueuePending({
              itemId: item.id,
              title: item.title,
              agentId: item.agentId,
              branchName: (item as { branchName?: string | null }).branchName ?? null,
            }, true);
          }}
        />
      )}

      {pending && (
        <NewTerminalDialog
          cardTitle={pending.title}
          /*
           * The CARD's remembered agent wins, then the desktop's default, then
           * the dialog's own 'claude-code'. Card first because it is the more
           * specific answer: somebody who chose an agent for this card meant
           * that card.
           */
          defaultAgentId={pending.agentId || desktopPrefs?.defaultAgentId || undefined}
          /*
           * A card whose work is ALREADY running does not need a second
           * terminal, so the button says Continue. `sessionRows` is the right
           * source because the herdr panes are already folded into it - the
           * dialog does not need to know which multiplexer anything is in, only
           * that something is there.
           */
          existing={(() => {
            const live = sessionRows.find(
              r => r.itemId === pending.itemId && r.state !== 'failed',
            );
            if (!live) return undefined;
            /*
             * THREE PLACES, not two. A herdr pane is reachable through herdr;
             * a row with a terminal of ours is in this app; anything else is a
             * run recorded by the hook, in somebody's own shell — so the
             * dialog must not call it "already open here".
             */
            const where = (live as { source?: string }).source === 'herdr'
              ? 'herdr'
              : live.hasTerminal ? 'agenfk' : 'outside';
            return { agentId: live.agentId, where } as const;
          })()}
          listAgents={listAgentsFromBridge}
          // Shift, never clear: dismissing ONE question must not throw away the
          // rest of the wave. Clearing here was the single-slot habit surviving
          // the queue - and it fails in the direction that loses work silently.
          onClose={shiftPending}
          // ASYNC, because the dialog awaits it: `() => void` is not assignable
          // to its prop type, and the failure surfaces only in `tsc -b` — the
          // package's own `tsc --noEmit` does not build the project references
          // and stayed quiet about it.
          onCreate={async ({ agentId }) => {
            /*
             * Latch and switch BEFORE clearing `pending`, so the panel exists by
             * the time the dialog goes away — otherwise the user watches an
             * empty tab for a frame while the pane mounts.
             *
             * The body lives in `openPendingTerminal`, shared with the path that
             * skips this dialog entirely (askBeforeOpening off, project
             * terminal), so the two cannot open a terminal differently.
             */
            openPendingTerminal(pending, agentId);
            shiftPending();
          }}
        />
      )}

      <ReadmeModal isOpen={readmeOpen} onClose={() => setReadmeOpen(false)} />
      <WhatsNewModal isOpen={whatsNewOpen} onClose={() => setWhatsNewOpen(false)} />

      {/* Mounted only while open. Guarded on the project because the editor's
          `projectId` is not optional; that is the type holding, and it is NOT
          the same test the sidebar row makes - the row only knows whether an id
          is set, not whether it still names a project that exists.

          Waiting on `flowPending` is the load-bearing part. The editor reads
          `activeFlowId` exactly once, when it mounts, so handing it `undefined`
          for the one tick before this query resolves opens it on nothing
          selected and it never corrects. Mounting a beat later is the visible
          cost of it opening on the right flow. Once the board has warmed the
          shared cache - the usual case, since it is mounted from launch - there
          is no wait at all. */}
      {flowsOpen && activeProjectId && !flowPending && (
        <FlowEditorModal
          isOpen
          onClose={() => setFlowsOpen(false)}
          projectId={activeProjectId}
          activeFlowId={shellFlow?.id}
        />
      )}
    </div>
  );
}

interface SidebarProps {
  /** The open width in px. Ignored while collapsed, which is a fixed rail. */
  readonly widthPx: number;
  /** False when the window leaves no room to grow: the handle is then hidden. */
  readonly resizable: boolean;
  /** True only while a drag is in flight, so the width transition can be dropped. */
  readonly dragging: boolean;
  readonly onResizeStart: () => void;
  readonly onNudge: (deltaPx: number) => void;
  /**
   * Open the fan-out sheet for a card that has children (CGLAB-207).
   *
   * A gesture, never automatic: the sheet exists so a person sees the
   * collisions before spending, and opening it by itself turns a deliberate
   * review into an interruption.
   */
  readonly onOpenFleet: (itemId: string) => void;
  open: boolean;
  onToggle: () => void;
  /**
   * A macOS WINDOW: the traffic lights sit on the sidebar's top strip and it
   * is a handle. False off macOS (a native bar) and in full screen (neither).
   */
  drawsTitleBar: boolean;
  sessionRows: SessionRow[];
  herdrProject: ProjectPaneRow[];
  openPane: string | null;
  onOpenPane: (row: ProjectPaneRow | null) => void;
  /** Cards an agent has touched inside the live window. */
  liveItems: ReadonlySet<string>;
  openSession: (row: SessionRow) => void;
  /** Clicking a card asks the shell to open a terminal on it. */
  requestTerminal: (item: AgEnFKItem) => void;
  /**
   * Open a terminal ON A PROJECT — no card, so it runs in the project's own
   * checkout. The same call the project page's Open terminal makes.
   */
  onOpenProjectTerminal: (projectId: string, title: string) => void;
  /** Take the board to a card. The rail's secondary affordance. */
  /**
   * Take the board to a card.
   *
   * Typed by what the action NEEDS rather than by where it came from: the
   * session rail passes a full row, the card context menu passes a card. A
   * SessionRow-shaped parameter would have forced the menu to invent fields it
   * has no business knowing about, or to duplicate the navigation.
   */
  revealOnBoard: (row: { itemId: string; projectId?: string }) => void;
  /** Opens the settings screen. Pinned, so it is reachable at any list length. */
  openSettings: () => void;
  /** Which view the main pane is showing, so WORK can mark it. */
  activeView: ViewId;
  /** Open a project's own page. The sidebar knows which; the shell knows how. */
  onOpenProject?: (projectId: string) => void;
  /** Picking a WORK row. The shell owns `active`; the sidebar only asks. */
  onSelectView: (view: ViewId) => void;
  /**
   * Opening the flow editor over the app.
   *
   * The shell owns it for the same reason it owns `active`: the editor is a
   * full-screen overlay on the whole window, and hanging it off the sidebar
   * would put an app-wide surface inside the column it covers.
   */
  onOpenFlows: () => void;
  /** Open the user's own shell in `$HOME` — no card, no project, no dialog. */
  onOpenTerminal: () => void;
}

function Sidebar({ open, onToggle, drawsTitleBar, widthPx, resizable, dragging, onResizeStart, onNudge, requestTerminal, onOpenProjectTerminal, sessionRows, herdrProject, openPane, onOpenPane, liveItems, openSession, openSettings, revealOnBoard, activeView, onSelectView, onOpenProject, onOpenFlows, onOpenTerminal, onOpenFleet }: SidebarProps) {
  /*
   * EVERY item, to tell which cards have children (the fleet launcher). Not the
   * in-flight list the rows are drawn from: a parent's children are anywhere.
   */
  const { data: allItems = [] } = useQuery<AgEnFKItem[]>({
    queryKey: ['items-all'],
    queryFn: () => api.listItems(),
    /*
     * Measured after review: `GET /items` returns FULL records - description,
     * comments, history - and on this machine that is 582 items and 8.1 MB.
     * With the default staleTime of 0 and refetch-on-focus, every alt-tab back
     * into the window re-fetched and re-parsed all of it, in a renderer that is
     * also driving xterm.
     *
     * Freshness comes from the socket instead, which is also strictly BETTER
     * than focus: a new child shows up when it is created, not on an alt-tab.
     *
     * The key is its own rather than ['items'], because invalidateQueries
     * matches by PREFIX and eight board and import mutations already
     * invalidate ['items', projectId] - each of which would otherwise have
     * started pulling 8 MB as a side effect.
     */
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    gcTime: 5 * 60_000,
  });
  const queryClient = useQueryClient();
  const { activeProjectId, setActiveProjectId, requestNewItem } = useActiveProject();
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  /**
   * The card a right-click opened a menu on, and where to draw it.
   *
   * A card row's click opens a TERMINAL, which is the thing you want from work
   * in flight. Getting to the same card on the BOARD had no route from here at
   * all — the secondary action needed a secondary gesture rather than a second
   * button competing for a row this narrow.
   */
  const [cardMenu, setCardMenu] = React.useState<{ item: AgEnFKItem; x: number; y: number } | null>(null);
  /*
   * Pinned projects come from the SERVER (SQLite), not localStorage.
   *
   * The UI is served on http://127.0.0.1:<port>, and the port moves when it is
   * taken — localStorage is origin-scoped, so a pin made on one port was gone
   * on the next. Read through the shared `['settings']` cache so the shell's
   * other readers of the same object stay in step.
   */
  const { data: sidebarSettings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const pinned = sidebarSettings?.pinnedProjects ?? [];
  const pinProjects = useMutation({
    // The whole list, not a toggle: the order IS the data, and a toggle route
    // would need the server to know the current order anyway.
    mutationFn: (next: string[]) => api.updateSettings({ pinnedProjects: next }),
    onSuccess: settled => { queryClient.setQueryData(['settings'], settled); },
  });
  const togglePinnedProject = (id: string): void => {
    pinProjects.mutate(pinned.includes(id) ? pinned.filter(x => x !== id) : [...pinned, id]);
  };
  const [expanded, setExpanded] = React.useState<string[]>(() => readExpanded());

  /**
   * Projects opened BY the filter, and not remembered.
   *
   * Separate from `expanded` deliberately. A filtered tree is short by
   * definition, and leaving the results folded costs a click per project to
   * see the thing you just asked for. But writing that to storage would
   * discard the collapse a person chose - the same objection the "N running"
   * control answers by only touching projects it has a claim on. This forgets
   * on its own when the filter clears.
   */
  const [expandedByFilter, setExpandedByFilter] = React.useState<string[]>([]);
  const [sort, setSort] = React.useState<ProjectSort>(() => readProjectSort());
  const [agentFilter, setAgentFilter] = React.useState<string[]>(() => readAgentFilter());

  /*
   * The session rows with their ORIGIN attached, derived once.
   *
   * `source` is set by the tree rows for a pane herdr is holding, and the
   * filter needs it: a card whose only session is a herdr pane must answer to
   * the herdr filter, and passing the raw rows through would silently drop
   * that - the field is optional, so nothing would have complained.
   */
  const filterableSessions = React.useMemo(
    () => sessionRows.map(r => ({
      itemId: r.itemId,
      agentId: r.agentId,
      fromHerdr: (r as { source?: string }).source === 'herdr',
    })),
    [sessionRows],
  );

  /*
   * The agents ACTUALLY in the tree, from both sources. Offering every agent
   * the product supports would put rows in the menu that can only empty the
   * list; five are installed and a machine rarely runs two at once.
   */
  const agentOptions = React.useMemo(
    () => availableAgentFilters(collectFilterableRows(sessionRows, herdrProject)),
    [sessionRows, herdrProject],
  );

  /*
   * A selection whose agent has since stopped is dropped.
   *
   * Its row leaves the menu when the last session of that kind ends, and the
   * selection would survive in storage behind it - a filter still narrowing
   * the list with no visible way to turn it off, which reads as the app having
   * lost the projects.
   */
  React.useEffect(() => {
    const live = pruneAgentFilter(agentFilter, agentOptions);
    if (live.length !== agentFilter.length) setAgentFilter(writeAgentFilter(live));
  }, [agentOptions, agentFilter]);



  const toggleAgentFilter = React.useCallback((agentId: string): void => {
    setAgentFilter(prev => writeAgentFilter(
      prev.includes(agentId) ? prev.filter(id => id !== agentId) : [...prev, agentId],
    ));
  }, []);

  // One request for every project's in-flight work. The server answers this
  // per project against that project's own flow, so there is no second copy
  // of "what counts as active" living in the UI.
  const { data: activeItems = [] } = useQuery({
    queryKey: ['active-items'],
    queryFn: api.listActiveItems,
  });
  useSocketEvent('items_updated', () => {
    queryClient.invalidateQueries({ queryKey: ['active-items'] });
    /*
     * The project page's own list, which is a DIFFERENT question — every card
     * of one project, anchors included. Without this it never refetched: the
     * page key does not change when cards are created into the project it is
     * already showing, which is exactly the path this release built ("land on
     * the result"). The result was not there.
     */
    queryClient.invalidateQueries({ queryKey: ['project-items'] });
    // Every item too, or a new child waited for a window focus to show.
    queryClient.invalidateQueries({ queryKey: ['items-all'] });
  });
  // Anything that changed while the socket was down produced no event, so the
  // counts stay wrong until the next unrelated item change. The board already
  // refetches its own queries on connect; this one is keyed differently and
  // was not covered by that.
  useSocketEvent('connect', () => queryClient.invalidateQueries({ queryKey: ['active-items'] }));

  /**
   * The cards a human has to answer.
   *
   * Derived from the rows the sidebar is ALREADY given rather than from a new
   * query: the rail and the tree would otherwise disagree about the same
   * sessions, which is how the two lists drifted apart earlier in this epic.
   */
  const needsPerson = React.useMemo(() => itemsNeedingAPerson(sessionRows), [sessionRows]);

  const inFlightByProject = React.useMemo(() => {
    const byProject = new Map<string, AgEnFKItem[]>();
    for (const item of activeItems as AgEnFKItem[]) {
      const list = byProject.get(item.projectId) ?? [];
      list.push(item);
      byProject.set(item.projectId, list);
    }
    return byProject;
  }, [activeItems]);

  // Sort first, then lift the pinned ones: pinning is a stronger statement
  // than any ordering, so it must be applied last.
  // activeProjectId is a dependency even though orderProjects never receives
  // it: opening a project is what writes the local last-used rank that
  // orderProjects reads from storage. Without it the memo holds the old order
  // until the projects query object identity happens to change — which,
  // thanks to structural sharing, may not happen all session, so the list
  // would reorder at some arbitrary later moment instead of on the click.
  const ordered = React.useMemo(
    () => sortProjectsByPin(orderProjects(projects as Project[], sort), pinned),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, pinned, sort, activeProjectId],
  );

  /*
   * Narrowed AFTER ordering, never instead of it.
   *
   * Pinning and last-used still decide the sequence; the filter only removes.
   * Doing it the other way round would let a filter quietly reorder what is
   * left, so turning one on and off again would not return the list to where
   * it was.
   *
   * A project with no agent of the chosen kind goes entirely, because that is
   * what the filter is FOR: "where is pi running" is answered by a shorter
   * list of projects, not the same list with emptier branches.
   */
  const visible = React.useMemo(
    () => (agentFilter.length === 0
      ? ordered
      : ordered.filter(p => projectMatchesAgentFilter(
          collectFilterableRows(sessionRows, herdrProject, { id: p.id, name: p.name }),
          agentFilter,
        ))),
    [ordered, agentFilter, sessionRows, herdrProject],
  );

  /*
   * Open what the filter left. The chevron still works afterwards - a person
   * can fold one away - which is why this seeds a state rather than forcing
   * `isOpen` true for as long as the filter is on. A control that does
   * nothing while a mode is active is worse than one that is absent.
   */
  React.useEffect(() => {
    const next = agentFilter.length === 0 ? [] : visible.map(p => p.id);
    /*
     * Return `prev` when nothing moved, or this never settles.
     *
     * The effect ran with a fresh array every time and `[] !== []`, so each
     * run scheduled a render and each render fed the next run. React does not
     * catch it - the updates are not nested, they are a steady drip - and the
     * whole AppShell tree re-rendered on every drop. The suite did not fail;
     * it stopped finishing, at 100% of one core.
     */
    setExpandedByFilter(prev => settleIds(prev, next));
  }, [agentFilter, visible]);

  /**
   * The project row's own menu, opened with a right-click.
   *
   * WHERE "New card here" WENT. It was the hover `+` on the row, and the `+`
   * now opens a terminal — the same action as the project page's Open terminal.
   * Deleting the card action instead would have removed the only route to it
   * from the sidebar, so it moved to the menu a pointer user already tries.
   *
   * The cost is discoverability, and it is a real one: a hover button is
   * visible without being looked for, a context menu is not. What earns the
   * trade is that the row's most frequent action became one click.
   */
  const [projectMenu, setProjectMenu] = React.useState<{ id: string; name: string; x: number; y: number } | null>(null);

  React.useEffect(() => {
    if (!projectMenu) return;
    /*
     * Dismissal on `mousedown`, not `click`, and the menu excludes itself.
     *
     * A `click` listener closes on the way UP, which is after the menu item's
     * own click has run — but a `mousedown` one that did not exclude the menu
     * would close it BEFORE the item's click fired, and every item would look
     * broken. Asking what was pressed is what keeps both properties.
     */
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as Element | null)?.closest?.('[data-project-menu]')) setProjectMenu(null);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setProjectMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [projectMenu]);

  // Collapsed is a rail, not nothing. A toggle that vanishes with the panel it
  // hides is a one-way door, and the control stays where the eye last saw it.
  //
  // One <aside> with one header row in both modes, deliberately: rendering two
  // different trees made React destroy and recreate the button on every
  // collapse, which dropped keyboard focus to <body> — a keyboard user thrown
  // to the top of the document by their own click. Same element, same
  // position, so React reuses the node and focus rides along.
  return (
    <aside
      className={clsx(
        'relative flex shrink-0 flex-col border-r border-border-soft bg-nav-surface',
        // 160ms: long enough for the eye to follow the edge, short enough not
        // to feel slow on something toggled dozens of times a day. Width, not
        // transform — the sidebar has to make ROOM, and a transform would
        // slide it over the board instead of pushing it.
        // Dropped WHILE DRAGGING. Animating toward a width that changes on
        // every pointermove makes the edge chase the cursor a beat behind, and
        // a control that lags reads as a broken one.
        !dragging && 'transition-[width] duration-150 ease-out motion-reduce:transition-none',
        !open && 'items-center',
      )}
      // Inline, because the width is a number now rather than one of two
      // classes, and Tailwind cannot generate a class per pixel.
      style={{ width: open ? widthPx : SIDEBAR_COLLAPSED_PX }}
    >
      {/*
        The drag handle.

        HIDDEN, not disabled, when the window leaves no room: a control that
        moves nothing when you pull it reads as a broken app, while an absent
        one reads as a narrow window, which is what it is.

        5px of hit area over a 1px border. A one-pixel target is a target only
        in theory, and this one sits on the edge people flick past on their way
        to the board.
      */}
      {open && resizable && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the sidebar"
          aria-valuenow={widthPx}
          aria-valuemin={SIDEBAR_MIN_PX}
          aria-valuemax={SIDEBAR_MAX_PX}
          tabIndex={0}
          data-testid="sidebar-resize"
          onPointerDown={e => { e.preventDefault(); onResizeStart(); }}
          onKeyDown={e => {
            // Arrow keys, because a drag-only feature is a mouse-only feature.
            // 16px a press: fine enough to land where you meant, coarse enough
            // to cross the range without holding the key down.
            if (e.key === 'ArrowLeft') { e.preventDefault(); onNudge(-16); }
            if (e.key === 'ArrowRight') { e.preventDefault(); onNudge(16); }
          }}
          className="absolute inset-y-0 right-0 z-10 w-[5px] translate-x-[2px] cursor-col-resize hover:bg-accent/30 focus-visible:bg-accent/40 focus-visible:outline-none"
        />
      )}
      {/* Traffic-light strip, macOS only: Electron hides the native title bar
          with titleBarStyle 'hiddenInset' there and nowhere else, so rendering
          this on Windows or Linux would add dead space under a real title bar.
          Dragging the window lives here; it holds no controls, because a drag
          region swallows pointer events. */}
      {/* The product name where macOS puts an app's name: level with the
          traffic lights, which is the first place anyone looks to find out
          what window they are in. On Windows and Linux there are no lights to
          clear, so it sits at the normal inset and the row is not a drag
          handle - those platforms draw their own title bar. */}
      {/*
        The brand and the toggle share ONE row now.

        Collapsed, the name gives way to the FK mark alone - the same shape,
        cropped, not a second asset: the wordmark is one path clipped in two and
        the right half is already the brand colour, so there is nothing to keep
        in sync.

        THE DRAG REGION IS WHY THIS WAS TWO ROWS. On macOS the title bar is
        hidden and this strip is what you grab to move the window - and a drag
        region SWALLOWS POINTER EVENTS, so a button dropped in here is simply
        dead. The button carries `no-drag` to cut itself back out, which is the
        only reason it can live beside the logo at all.

        And the toggle stays ONE element in both modes, at the same position
        under the same parent. Rendering two different trees made React destroy
        and recreate it on every collapse, which dropped keyboard focus to
        <body> - a keyboard user thrown to the top of the document by their own
        click. The test at "keeps keyboard focus on the toggle across a
        collapse" pins that.
      */}
      <div
        data-app-region={drawsTitleBar ? 'drag' : undefined}
        // `relative` so the toggle's hint anchors to this row without a wrapper
        // around the button: that the toggle's parent IS the row is what the
        // traffic-light test reads the padding through.
        className={clsx(
          'relative flex shrink-0',
          open
            /*
             * Open: one row. The 76px clears the traffic lights, which sit on
             * this strip because the sidebar is the leftmost column.
             */
            ? clsx('h-9 items-center justify-between pr-1', drawsTitleBar ? 'pl-[76px]' : 'pl-3')
            /*
             * Collapsed: a COLUMN, and the padding is chosen here rather than
             * overridden.
             *
             * `pl-[76px]` was applied in both modes with `pl-0` after it, which
             * is not an override - they are the same property at the same
             * specificity, so the winner is whichever Tailwind emitted later.
             * On a 40px rail the 76px won and pushed the mark off the edge,
             * which is why there was no FK on screen at all.
             *
             * And on macOS the lights own the top of the rail, so the mark
             * stacks UNDER them rather than fighting for the same row.
             */
            : clsx('flex-col items-center gap-2 px-0', drawsTitleBar ? 'pt-[34px]' : 'pt-2'),
        )}
      >
        {open
          ? <AgenfkWordmark size={13} />
          : <AgenfkWordmark size={16} markOnly />}
        <button
          onClick={onToggle}
          // `no-drag`: see above. Without it this button is unclickable on macOS.
          data-app-region={drawsTitleBar ? 'no-drag' : undefined}
          aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
          className={clsx(
            'peer flex items-center text-ink-tertiary transition-colors hover:bg-canvas hover:text-ink-secondary',
            /*
             * A 40px square on the rail, matching the nav rows below it, and
             * the short row it shares with the mark when the sidebar is open.
             * Collapsed this is the control the rail exists for, so it scales
             * with the icons instead of staying at the size the old one
             * wanted - a lone 14px glyph among 18px ones reads as left over.
             */
            open ? 'rounded p-1' : 'h-10 w-10 justify-center rounded-lg',
          )}
        >
          {open ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={18} />}
        </button>
        {!open && <span role="tooltip" className={RAIL_TIP_PEER}>Expand sidebar</span>}
      </div>

      {/* WORK, above PROJECTS (CGLAB-164). Where you GO, over what you have.
          A <nav> rather than a list of buttons in a div: this is the shell's
          primary navigation, and it is the landmark a screen-reader user jumps
          to.

          The group's title is not drawn. `aria-label` rather than a
          visually-hidden heading because the landmark was already carrying the
          name for assistive tech - the <h2> was the visible half of a name that
          exists in two places, and only the visible half was asked to go. The
          padding the heading used to contribute moves onto the <nav>, or the
          first row butts against the collapse control above it. */}
      {/* `pt-4` on the rail, not `pt-2`: with the labels gone the toggle and
          the first icon are two glyphs of the same size, and two pixels of gap
          reads as one control with a hiccup rather than as two things. */}
      <nav aria-label="Work" className={clsx('shrink-0', open ? 'px-2 pt-2' : 'px-1 pt-4')}>
        {/* The gap widens with the buttons: at 40px apiece, the 1px that
            separates the short rows when open leaves four of them reading as
            one block. */}
        <ul className={clsx('flex flex-col', open ? 'gap-px' : 'gap-1.5')}>
          {WORK_ROWS.map(row => {
            const { label, Icon } = row;
            const current = row.kind === 'view' && activeView === row.id;
            // An action with nothing to act on. The flow belongs to a project,
            // so with none open there is no editor to show - say that on the
            // control rather than opening an empty one.
            const disabled = row.kind === 'action' && row.id === 'flows' && !activeProjectId;
            return (
              <li key={row.id} className="group relative">
                <button
                  type="button"
                  onClick={() => {
                    if (disabled) return;
                    if (row.kind === 'view') onSelectView(row.id);
                    else if (row.id === 'flows') onOpenFlows();
                    else onOpenTerminal();
                  }}
                  // `aria-disabled`, not `disabled`. A disabled button is not
                  // focusable, so it can be neither tabbed to nor announced —
                  // and the title below, which is the whole point of the state,
                  // is a hover-only tooltip a keyboard user never sees. This
                  // keeps the row in the tab order and lets the reason be read
                  // out, at the cost of having to refuse the click ourselves.
                  aria-disabled={disabled || undefined}
                  /*
                   * ONE hint, deciding between two reasons - and it is the
                   * tooltip below rather than `title`, so it arrives at once
                   * and in this app's own colours instead of an OS bubble drawn
                   * a second later.
                   *
                   * A second `title` was added here once and JSX silently kept
                   * the last one - so the "open a project first" hint vanished
                   * the moment the rail hint arrived, with no error beyond a
                   * build warning nobody reads in a test run.
                   *
                   * The disabled reason wins when both apply: being told why a
                   * control is dead beats being told what it is called.
                   */
                  // `page`, not `true`: views are destinations, and a screen
                  // reader should say "current page" rather than the generic
                  // "current". Absent — not `false` — on the others, so exactly
                  // one row in the group ever carries it, and an action row
                  // never does.
                  aria-current={current ? 'page' : undefined}
                  /*
                   * NAMED EVEN WHEN THE TEXT IS GONE. On the rail the only
                   * child is an aria-hidden icon, so without this the button
                   * has no accessible name at all - a screen reader announces
                   * "button" three times and the nav becomes unusable at
                   * precisely the width where it is the only navigation left.
                   *
                   * `title` too, so a pointer user gets the same answer by
                   * hovering rather than by guessing at a glyph.
                   */
                  aria-label={label}
                  /*
                   * The dead row's reason is a DESCRIPTION, not a second name.
                   * It used to ride on `title`, which most screen readers do
                   * expose as the description - so dropping `title` for the
                   * tooltip would have taken it away. Pointing at the hint
                   * keeps it announced AND makes it visible on keyboard focus,
                   * which `title` never was.
                   */
                  aria-describedby={disabled ? `rail-tip-${row.id}` : undefined}
                  className={clsx(
                    'flex items-center gap-2 text-left text-[13px] transition-colors',
                    /*
                     * THE WIDTH IS CHOSEN PER MODE, NEVER OVERRIDDEN.
                     *
                     * `w-full` and `w-10` are the same property at the same
                     * specificity, so the winner is whichever Tailwind emitted
                     * LAST - not source order, and nothing the next reader can
                     * see. That is exactly how the FK mark went missing earlier:
                     * `pl-0` did not beat `pl-[76px]`. So the rail gets a 40px
                     * square and the open sidebar gets the full row, each as a
                     * complete answer.
                     */
                    open
                      ? 'w-full rounded-md px-2 py-1.5'
                      : 'h-10 w-10 justify-center rounded-lg px-0',
                    current
                      ? 'bg-accent-fill font-semibold text-accent-ink'
                      : 'text-ink-secondary hover:bg-canvas/60 hover:text-ink',
                    disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-ink-secondary',
                  )}
                >
                  {/* Decorative: the name is on the button, and a second one
                      here would make it say everything twice. */}
                  <Icon size={open ? 14 : 18} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
                  {/*
                    The label goes away on the rail, the ICON DOES NOT.
                    Collapsing used to take this whole nav with it, so the only
                    way to Tasks or Flows was to expand first - a rail
                    that offers nothing is a rail nobody leaves open.
                  */}
                  {open && label}
                </button>
                {/* Beside the button, not inside it: as a child it would join
                    the button's computed name, and this text duplicates the
                    accessible one. */}
                {/* Drawn whenever the text is NOT already on screen: on the
                    rail for every row, and in the open sidebar for the one row
                    whose hint is a reason rather than a repeat of its own
                    label. */}
                {(disabled || !open) && (
                  <span id={`rail-tip-${row.id}`} role="tooltip" className={RAIL_TIP}>
                    {disabled ? 'Open a project to edit its flow' : label}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {!open ? null : (
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">


      <div data-testid="projects-section" className="mt-3 flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center pr-1">
        <SidebarLabel>Projects</SidebarLabel>
        <div className="ml-auto flex items-center">
          <SortMenu
            value={sort}
            onChange={next => setSort(writeProjectSort(next))}
            agentOptions={agentOptions}
            selectedAgents={agentFilter}
            onToggleAgent={toggleAgentFilter}
            onClearAgents={() => setAgentFilter(writeAgentFilter([]))}
          />
        </div>
      </div>
      {/* What the SESSIONS section carried that the tree cannot.
      
          Its real value was never the list itself but the failures-first sort:
          a way to GET to the one agent that stopped. Drawing processes under
          their cards puts a stuck agent wherever its card happens to sit, which
          may be inside a collapsed project - so the count alone would replace
          something that took you there with something that tells you it exists.
          Hence the button.
      
          Silent when nothing is happening. A row of zeroes over a quiet tree
          trains the eye to skip the one place meant to catch it. */}
      {(() => {
        const running = sessionRows.filter(r => r.state === 'running').length;
        /*
         * `unverifiable` belongs here, and leaving it out was the one gap in
         * the route to a stuck agent.
         *
         * The card dot already counts it as needing a person (cardState folds
         * blocked, failed and unverifiable into `needs-person`), so the dot and
         * this count disagreed about the same fact. And it fails in the worst
         * place: every project starts COLLAPSED on a fresh install, so an agent
         * that went unreachable inside one has its dot hidden in an `inert`
         * subtree - this header row was the only remaining signal, and it
         * rendered nothing at all when no other row was failed or blocked.
         *
         * Derived from the same predicate the dot uses rather than restated, so
         * the two cannot drift apart again.
         */
        const stuck = sessionRows.filter(r => NEEDS_A_PERSON.has(r.state));
        if (running === 0 && stuck.length === 0) return null;
        return (
          <div className="flex shrink-0 items-center gap-1.5 px-1 pb-1 font-mono text-[10px]">
            {running > 0 && (
              /*
               * A button after all, and the reasoning that said otherwise was
               * half right. There is nothing to DO about an agent that is
               * working - but there is somewhere to GO, and on a fresh install
               * that somewhere is unreachable: readExpanded() starts empty, so
               * every project is collapsed and every process row with it. The
               * count named work the screen offered no route to.
               *
               * It EXPANDS what holds the work rather than jumping to one of
               * it. With three agents running, a jump has to pick, and picking
               * is the part with no good answer. Only the projects that hold
               * something running: opening the rest would discard a collapse
               * the user chose for projects this has no claim on.
               */
              <button
                type="button"
                onClick={() => {
                  const holders = new Set(
                    sessionRows
                      .filter(r => r.state === 'running')
                      .map(r => r.projectId)
                      .filter((id): id is string => Boolean(id)),
                  );
                  setExpanded(prev => {
                    const next = [...new Set([...prev, ...holders])];
                    writeExpanded(next);
                    return next;
                  });
                }}
                title="Open the projects with work running in them"
                className="rounded text-status-ok-text underline decoration-dotted underline-offset-2 transition-colors hover:decoration-solid"
              >
                {running} running
              </button>
            )}
            {running > 0 && stuck.length > 0 && <span className="text-ink-tertiary">·</span>}
            {stuck.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const first = stuck[0];
                  revealOnBoard({ itemId: first.itemId, projectId: first.projectId });
                }}
                title="Go to the first card that needs you"
                className="rounded text-status-warn-text underline decoration-dotted underline-offset-2 transition-colors hover:decoration-solid"
              >
                {stuck.length} need you
              </button>
            )}
          </div>
        );
      })()}

      <ul
        data-testid="project-list"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-slim"
      >
        {/*
          * A filter that empties the list must SAY SO, and offer the way out.
          * A blank tree with the projects still in the database reads as data
          * loss, and the only clue would be a tinted icon in the corner.
          */}
        {visible.length === 0 && agentFilter.length > 0 && (
          <li data-testid="agent-filter-empty" className="px-3 py-4 text-[11px] text-ink-tertiary">
            No project is running{' '}
            {agentFilter.map(id => agentLabel(id)).join(' or ')}.{' '}
            <button
              type="button"
              onClick={() => setAgentFilter(writeAgentFilter([]))}
              className="underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
            >
              Show all projects
            </button>
          </li>
        )}
        {visible.map((project: Project) => {
          const isActive = project.id === activeProjectId;
          const isPinned = pinned.includes(project.id);
          /*
           * Narrowed to the cards running the chosen agent, not just the
           * projects containing one.
           *
           * Stopping at the project answers "which project" and leaves the
           * actual question - WHICH WORK - exactly where it was: a project
           * here holds twenty-nine cards, and filtering to Pi and then listing
           * all of them is not an answer.
           *
           * The count, the chevron and the expand control all read this, so
           * they describe what the filter left rather than what it hid.
           */
          const work = (inFlightByProject.get(project.id) ?? [])
            .filter(item => cardMatchesAgentFilter(item.id, filterableSessions, agentFilter));

          /*
           * The panes herdr is holding here, narrowed the same way.
           *
           * Hoisted out of the list below because everything in that list was
           * gated on `work.length > 0` - so filtering to herdr, which removes
           * every CARD (these panes belong to the project's own checkout and
           * to no card at all), collapsed the branch and took the herdr rows
           * down with it. Projects with a dozen panes rendered as empty
           * folders that could not even be expanded.
           */
          const herdrRows = herdrProject
            .filter(r => r.projectName === project.name)
            .filter(r => matchesAgentFilter({ agentId: r.agentId, fromHerdr: true }, agentFilter));

          /*
           * What decides whether this project has a branch to open.
           *
           * Cards OR panes. Either is work under this project, and only one of
           * them used to count.
           */
          const childCount = projectChildCount(work, herdrRows);
          const isOpen = expanded.includes(project.id) || expandedByFilter.includes(project.id);
          return (
            <li key={project.id}>
              <div className="group relative flex items-center">
              {childCount > 0 ? (
                <button
                  onClick={() => {
                    // Closing has to clear BOTH, or a project the filter
                    // opened would spring back open the moment anything
                    // re-rendered.
                    if (isOpen) {
                      setExpandedByFilter(prev => prev.filter(id => id !== project.id));
                      setExpanded(prev => {
                        const next = prev.filter(id => id !== project.id);
                        writeExpanded(next);
                        return next;
                      });
                      return;
                    }
                    setExpanded(toggleExpanded(project.id));
                  }}
                  aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${project.name}`}
                  // The label names the ACTION; these name the STATE and the
                  // thing acted on. Without them a screen reader announces a
                  // plain button and an open folder is indistinguishable from
                  // a closed one.
                  aria-expanded={isOpen}
                  aria-controls={`work-${project.id}`}
                  className="shrink-0 rounded p-0.5 text-ink-tertiary transition-colors hover:text-ink"
                >
                  {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
              ) : (
                // A spacer, so rows with and without work still line up.
                <span className="w-[17px] shrink-0" aria-hidden="true" />
              )}
              <button
                /*
                 * TWO GESTURES ON ONE ROW, and they stay separate. The chevron
                 * expands and collapses; the NAME opens the project's page.
                 * Moving the expand onto the name would break the habit of
                 * anyone who uses the tree, and the page is the thing that had
                 * no way in at all.
                 */
                onClick={() => { setActiveProjectId(project.id); onOpenProject?.(project.id); }}
                // The secondary actions, where a pointer user looks for them.
                // `preventDefault` because the browser's own menu offers
                // nothing about this project and covers the screen.
                onContextMenu={e => {
                  e.preventDefault();
                  setProjectMenu({ id: project.id, name: project.name, x: e.clientX, y: e.clientY });
                }}
                aria-current={isActive ? 'true' : undefined}
                // Explicit, so the accessible name is the project and not
                // "horizon-lab 3d" — the age is decoration, not identity.
                aria-label={project.name}
                title={project.name}
                className={clsx(
                  'flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                  isActive
                    ? 'bg-accent-fill font-semibold text-accent-ink'
                    : 'text-ink-secondary hover:bg-canvas/60 hover:text-ink',
                )}
              >
                {/* Decorative: the row already has an accessible name, and a
                    second label here would make screen readers say it twice. */}
                <span data-folder-icon aria-hidden="true" className="shrink-0 text-ink-tertiary">
                  {isOpen && childCount > 0
                    /* The SAME size as its closed twin. They were 13 and 15,
                       so the row shifted by two pixels every time a project was
                       expanded - a wobble nobody can name and everybody sees. */
                    ? <FolderOpen size={15} />
                    : <Folder size={15} className={childCount === 0 ? 'opacity-50' : undefined} />}
                </span>
                {/* flex-1, or `justify-between` above shares the free space between all
                    four children and the name floats in the middle of the row -
                    which reads as a centred column and makes a list of projects
                    hard to scan down. Taking the space itself keeps the name
                    against its folder icon and pushes the count and age right. */}
                <span data-testid="project-name" className="min-w-0 flex-1 truncate text-left">{project.name}</span>
                {childCount > 0 && (
                  // Visible without expanding: the whole point of a folder is
                  // to say how much is inside before you open it.
                  <span
                    data-testid="in-flight-count"
                    /*
                     * Cards AND panes, because both are on the row below it.
                     * Counting only cards made a project holding a dozen herdr
                     * panes and no card of its own read as empty.
                     */
                    title={`${childCount} in flight`}
                    className="shrink-0 rounded-full bg-canvas px-1.5 font-mono text-[11px] text-ink-tertiary"
                  >
                    {childCount}
                  </span>
                )}
                <span
                  data-testid="project-age"
                  className={clsx(
                    'shrink-0 font-mono text-[11px] text-ink-tertiary group-hover:invisible',
                    /*
                     * Room for the pin, permanently, when the project is
                     * pinned.
                     *
                     * The hover case was already handled — this text hides and
                     * the pin and + take the corner. But a pinned project
                     * keeps its pin at full opacity ALWAYS, and rightly so:
                     * otherwise there is no way to see that it is pinned, nor
                     * to reach the control by keyboard. With no hover to hide
                     * behind, the pin was simply drawn on top of this.
                     *
                     * Reserving the space rather than hiding the age: losing
                     * information to fix a layout is the wrong trade, and the
                     * age is why this column exists.
                     */
                    isPinned && 'mr-5',
                  )}
                >
                  {relativeAge(project.updatedAt)}
                </span>
              </button>
              <button
                onClick={() => onOpenProjectTerminal(project.id, project.name)}
                aria-label={`Open terminal in ${project.name}`}
                title={`Open terminal in ${project.name}`}
                /*
                 * THE SAME ACTION as the project page's Open terminal, which is
                 * the point: one gesture reachable from the row you are already
                 * looking at, rather than a second way to do a similar thing.
                 *
                 * It used to be "New card here" — and that action moved to the
                 * right-click menu rather than disappearing, because this button
                 * was its only home in the sidebar.
                 *
                 * Sits beside the pin, on hover: an action on this project
                 * rather than part of reading the list.
                 */
                className="absolute right-6 rounded p-1 text-ink-tertiary opacity-0 transition-colors hover:text-ink focus:opacity-100 group-hover:opacity-100"
              >
                {/* A TERMINAL glyph, not a plus: the plus promises "add
                    something", which is exactly what this button stopped
                    doing, and the mark is the same one the sidebar's own Open
                    terminal row uses. */}
                <SquareTerminal size={11} />
              </button>
              <button
                onClick={() => togglePinnedProject(project.id)}
                aria-label={isPinned ? `Unpin project ${project.name}` : `Pin project ${project.name}`}
                title={isPinned ? 'Unpin' : 'Pin to top'}
                // Visible on hover, and always for a pinned one — otherwise
                // there is no way to see that a project IS pinned, nor to
                // reach the control by keyboard.
                className={clsx(
                  'absolute right-1 rounded p-1 text-ink-tertiary transition-colors hover:text-ink focus:opacity-100',
                  isPinned ? 'opacity-100 text-accent-ink' : 'opacity-0 group-hover:opacity-100',
                )}
              >
                {isPinned ? <PinOff size={11} /> : <Pin size={11} />}
              </button>
              </div>

              {childCount > 0 && (
                // grid-template-rows 0fr→1fr animates to the content's own
                // height without measuring it, and needs no max-height guess
                // that would clip a long list or stall a short one. The inner
                // overflow-hidden is what makes the collapsed state actually
                // take no space.
                <div
                  className={clsx(
                    'grid transition-[grid-template-rows] duration-150 ease-out motion-reduce:transition-none',
                    isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                  )}
                >
                <ul
                  id={`work-${project.id}`}
                  /*
                   * `inert`, not `aria-hidden` alone.
                   *
                   * aria-hidden removes the subtree from the accessibility tree
                   * and leaves it in the TAB ORDER, so a keyboard user could
                   * land on a card button or a process row's open control while
                   * collapsed: focus moves, nothing is announced, and there is
                   * no way to tell what happened. The list holds two such
                   * controls per card now.
                   *
                   * inert does both halves - unfocusable and unexposed - which
                   * is what "collapsed" actually means. aria-hidden stays
                   * alongside it for the browsers that do not support inert
                   * yet; where it is supported the two agree, and where it is
                   * not the old behaviour is no worse than before.
                   */
                  inert={!isOpen ? true : undefined}
                  aria-hidden={!isOpen}
                  className="mb-1 ml-2 overflow-hidden border-l border-border-soft pl-2 transition-[grid-template-rows] motion-reduce:transition-none"
                >
                  {/*
                    * Panes herdr is holding in this project's checkout, but in no
                    * card's worktree - which is where nearly all of them are,
                    * because AgEnFK does not launch into herdr yet. They sit
                    * after the cards, marked with herdr's own logo, because they
                    * are work in this project that this product did not start
                    * and cannot act on. A row that looked like ours would invite
                    * a STOP aimed at somebody else's terminal.
                    */}
                  {herdrRows.map(r => (
                    <li key={r.paneId} data-testid={`herdr-project-row-${r.paneId}`}>
                      <button
                        type="button"
                        onClick={() => onOpenPane(openPane === r.paneId ? null : r)}
                        aria-expanded={openPane === r.paneId}
                        className={clsx(
                          'flex w-full items-center gap-2 rounded py-0.5 pl-1 text-left text-[11px] text-ink-tertiary',
                          'hover:bg-nav-surface focus-visible:outline focus-visible:outline-1',
                          openPane === r.paneId && 'bg-nav-surface',
                        )}
                      >
                        {/*
                          * The SAME indicator the rest of the app uses, not a
                          * lookalike. A herdr agent that is running is running
                          * in exactly the sense ours are, and it sat perfectly
                          * still beside an animated row doing the same work -
                          * which reads as "that one is stuck".
                          */}
                        <SessionStateIndicator state={r.state} />
                        <HerdrMark className="h-3 w-3 shrink-0" />
                        <span className="shrink-0 font-mono">{r.agentId}</span>
                        <span
                          className={clsx(
                            'shrink-0',
                            r.needsAPerson && 'text-status-warn-text',
                          )}
                        >
                          {r.state === 'unverifiable' ? 'unknown' : r.state}
                        </span>
                        <span className="min-w-0 flex-1 truncate" title={r.title}>{r.title}</span>
                      </button>
                    </li>
                  ))}
                  {work.map(item => (
                    <li key={item.id}>
                      {/* Clicking opens a terminal on the card, in that card's
                          own worktree — the sidebar lists work in flight, and
                          the thing you want from work in flight is a shell in
                          it. The board is still reachable from its own tab;
                          this row is the shortcut to the actual work. */}
                      {/* THREE parts, on a grid rather than a flex row
                          (CGLAB-164): a fixed column for the dot, a
                          `minmax(0,1fr)` column for the title and branch
                          stacked, and one sized to the step.

                          The middle column is the reason. The row now holds
                          TWO lines that each have to truncate independently
                          inside a shared shrinking box, and `minmax(0,1fr)`
                          is what lets it shrink below its content's intrinsic
                          width so `truncate` can do anything at all. (The old
                          flex row was not the problem it is sometimes written
                          up as: each row was its own flex container and the
                          step was `ml-auto shrink-0`, so its width was already
                          per-row rather than set by the longest status in the
                          list.) */}
                      <button
                        onClick={() => requestTerminal(item)}
                        // The SECONDARY action, on a secondary gesture. The
                        // row is far too narrow for a second button, and the
                        // primary one — open a terminal — is what this list is
                        // for.
                        onContextMenu={e => {
                          e.preventDefault();
                          setCardMenu({ item, x: e.clientX, y: e.clientY });
                        }}
                        title={item.title}
                        className="grid w-full grid-cols-[7px_minmax(0,1fr)] items-start gap-x-1.5 rounded px-1 py-1 text-left text-ink-tertiary transition-colors hover:bg-canvas hover:text-ink"
                      >
                        {/* ONE dot, three states, and none of them the flow
                            step — see cardState.ts. The rail below already
                            carries per-session colour; a tree that repeated it
                            would give the same screen two colour vocabularies
                            for one fact. */}
                        <CardStateDot state={cardState(item.id, liveItems, needsPerson, sessionRows)} />

                        <span className="min-w-0">
                          {/* The TITLE gets the whole row. It used to share it
                              with the step, in a column sized to its content -
                              and a flow is free to name a step
                              CREATE_UNIT_TESTS, which left roughly 90px for a
                              title in a 224px rail and cut real titles down to
                              two words. The step is short and fixed in shape;
                              the title is neither, so the title is the one that
                              should have the space. */}
                          <span
                            data-testid="card-title"
                            className="block truncate text-[13px] leading-[18px] text-ink-secondary"
                          >
                            {item.title}
                          </span>
                          {/* The branch, under the title. Two cards sitting in
                              the same step are told apart by exactly one thing,
                              and it was not on screen at all. Mono because a
                              branch is an identifier: proportional type makes
                              l/1 and rn/m ambiguous in the strings you have to
                              compare by eye. */}
                          {/* Branch and step share the second line. They belong
                              together: both answer "where is this", one in the
                              repository and one in the flow, and neither is
                              worth a row of its own. */}
                          <span className="flex items-baseline gap-1.5">
                          <span
                            data-testid="card-branch"
                            /*
                             * The PLACEHOLDER is hidden from assistive tech;
                             * a real branch name is not. Review caught the
                             * inconsistency: this row suppresses the dot's
                             * "nothing running" label precisely because
                             * repeating it down a thirty-card list is noise,
                             * and then announced "no branch yet" thirty times
                             * for the same reason it should not have. A real
                             * branch is the opposite case — it is the one
                             * thing that tells two cards in the same step
                             * apart, so it stays in the accessible name.
                             */
                            aria-hidden={item.branchName ? undefined : 'true'}
                            className={clsx(
                              'block truncate font-mono text-[11px] leading-[16px] text-ink-tertiary',
                              // Said, not left blank: an empty second line
                              // reads as a rendering fault, and "nobody has
                              // started this" is itself worth knowing.
                              !item.branchName && 'italic opacity-70',
                            )}
                          >
                            {item.branchName || 'no branch yet'}
                          </span>
                          <span
                            data-testid="card-step"
                            className="shrink-0 font-mono text-[10px] uppercase leading-[16px] tracking-wide"
                          >
                            {item.status}
                          </span>
                          {(() => {
                            /*
                             * Fan out this card's children (CGLAB-207).
                             *
                             * Only on cards that HAVE children: a launch
                             * control on a leaf is a button that can only
                             * disappoint, and there are more leaves than
                             * parents in any board.
                             */
                            const hasKids = allItems.some(i => i.parentId === item.id);
                            if (!hasKids) return null;
                            return (
                              <button
                                type="button"
                                data-testid="card-fleet"
                                title="Plan a fan-out of this card's children"
                                aria-label={`Plan a fan-out of ${item.title}`}
                                onClick={e => { e.stopPropagation(); onOpenFleet(item.id); }}
                                className="shrink-0 rounded px-1 font-mono text-[10px] uppercase leading-[16px] tracking-wide text-ink-tertiary opacity-70 hover:text-accent-ink hover:opacity-100"
                              >
                                fleet
                              </button>
                            );
                          })()}
                          </span>
                        </span>


                      </button>

                      {/* The processes running on THIS card, directly beneath
                          it. The row drops the title because the button above
                          is the title, which is the whole saving.

                          Sorted by how much they want a person - failures, then
                          blocked, then working, then quiet - because a failure
                          buried under three busy agents is worse than not shown
                          at all. Same ORDER the rail used, imported rather than
                          repeated.

                          No chevron to collapse these: a card must never be
                          able to hide an agent that is stuck. */}
                      {(() => {
                        const mine = sessionRows
                          .filter(row => row.itemId === item.id)
                          .sort((a, b) => ORDER[a.state] - ORDER[b.state]);
                        if (mine.length === 0) return null;
                        return (
                          /* A BRACKET, not just an indent. The rule says these
                             rows hang off the card above rather than being the
                             next cards in the list - which a bare indent leaves
                             ambiguous once the tree is deep enough to have
                             indentation of its own.

                             The offset is measured, not chosen: 7px is the
                             card's dot column, so the rule starts under the
                             dot and the process marks land under the card's
                             TITLE. That is what makes the card's own mark read
                             as the head of the group rather than as a fourth
                             peer in it. */
                          <div
                            data-testid="process-group"
                            /* The bottom margin is not decoration: without it the last
                               process of one card sits flush against the next
                               card's title and the eye reads it as belonging to
                               the card BELOW, which is the one mistake this
                               layout must not invite. */
                            className="ml-[7px] mb-1.5 flex flex-col border-l border-border-soft pl-2"
                          >
                            {mine.map(row => (
                              <CardProcessRow
                                key={row.runId}
                                row={row}
                                onOpen={openSession}
                              />
                            ))}
                          </div>
                        );
                      })()}
                    </li>
                  ))}
                </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      </div>

      {/* A footer, not a peer. Projects is what you scan all day; this is
          where the agents you have running report in (CGLAB-170). */}
      {/* The card menu, drawn at the pointer.

          Fixed rather than absolute: the projects list scrolls, and a menu
          positioned inside it would slide away from the row it belongs to on
          the first wheel event. */}
      {/*
        PORTALLED to the end of <body> (review, e7ad8020). Electron combines
        drag and no-drag regions in DOCUMENT order, so a no-drag catcher
        rendered here, inside the sidebar, is drawn over again by the main
        column's drag region that comes after it - the terminal's tab strip.
        At the end of the document nothing comes after it.
      */}
      {cardMenu && createPortal(
        <>
          {/* Anything that is not the menu dismisses it, including a second
              right-click elsewhere — a menu you can only close by choosing
              something is a trap. */}
          <div
            // `no-drag`: a drag region beats whatever is stacked over it, so
            // without this a click on the title bar would not close the menu.
            // It works only because the menu is portalled to the end of the
            // document - see above.
            data-app-region="no-drag"
            className="fixed inset-0 z-40"
            onClick={() => setCardMenu(null)}
            onContextMenu={e => { e.preventDefault(); setCardMenu(null); }}
          />
          <div
            role="menu"
            aria-label={`Actions for ${cardMenu.item.title}`}
            style={{ top: cardMenu.y, left: cardMenu.x }}
            className="fixed z-50 min-w-[10rem] overflow-hidden rounded-lg border border-border-soft bg-surface py-1 shadow-2xl"
          >
            <button
              role="menuitem"
              onClick={() => {
                // The SAME route the session rail's BOARD button takes —
                // which focuses the card AND switches to the board. Calling
                // focusItem alone left you on the Terminal tab watching
                // nothing happen: half the action, which reads as a broken
                // menu item.
                revealOnBoard({ itemId: cardMenu.item.id, projectId: cardMenu.item.projectId });
                setCardMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-ink-secondary transition-colors hover:bg-canvas hover:text-ink"
            >
              Show in board
            </button>
          </div>
        </>,
        document.body,
      )}

      {/* Processes whose card is NOT in the tree.
          
          Not the old SESSIONS section returning. That listed everything, which
          duplicated the tree; this holds only what the tree cannot show, and
          renders nothing at all when there is nothing orphaned - which is most
          of the time.
          
          It exists because the tree lists work IN FLIGHT and a terminal
          outlives the card reaching DONE. Without it, a running agent whose
          card has left the list has no route in the sidebar at all: still
          burning tokens, still holding a worktree, and invisible. */}
      {(() => {
        const shown = new Set((activeItems as AgEnFKItem[]).map(i => i.id));
        const orphans = sessionRows
          .filter(row => !shown.has(row.itemId))
          .sort((a, b) => ORDER[a.state] - ORDER[b.state]);
        if (orphans.length === 0) return null;
        return (
          <div
            data-testid="orphan-processes"
            className="flex shrink-0 flex-col border-t border-border-soft px-1 py-1"
          >
            <h2 className="px-1 pb-0.5 text-[10px] font-bold uppercase tracking-wider text-ink-tertiary">
              No card in view
            </h2>
            {orphans.map(row => (
              <CardProcessRow key={row.runId} row={row} onOpen={openSession} />
            ))}
          </div>
        );
      })()}

      {/* The SESSIONS section used to sit here: a flat list of every running
          agent, under a tree that already listed the cards those agents were
          working on. Two places for one fact, and they drifted - which is how
          the rail and the terminal came to disagree earlier in this epic.

          Its contents are not lost. Each process is drawn under the card it
          belongs to, a few lines up, where the card's own mark rolls up the
          states beneath it. What went with the section is the flat globally
          sorted view and the open-terminal count, both recorded on 1a1b8df6 as
          accepted costs rather than oversights. */}

      </div>
      )}

      {/* OUTSIDE the `open` guard, and that is the entire point.
          It was inside it, which meant collapsing the sidebar removed the only
          route to Settings — permanently, because the sidebar state is
          persisted. With both dialog toggles gone, that left no way to change
          tmux or auto-approve at all. The icon-only branch below was written
          for a state the component could never be rendered in: code that looked
          like it handled the case it was breaking.

          Pinned for the original reason too: Projects grows without limit, and
          anything that scrolls with it is unreachable on the day a user has
          thirty cards in flight. */}
      <div
        data-testid="shell-nav"
        className="group relative shrink-0 border-t border-border-soft px-1.5 py-1.5"
      >
        <button
          type="button"
          onClick={openSettings}
          className={clsx(
            'flex items-center gap-2 text-left text-[12px] text-ink-secondary transition-colors hover:bg-canvas hover:text-ink',
            /*
             * The same rule as the nav rows above, for the same reason: the
             * width is CHOSEN per mode rather than `w-10` trying to beat
             * `w-full` - same property, same specificity, so the winner is
             * whichever Tailwind emitted later.
             *
             * This control is outside the nav (see the comment above), which
             * is how the rail's first pass walked straight past it and left a
             * 13px gear among 18px icons.
             */
            open ? 'w-full rounded-md px-2 py-1.5' : 'h-10 w-10 justify-center rounded-lg px-0',
          )}
        >
          <Settings size={open ? 13 : 18} className="shrink-0" />
          {/* The label goes, the button stays. `title` and the accessible name
              below keep it identifiable when only the icon is showing. */}
          {open ? <span className="flex-1">Settings</span> : <span className="sr-only">Settings</span>}
        </button>
        {/* The label is `sr-only` when collapsed, so the button keeps its
            accessible name either way; this is only the pointer hint. */}
        {!open && <span role="tooltip" className={RAIL_TIP}>Settings</span>}
      </div>

      {projectMenu && (
        <div
          data-project-menu
          role="menu"
          aria-label={`${projectMenu.name} actions`}
          /*
           * FIXED, at the pointer. The sidebar is a narrow column with its own
           * scrolling, so a menu positioned inside it would be clipped by the
           * edge it was opened against — the same trap the agent picker's menu
           * hit and fixed with a portal.
           */
          style={{ left: projectMenu.x, top: projectMenu.y }}
          className="fixed z-[70] min-w-[190px] rounded-lg border border-border-soft bg-surface py-1 shadow-2xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => { requestNewItem(projectMenu.id); setProjectMenu(null); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink-secondary transition-colors hover:bg-canvas hover:text-ink"
          >
            <Plus size={12} className="shrink-0 text-ink-tertiary" /> New card here
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { togglePinnedProject(projectMenu.id); setProjectMenu(null); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink-secondary transition-colors hover:bg-canvas hover:text-ink"
          >
            {pinned.includes(projectMenu.id)
              ? <PinOff size={12} className="shrink-0 text-ink-tertiary" />
              : <Pin size={12} className="shrink-0 text-ink-tertiary" />}
            {pinned.includes(projectMenu.id) ? 'Unpin' : 'Pin to top'}
          </button>
        </div>
      )}
    </aside>
  );
}

/**
 * Compact age, the way a file browser shows it: a project touched today reads
 * as hours, an old one as days. Precision past that is noise in a list you
 * scan rather than read.
 */
function relativeAge(when: string | Date | undefined): string {
  if (!when) return '';
  const ms = Date.now() - new Date(when).getTime();
  if (!Number.isFinite(ms)) return '';
  // A future timestamp means clock skew between machines, not a broken date.
  if (ms < 0) return 'now';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'now';
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const SORT_LABELS: Array<{ value: ProjectSort; label: string }> = [
  { value: 'created', label: 'Created at' },
  { value: 'last-used', label: 'Last used' },
];

function SortMenu({
  value,
  onChange,
  agentOptions,
  selectedAgents,
  onToggleAgent,
  onClearAgents,
}: {
  value: ProjectSort;
  onChange: (v: ProjectSort) => void;
  readonly agentOptions: readonly AgentFilterOption[];
  readonly selectedAgents: readonly string[];
  onToggleAgent: (agentId: string) => void;
  onClearAgents: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  /*
   * Hidden below two options, because there is nothing to narrow TO: with one
   * kind of agent running, filtering to it leaves the list exactly as it was.
   * An offered control that cannot change anything teaches people the menu is
   * not worth opening.
   */
  const canFilter = agentOptions.length > 1;
  const filtering = selectedAgents.length > 0;

  // Escape closes it, and so does clicking anywhere else — a menu that can
  // only be dismissed by choosing something forces a choice you may not want.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (): void => setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div className="relative" onMouseDown={e => e.stopPropagation()}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={filtering ? `Sort and filter projects, ${selectedAgents.length} filter on` : 'Sort and filter projects'}
        aria-haspopup="menu"
        aria-expanded={open}
        title={filtering ? 'Filtered by agent' : 'Sort and filter projects'}
        /*
         * The active state is not decoration. A filter narrows the list and
         * then closes, so without a mark on the button the next person to look
         * sees a short project list and no cause - which reads as the app
         * having lost them.
         */
        data-filtering={filtering || undefined}
        className={clsx(
          'flex items-center rounded p-1 transition-colors hover:bg-canvas',
          filtering ? 'text-accent-ink' : 'text-ink-tertiary hover:text-ink-secondary',
        )}
      >
        <ListFilter size={13} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Sort projects"
          className="absolute right-0 top-full z-20 mt-1 w-36 rounded-md border border-border-soft bg-surface py-1 shadow-lg"
        >
          <p className="px-2.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-ink-tertiary">
            Sort by
          </p>
          {SORT_LABELS.map(option => (
            <button
              key={option.value}
              role="menuitemradio"
              aria-checked={value === option.value}
              onClick={() => { onChange(option.value); setOpen(false); }}
              className={clsx(
                'flex w-full items-center justify-between px-2.5 py-1 text-left text-xs transition-colors',
                value === option.value ? 'text-ink' : 'text-ink-secondary hover:text-ink',
              )}
            >
              {option.label}
              {value === option.value && <Check size={12} className="text-accent-ink" />}
            </button>
          ))}

          {canFilter && (
            <>
              <div className="my-1 border-t border-border-soft" />
              <p className="px-2.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-ink-tertiary">
                Agent
              </p>
              {/*
                * "All" first and always present. Unticking the last box lands
                * on "no selection", which MEANS everything - but a person who
                * turned three on does not want to turn three off one at a
                * time to get back, and without a way back a filter is a trap.
                */}
              <button
                role="menuitemradio"
                aria-checked={!filtering}
                onClick={() => onClearAgents()}
                className={clsx(
                  'flex w-full items-center justify-between px-2.5 py-1 text-left text-xs transition-colors',
                  !filtering ? 'text-ink' : 'text-ink-secondary hover:text-ink',
                )}
              >
                All
                {!filtering && <Check size={12} className="text-accent-ink" />}
              </button>
              {agentOptions.map(option => {
                const on = selectedAgents.includes(option.agentId);
                return (
                  <button
                    key={option.agentId}
                    role="menuitemcheckbox"
                    aria-checked={on}
                    data-testid={`agent-filter-${option.agentId}`}
                    /*
                     * The menu STAYS OPEN. This is a multi-select, and closing
                     * on each tick would make picking two agents a two-trip
                     * job - which is most of why anybody opens it.
                     */
                    onClick={() => onToggleAgent(option.agentId)}
                    className={clsx(
                      'flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs transition-colors',
                      on ? 'text-ink' : 'text-ink-secondary hover:text-ink',
                    )}
                  >
                    <AgentIcon agentId={option.agentId} size={12} />
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {/* The count answers the question without opening it twice. */}
                    <span className="shrink-0 font-mono text-[10px] text-ink-tertiary">{option.count}</span>
                    {on && <Check size={12} className="shrink-0 text-accent-ink" />}
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A WORK view that exists in the sidebar before it exists as a feature
 * (CGLAB-164).
 *
 * This is scaffolding with an owner: the run feed that takes over from the
 * empty Runs panel. It is here so the nav row lands somewhere that says what it
 * will be, rather than on a blank pane that reads as a broken app.
 *
 * A REGION, not a tabpanel, for the same reason Settings is one: nothing
 * carries `aria-controls` for it — it is reached from the sidebar, not from the
 * tablist — and a tabpanel with no owning tab reports a tablist with nothing
 * selected.
 *
 * Hidden rather than conditionally mounted, like every other panel in this
 * file. It holds nothing today, but the rule belongs to the panel set and not
 * to each panel: the moment one grows a filter or a tailing log, a conditional
 * mount starts throwing it away silently.
 *
 * Still a helper rather than inlined at its one call site, because the rules
 * above are the panel set's and a second placeholder should inherit them rather
 * than be written again.
 */
/*
 * DELETED: `WorkPlaceholder`.
 *
 * A stated empty state for a sidebar row whose screen did not exist yet, so
 * that a nav row never landed on nothing. It had two users: Inbox, retired
 * when Flows took its place, and Agents, removed entirely with the run-feed
 * screen it stood in for (396c8350). With no row left waiting on a screen there is nothing for
 * it to hold, and a helper with no caller is a shape for the next placeholder
 * to be poured into rather than questioned.
 */

function SidebarLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="px-2 pt-2 text-[10px] font-bold uppercase tracking-wider text-ink-tertiary">
      {children}
    </h2>
  );
}

