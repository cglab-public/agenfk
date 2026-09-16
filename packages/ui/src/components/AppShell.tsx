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
import { clsx } from 'clsx';
import { agentLabel } from '../agentLabels';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Book, Check, ChevronDown, ChevronRight, Folder, FolderOpen, GitBranch, LayoutGrid, ListFilter, PanelLeftClose, PanelLeftOpen, Pin, PinOff, Plus, Settings, type LucideIcon } from 'lucide-react';
import { useSocketEvent, useSocket } from '../SocketContext';
import { AgenfkWordmark } from './AgenfkWordmark';
import { desktopInfo } from '../desktop';
import { claimStateOf, claimChipLabel, claimChipTitle } from '../claimState';
import { useActiveProject } from '../ActiveProject';
import {
  readPinned, togglePinned, sortProjectsByPin,
  readExpanded, toggleExpanded, writeExpanded,
  readProjectSort, writeProjectSort, orderProjects, type ProjectSort,
} from '../sidebarPrefs';
import { NewProjectButton } from './NewProjectButton';
import { api } from '../api';
import type { AgEnFKItem, Project } from '../types';
import { TerminalTab, type TerminalSession } from './TerminalTab';
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
import type { SessionRow, SessionState } from '../sessionRow';
import { LiveAgents } from '../liveAgents';
import { EmptyState } from './EmptyState';
import { ReadmeModal } from './ReadmeModal';
import { FlowEditorModal } from './FlowEditorModal';
import { WhatsNewModal } from './WhatsNewModal';
import { liveSessions } from '../liveSessions';
import { CardPicker } from './CardPicker';
import { CardStateDot } from './CardStateDot';
import { CardProcessRow } from './CardProcessRow';
import { RunsPanel } from './RunsPanel';
import { ORDER } from './sessionPresentation';
import { cardState, itemsNeedingAPerson } from '../cardState';

/**
 * A view the main column can show.
 *
 * Called an id rather than a TAB id because there is no tab bar any more. The
 * Kanban button went first, Terminal followed it, and with Runs docked below
 * the board there was nothing left to put in a strip - so the strip went too.
 * Every view here is reached from the sidebar or from a session, and each one
 * is a panel that stays mounted and is hidden rather than unmounted.
 */
type ViewId = 'kanban' | 'terminal' | 'settings' | 'agents';

/**
 * The WORK group at the top of the sidebar (CGLAB-164).
 *
 * Navigation belongs beside the thing being navigated, not in a strip floating
 * over the content — so picking a view moved here. `Tasks` is the board, which
 * is the view that is always there; `Agents` is the run feed, and is no longer
 * a placeholder for it. It used to say the feed "is not here yet" beside a
 * Runs TAB that showed the feed, which was the same destination described two
 * ways. The tab is gone and Agents is what it was standing in for.
 *
 * Agents is therefore also THE way to open Runs. With no tab to click it is
 * the only one, which is why it is an ordinary always-visible sidebar row
 * rather than a control on the feed itself: a button that appears only once
 * the thing it opens is already open is not a way in.
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
  | { kind: 'action'; id: 'flows'; label: string; Icon: LucideIcon };

const WORK_ROWS: WorkRow[] = [
  { kind: 'view', id: 'kanban', label: 'Tasks', Icon: LayoutGrid },
  // GitBranch, the same icon the board's Manage Flow button uses: one concept,
  // two routes to it, and a second glyph would read as a second feature.
  { kind: 'action', id: 'flows', label: 'Flows', Icon: GitBranch },
  { kind: 'view', id: 'agents', label: 'Agents', Icon: Activity },
];

type Connection = 'connecting' | 'connected' | 'offline';

const SIDEBAR_KEY = 'agenfk_shell_sidebar';
const RUNS_DOCK_KEY = 'agenfk_runs_dock';

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

/**
 * Where the run feed sits.
 *
 * A CLOSED set, and that is the design rather than a limitation. Free layout
 * becomes window management: state that is hard to persist and easy to leave
 * unusable, for flexibility nobody asked for. Two positions give nearly all of
 * the perceived freedom at a fraction of that cost.
 *
 * `bottom` exists because live logs are something you follow WHILE looking at
 * the board, and a full screen makes that a choice between them.
 *
 * `screen` was called `tab` until the tab strip was removed. Only the name
 * changed: it always meant "the whole of the main column", and the column is
 * now reached from the sidebar's Agents row instead of from a tab.
 */
type RunsDock = 'screen' | 'bottom';
const RUNS_DOCKS: RunsDock[] = ['screen', 'bottom'];

function readRunsDock(): RunsDock {
  try {
    const stored = JSON.parse(localStorage.getItem(RUNS_DOCK_KEY) ?? 'null');
    // An unrecognised zone — another version, or a hand-edited value — must
    // not put the view nowhere. `"tab"` is the one that matters in practice:
    // every build with a tab strip wrote it, so it is in the storage of
    // everyone upgrading, and it needs no case of its own because it is not a
    // zone this build has and `screen` is where it meant to point anyway.
    return RUNS_DOCKS.includes(stored) ? stored : 'screen';
  } catch { return 'screen'; }
}

/*
 * WHAT THE TAB STRIP TOOK WITH IT.
 *
 * Kanban left the bar for the sidebar's Tasks, Terminal followed it, and Runs
 * - the last tab - became the Agents screen. A bar with nothing in it orders
 * nothing, so everything built to order it is gone: the `agenfk_shell_tabs`
 * order and the reader that repaired it across versions, `moveTab` and its
 * module, the drag reorder, the move-left button, the live region that
 * announced a tab's new position, and the `visibleOrder` filter that kept the
 * announcement's count honest while Runs was docked away.
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
  const [runsDock, setRunsDock] = React.useState<RunsDock>(() => readRunsDock());
  const moveRunsTo = React.useCallback((dock: RunsDock, navigate = false) => {
    setRunsDock(dock);
    try { localStorage.setItem(RUNS_DOCK_KEY, JSON.stringify(dock)); } catch { /* a lost preference */ }
    // Sending the feed to the strip while its own screen is the one showing
    // would leave the main area empty; the board is the only view that is
    // always there. Bringing it back the other way has to navigate TO it, or
    // the control reports success while the user still sees the board.
    setActive(cur => {
      if (dock === 'bottom') return cur === 'agents' ? 'kanban' : cur;
      /*
       * Only when the CALLER asks. Navigating on every undock was one
       * behaviour shared between two opposite promises: the dock strip's arrow
       * says "put Runs back on its own screen" and must go there, while the
       * terminal bar's toggle says "hide the run feed" and must leave you
       * exactly where you are. Pressing hide used to land you on the
       * full-height feed with the terminal gone.
       */
      return navigate ? 'agents' : cur;
    });
  }, []);
  // Same latch idea as the terminal, for a much smaller reason: no request goes
  // out for a screen the user has never opened.
  const [settingsOpened, setSettingsOpened] = React.useState(false);
  const { activeProjectId, focusedItemId, newItemRequest, setActiveProjectId, markProjectWorked, focusItem, terminalRequest } = useActiveProject();
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
  /** The card a terminal is being opened FOR, while the dialog is up. */
  const [pending, setPending] = React.useState<
    { itemId: string; title: string; agentId?: string; branchName?: string | null } | null
  >(null);
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
   * Whose runs the feed shows.
   *
   * The terminal you are watching first, and the card you last navigated to
   * otherwise. Following the terminal ALONE was the first attempt and it was
   * wrong in the way that matters: a run recorded by the Claude Code hook has
   * no terminal of ours at all, and those are precisely the runs this feed
   * exists for - the sub-agent dispatches nothing else on screen shows. The
   * feed would have stayed empty for its own main use.
   *
   * Null only when neither is set, which is the one state in which "no agent
   * runs open" is a true thing to say rather than a placeholder.
   */
  const runsItemId = React.useMemo(() => {
    const watched = sessions.find(s => s.id === activeSession)?.itemId;
    if (watched) return watched;
    /*
     * `focusedItemId` is NONCED - `<id>#<n>` - so that clicking the same row
     * twice still counts as a new navigation. Consumers that need the id take
     * the part before the `#`; the board is the other one, and it keys its
     * one-shot guard on the WHOLE string for exactly the opposite reason.
     */
    return focusedItemId ? focusedItemId.split('#')[0] : null;
  }, [sessions, activeSession, focusedItemId]);
  /** The second terminal on screen, or null. See TerminalTab for the fit rules. */
  const [splitSession, setSplitSession] = React.useState<string | null>(null);

  const sessionSeq = React.useRef(0);

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
    setPending({
      itemId: item.id,
      title: item.title,
      agentId: item.agentId,
      branchName: (item as { branchName?: string | null }).branchName ?? null,
    });
  }, [setActiveProjectId, sessions]);

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
        // A run that ENDED badly stays failed however long ago it was: a
        // failure that ages into 'idle' is a failure nobody sees. Recency only
        // decides between running and idle.
        state: run.status === 'failed'
          ? 'failed'
          : live.isLive(run.itemId) ? 'running' : 'idle',
        startedAt: run.startedAt,
        // A run from the hook has a transcript but no terminal this app owns,
        // so clicking must not pretend to attach to one.
        hasTerminal: false,
        // Carried raw, for liveSessions to decide with. `state` above has
        // already collapsed it into running/idle and cannot answer "did this
        // end?" — which is the question the rail's membership turns on.
        runStatus: run.status,
      });
    }

    for (const open of sessions) {
      byAgent.set(key(open.itemId, open.agentId), {
        runId: open.id,
        itemId: open.itemId,
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
    return liveSessions([...byAgent.values()], {
      isLive: id => liveItems.has(id),
      appStartedAt: APP_STARTED_AT,
    });
  }, [runs, sessions, live, liveItems, liveTick]);
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
    const open = sessions.find(s => s.itemId === row.itemId && s.agentId === row.agentId);
    if (open) {
      setActiveSession(open.id);
      setTerminalOpened(true);
      setActive('terminal');
      return;
    }
    // No terminal of ours for this card — a run recorded by the hook, or one
    // from a previous launch. Offer to open one ON THAT CARD rather than
    // silently doing nothing; the dialog names the card so it is clear this
    // starts a session rather than resuming the one that is running.
    setPending({ itemId: row.itemId, title: row.title, agentId: row.agentId });
  }, [sessions]);

  /**
   * Take the board to a card.
   *
   * The rail's row opens a terminal — asked for explicitly — which left
   * `focusItem` without a production caller and made the board's
   * scroll-to-and-highlight unreachable. This gives it one back without taking
   * the row's click away from the terminal.
   */
  const revealOnBoard = React.useCallback((row: { itemId: string; projectId?: string }): void => {
    focusItem(row.itemId, row.projectId);
    setActive('kanban');
  }, [focusItem]);

  const stopSession = React.useCallback((runId: string): void => {
    // By session id ONLY. The `|| s.itemId === runId` fallback could stop a
    // terminal whose itemId happened to equal another row's runId, and it did
    // nothing at all for a hook-recorded run — whose runId is an AgentRun uuid
    // that matches no session. Rows we cannot stop no longer offer STOP; see
    // the process row.
    const open = sessions.find(s => s.id === runId);
    if (open) closeSessionRef.current(open.id);
  }, [sessions]);

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

  const closeSessionRef = React.useRef<(id: string) => void>(() => {});
  const closeSession = React.useCallback((id: string): void => {
    // Read from the ref and act BEFORE the updater, for the same reason as
    // rememberSession: an updater must be pure, and React invokes it twice in
    // development.
    //
    // Closing a tab is the user saying they are done with it. Putting it back
    // on the next launch would be the app arguing with them.
    const closing = sessionsRef.current.find(s => s.id === id);
    if (closing?.recordId) void api.forgetTerminalSession(closing.recordId).catch(() => {});
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

  // stopSession is declared above closeSession and needs to reach it; a ref
  // avoids reordering two callbacks that each read state the other does not.
  closeSessionRef.current = closeSession;

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
    enabled: flowsOpen && !!activeProjectId,
    staleTime: 30_000,
  });

  const info = desktopInfo();
  const isMac = info?.platform === 'darwin';
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
    if (!focusedItemId && !newItemRequest) return;
    setActive('kanban');
  }, [focusedItemId, newItemRequest]);

  // One place, so the latch cannot be missed by a new route into the view -
  // the sessions rail, the sidebar's card list and the board all reach it.
  React.useEffect(() => {
    if (active === 'terminal') setTerminalOpened(true);
  }, [active]);

  // The sidebar normally clears the window buttons on its own; collapsed, it
  // is narrower than they are, so the main column has to make room instead.
  const reservesWindowControls = isMac && !sidebarOpen;

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
      {/* No full-width title bar. The sidebar runs the whole height and owns
          the traffic-light strip, so the window reads as two columns rather
          than a banner stacked on a split — and the board gets that row back. */}
      <div className="flex min-h-0 flex-1">
        <Sidebar
          open={sidebarOpen}
          onToggle={toggleSidebar}
          isMac={isMac}
          requestTerminal={requestTerminal}
          sessionRows={sessionRows}
          liveItems={liveItems}
          openSession={openSession}
          openSettings={() => { setSettingsOpened(true); setActive('settings'); }}
          revealOnBoard={revealOnBoard}
          activeView={active}
          onSelectView={setActive}
          onOpenFlows={() => setFlowsOpen(true)}
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
            sidebar rail is ~40px against the ~78px the lights occupy from the
            window edge, so this column's top-left corner is underneath them -
            and anything put in this row without the reserve would render under
            the window buttons: unclickable, with the OS window menu opening on
            top of it. Nothing sits here today, which is exactly why the
            reserve is written down rather than discovered again by whatever is
            put here next.
          */}
          {/* Only while the sidebar is COLLAPSED, which is the only time this row
              earns its 36px. Open, the sidebar is wider than the traffic lights
              and already carries its own drag region with the wordmark in it -
              so this row would be reserving space for buttons that are not over
              it and offering a second handle for a window that already has one.
              Collapsed, the rail is ~40px against the lights' ~78px, and
              without this the first control renders underneath them.

              The 36px goes to the terminal, which is the whole reason the git
              panel moved into a button as well. */}
          {reservesWindowControls && (
            <div
              data-app-region="drag"
              data-reserves-window-controls="true"
              className={clsx(
                'flex h-9 shrink-0 items-center border-b border-border-soft bg-nav-surface',
                'pl-12',
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
            className="min-h-0 flex-1"
          >
            {terminalOpened && (
              <TerminalTab
                sessions={sessions}
                sessionStates={sessionStates}
                /*
                 * The second pane is ASKED FOR, never automatic (CGLAB-192).
                 * Three agents running does not mean two panes open: only a
                 * person knows which pair belongs side by side, and guessing
                 * is wrong most of the time and costs a pane to undo.
                 */
                splitId={splitSession}
                onToggleSplit={id => setSplitSession(cur => (cur === id ? null : id))}
                sidebarWidthPx={sidebarOpen ? 224 : 40}
                activeId={activeSession}
                onSelect={setActiveSession}
                onClose={closeSession}
                editors={editors}
                showWorktree
                /* The feed is the terminal's sibling in this column, so the
                   shell is the only thing that can say whether it is showing
                   or move it. */
                runsOpen={runsDock === 'bottom'}
                onToggleRuns={() => moveRunsTo(runsDock === 'bottom' ? 'screen' : 'bottom')}
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
            )}
          </div>

          {/*
            THE AGENTS SCREEN IS THE RUN FEED.

            It used to be a placeholder that said the feed "is not here yet",
            sitting beside a Runs TAB that showed the feed - the same
            destination described two ways, 200px apart, which reads as a
            rendering fault rather than as two features. The tab is gone and
            this is what it was standing in for.

            A REGION, not a tabpanel: no tab controls it any more. The sidebar
            row that opens it is an ordinary button, and a tabpanel with no
            owning tab reports a tablist with nothing selected.
          */}
          <div
            role="region"
            id="panel-agents"
            aria-label="Agents"
            tabIndex={0}
            hidden={active !== 'agents'}
            className="flex min-h-0 flex-1 flex-col"
          >
            <header className="flex shrink-0 items-center gap-2 border-b border-border-soft px-4 py-2">
              <h2 className="font-mono text-[10px] font-bold uppercase tracking-wide text-ink-tertiary">
                Runs
              </h2>
              {/* A BUTTON, not a drag target: a drag-only affordance is
                  unreachable without a pointer. It lived in the tab strip
                  until the strip was removed, and belongs on the thing it
                  moves anyway - which also makes it symmetric with the control
                  on the docked strip that sends the feed back here. */}
              {runsDock === 'screen' && (
                <button
                  onClick={() => moveRunsTo('bottom')}
                  aria-label="Dock Runs below the board"
                  title="Dock Runs below the board"
                  className="ml-auto rounded px-2 py-1 font-mono text-[10px] text-ink-tertiary transition-colors hover:text-ink"
                >
                  Runs ↓
                </button>
              )}
            </header>
            <div className="min-h-0 flex-1 overflow-auto scrollbar-slim p-6">
              {runsDock === 'screen' ? (
                /* The real feed, following the session you are watching.

                   Both of these were a hand-written EmptyState saying "No
                   agent runs open" whatever was running - missing wiring
                   wearing an empty case's clothes, which is the worst kind,
                   because the app looks finished while telling you nothing.

                   Following the ACTIVE SESSION rather than, say, the focused
                   card: a feed pinned to something else is the same defect
                   again, quieter - a panel confidently showing the wrong
                   thing. With no session there is genuinely nothing to show,
                   and that is the one time this empty state is true. */
                runsItemId ? (
                  <RunsPanel itemId={runsItemId} />
                ) : (
                  <EmptyState
                    title="No agent runs open"
                    body="Open a terminal on a card to follow its agent here."
                  />
                )
              ) : (
                /* Says where the feed went rather than showing an empty
                   screen. Landing on nothing after clicking Agents reads as a
                   broken app, and the way back has to be visible from the
                   state the user is in - which is this one, because the strip
                   they docked it to is behind the board they are not on. */
                <EmptyState
                  title="Runs is docked below the board"
                  body="It is the strip under the board, so a live log can be watched while the board is being read."
                />
              )}
            </div>
          </div>

          {/* Below the board, in the same column, so both are visible at once —
              which is the whole reason the previous card called a full screen
              the wrong place for a live log. */}
          {runsDock === 'bottom' && (
            <section
              data-testid="runs-dock"
              aria-label="Runs"
              className="flex h-48 shrink-0 flex-col border-t border-border-soft bg-nav-surface"
            >
              <header className="flex items-center gap-2 border-b border-border-soft px-3 py-1.5">
                <h2 className="font-mono text-[10px] font-bold uppercase tracking-wide text-ink-tertiary">
                  Runs
                </h2>
                <button
                  onClick={() => moveRunsTo('screen', true)}
                  aria-label="Put Runs back to its own screen"
                  title="Put Runs back to its own screen"
                  className="ml-auto rounded px-1.5 font-mono text-[10px] text-ink-tertiary transition-colors hover:text-ink"
                >
                  ↑
                </button>
              </header>
              <div className="min-h-0 flex-1 overflow-auto scrollbar-slim p-4">
                {runsItemId ? (
                  <RunsPanel itemId={runsItemId} />
                ) : (
                  <EmptyState
                    title="No agent runs open"
                    body="Open a terminal on a card to follow its agent here."
                  />
                )}
              </div>
            </section>
          )}
        </main>
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-border-soft bg-nav-surface px-3 text-[11px] text-ink-tertiary">
        <span className="flex items-center gap-1.5">
          <span
            className={clsx(
              'inline-block h-1.5 w-1.5 rounded-full',
              connection === 'connected' ? 'bg-brand' : 'bg-ink-tertiary',
            )}
          />
          <span data-testid="connection-state">{CONNECTION_LABEL[connection]}</span>
        </span>
        <span className="font-mono">{window.location.host}</span>

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

      {pickingCard && (
        <CardPicker
          items={activeWork}
          projectNames={projectNames}
          currentItemId={sessions.find(s => s.id === activeSession)?.itemId}
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
            setPending({
              itemId: item.id,
              title: item.title,
              agentId: item.agentId,
              branchName: (item as { branchName?: string | null }).branchName ?? null,
            });
          }}
        />
      )}

      {pending && (
        <NewTerminalDialog
          cardTitle={pending.title}
          defaultAgentId={pending.agentId}
          listAgents={listAgentsFromBridge}
          onClose={() => setPending(null)}
          onCreate={async ({ agentId }) => {
            // Both read from Settings rather than asked here. They are
            // preferences, answered the same way every time, and a dialog in
            // the path of a frequent action should only ask what actually
            // varies — which agent.
            const autoApprove = desktopPrefs?.autoApprove === true;
            const persist = appSettings?.tmuxByDefault === true;
            // Latch and switch BEFORE clearing `pending`, so the panel exists
            // by the time the dialog goes away — otherwise the user watches an
            // empty tab for a frame while the pane mounts.
            // Open FIRST. Recording which agent a card uses is a nicety;
            // letting it fail — or even throw synchronously, as it did when the
            // api mock lacked the method — must never stop the terminal from
            // opening. Ordering is the guarantee here, not the try/catch.
            sessionSeq.current += 1;
            const id = `${pending.itemId}#${sessionSeq.current}`;
            setSessions(prev => [...prev, {
              id,
              itemId: pending.itemId,
              title: pending.title,
              agentId,
              autoApprove,
              persist,
              openedAt: new Date().toISOString(),
              branchName: pending.branchName,
            }]);
            setActiveSession(id);
            setTerminalOpened(true);
            setActive('terminal');
            setPending(null);

            // Remember the choice ON THE CARD, where it belongs: the server
            // keeps it in the item's own record, so it follows the card across
            // machines and clients instead of living in one browser's storage.
            // No try/catch and no cast. updateItem is async, so it cannot throw
            // synchronously — the catch only ever swallowed a TypeError from a
            // mock missing the method, which is exactly how this seam stayed
            // unverified for a round. And `as never` was suppressing the one
            // compile-time check that would catch a field rename.
            if (agentId !== pending.agentId) {
              void api.updateItem(pending.itemId, { agentId }).catch(() => {});
            }
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
  open: boolean;
  onToggle: () => void;
  isMac: boolean;
  sessionRows: SessionRow[];
  /** Cards an agent has touched inside the live window. */
  liveItems: ReadonlySet<string>;
  openSession: (row: SessionRow) => void;
  /** Clicking a card asks the shell to open a terminal on it. */
  requestTerminal: (item: AgEnFKItem) => void;
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
}

function Sidebar({ open, onToggle, isMac, requestTerminal, sessionRows, liveItems, openSession, openSettings, revealOnBoard, activeView, onSelectView, onOpenFlows }: SidebarProps) {
  /*
   * EVERY item, only for the claim chips (CGLAB-190).
   *
   * Not the in-flight list the rows are drawn from: a PAUSED card still owns
   * the files it claimed - that is the whole point of RELEASED_STATUSES
   * differing from the gatekeeper's INACTIVE set - and computing holders from
   * the active list would quietly report a held card as free. A UI that fails
   * open about a collision is the same defect as a gate that does, wearing a
   * chip.
   */
  const { data: allItemsForClaims = [] } = useQuery<AgEnFKItem[]>({
    queryKey: ['items-claims'],
    queryFn: () => api.listItems(),
    /*
     * Measured after review: `GET /items` returns FULL records - description,
     * comments, history - and on this machine that is 582 items and 8.1 MB,
     * for a field 0 of them carry. With the default staleTime of 0 and
     * refetch-on-focus, every alt-tab back into the window re-fetched and
     * re-parsed all of it, in a renderer that is also driving xterm.
     *
     * Freshness comes from the socket instead, which is also strictly BETTER
     * than focus: the chip appeared only after an alt-tab before, i.e. it was
     * stale at exactly the moment a claim was declared.
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
  const [pinned, setPinned] = React.useState<string[]>(() => readPinned());
  const [expanded, setExpanded] = React.useState<string[]>(() => readExpanded());
  const [sort, setSort] = React.useState<ProjectSort>(() => readProjectSort());

  // One request for every project's in-flight work. The server answers this
  // per project against that project's own flow, so there is no second copy
  // of "what counts as active" living in the UI.
  const { data: activeItems = [] } = useQuery({
    queryKey: ['active-items'],
    queryFn: api.listActiveItems,
  });
  useSocketEvent('items_updated', () => {
    queryClient.invalidateQueries({ queryKey: ['active-items'] });
    // The claim chips too: declaring a claim IS an item update, and without
    // this the chip waited for a window focus - stale at exactly the moment
    // the feature is for.
    queryClient.invalidateQueries({ queryKey: ['items-claims'] });
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
        'flex shrink-0 flex-col border-r border-border-soft bg-nav-surface',
        // 160ms: long enough for the eye to follow the edge, short enough not
        // to feel slow on something toggled dozens of times a day. Width, not
        // transform — the sidebar has to make ROOM, and a transform would
        // slide it over the board instead of pushing it.
        'transition-[width] duration-150 ease-out motion-reduce:transition-none',
        open ? 'w-56' : 'w-10 items-center',
      )}
    >
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
      <div
        data-app-region={isMac ? 'drag' : undefined}
        className={clsx('flex h-9 shrink-0 items-center', isMac ? 'pl-[76px]' : 'pl-3')}
      >
        {open && <AgenfkWordmark size={13} />}
      </div>

      {/* The toggle's OWN row, and the only thing in it.
          It used to share this row with the Projects label and its two
          actions, which is no longer where Projects starts — WORK sits above
          it now, so the label moved down to the tree it names.

          The property that must survive is the toggle keeping keyboard focus
          across a collapse, which the test at "keeps keyboard focus on the
          toggle across a collapse" pins: the button has to stay at the same
          position under the same parent in both modes, or React destroys and
          recreates it and focus falls to <body>. It did before this change
          (a falsy `{open && …}` child still holds its slot) and it does now,
          for the simpler reason that this row has exactly one child. */}
      <div
        className={clsx(
          'flex shrink-0 items-center',
          open ? 'justify-end px-2 pr-1' : 'justify-center pt-2',
        )}
      >
        <button
          onClick={onToggle}
          aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
          title={open ? 'Collapse sidebar' : 'Expand sidebar'}
          className="flex items-center rounded p-1 text-ink-tertiary transition-colors hover:bg-canvas hover:text-ink-secondary"
        >
          {open ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
        </button>
      </div>

      {!open ? null : (
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">

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
      <nav aria-label="Work" className="shrink-0 pt-2">
        <ul className="flex flex-col gap-px">
          {WORK_ROWS.map(row => {
            const { label, Icon } = row;
            const current = row.kind === 'view' && activeView === row.id;
            // An action with nothing to act on. The flow belongs to a project,
            // so with none open there is no editor to show - say that on the
            // control rather than opening an empty one.
            const disabled = row.kind === 'action' && !activeProjectId;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (disabled) return;
                    if (row.kind === 'view') onSelectView(row.id); else onOpenFlows();
                  }}
                  // `aria-disabled`, not `disabled`. A disabled button is not
                  // focusable, so it can be neither tabbed to nor announced —
                  // and the title below, which is the whole point of the state,
                  // is a hover-only tooltip a keyboard user never sees. This
                  // keeps the row in the tab order and lets the reason be read
                  // out, at the cost of having to refuse the click ourselves.
                  aria-disabled={disabled || undefined}
                  title={disabled ? 'Open a project to edit its flow' : undefined}
                  // `page`, not `true`: views are destinations, and a screen
                  // reader should say "current page" rather than the generic
                  // "current". Absent — not `false` — on the others, so exactly
                  // one row in the group ever carries it, and an action row
                  // never does.
                  aria-current={current ? 'page' : undefined}
                  className={clsx(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                    current
                      ? 'bg-canvas font-semibold text-ink'
                      : 'text-ink-secondary hover:bg-canvas/60 hover:text-ink',
                    disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-ink-secondary',
                  )}
                >
                  {/* Decorative: the label beside it is the accessible name, and
                      a second one here would make it say everything twice. */}
                  <Icon size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div data-testid="projects-section" className="mt-3 flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center pr-1">
        <SidebarLabel>Projects</SidebarLabel>
        <div className="ml-auto flex items-center">
          <SortMenu value={sort} onChange={next => setSort(writeProjectSort(next))} />
          <NewProjectButton onCreated={id => setActiveProjectId(id)} />
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
        const stuck = sessionRows.filter(r => r.state === 'failed' || r.state === 'blocked');
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
                className="rounded text-emerald-400 underline decoration-dotted underline-offset-2 transition-colors hover:text-emerald-300"
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
                className="rounded text-amber-400 underline decoration-dotted underline-offset-2 transition-colors hover:text-amber-300"
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
        {ordered.map((project: Project) => {
          const isActive = project.id === activeProjectId;
          const isPinned = pinned.includes(project.id);
          const work = inFlightByProject.get(project.id) ?? [];
          const isOpen = expanded.includes(project.id);
          return (
            <li key={project.id}>
              <div className="group relative flex items-center">
              {work.length > 0 ? (
                <button
                  onClick={() => setExpanded(toggleExpanded(project.id))}
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
                onClick={() => setActiveProjectId(project.id)}
                aria-current={isActive ? 'true' : undefined}
                // Explicit, so the accessible name is the project and not
                // "horizon-lab 3d" — the age is decoration, not identity.
                aria-label={project.name}
                title={project.name}
                className={clsx(
                  'flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                  isActive
                    ? 'bg-canvas font-semibold text-ink'
                    : 'text-ink-secondary hover:bg-canvas/60 hover:text-ink',
                )}
              >
                {/* Decorative: the row already has an accessible name, and a
                    second label here would make screen readers say it twice. */}
                <span data-folder-icon aria-hidden="true" className="shrink-0 text-ink-tertiary">
                  {isOpen && work.length > 0
                    ? <FolderOpen size={13} />
                    : <Folder size={13} className={work.length === 0 ? 'opacity-50' : undefined} />}
                </span>
                {/* flex-1, or `justify-between` above shares the free space between all
                    four children and the name floats in the middle of the row -
                    which reads as a centred column and makes a list of projects
                    hard to scan down. Taking the space itself keeps the name
                    against its folder icon and pushes the count and age right. */}
                <span data-testid="project-name" className="min-w-0 flex-1 truncate text-left">{project.name}</span>
                {work.length > 0 && (
                  // Visible without expanding: the whole point of a folder is
                  // to say how much is inside before you open it.
                  <span
                    data-testid="in-flight-count"
                    title={`${work.length} in flight`}
                    className="shrink-0 rounded-full bg-canvas px-1.5 font-mono text-[9px] text-ink-tertiary"
                  >
                    {work.length}
                  </span>
                )}
                <span
                  data-testid="project-age"
                  className={clsx(
                    'shrink-0 font-mono text-[10px] text-ink-tertiary group-hover:invisible',
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
                onClick={() => requestNewItem(project.id)}
                aria-label={`New card in ${project.name}`}
                title="New card here"
                // Sits beside the pin, on hover, because it is an action on
                // this project rather than part of reading the list.
                className="absolute right-6 rounded p-1 text-ink-tertiary opacity-0 transition-colors hover:text-ink focus:opacity-100 group-hover:opacity-100"
              >
                <Plus size={11} />
              </button>
              <button
                onClick={() => setPinned(togglePinned(project.id))}
                aria-label={isPinned ? `Unpin project ${project.name}` : `Pin project ${project.name}`}
                title={isPinned ? 'Unpin' : 'Pin to top'}
                // Visible on hover, and always for a pinned one — otherwise
                // there is no way to see that a project IS pinned, nor to
                // reach the control by keyboard.
                className={clsx(
                  'absolute right-1 rounded p-1 text-ink-tertiary transition-colors hover:text-ink focus:opacity-100',
                  isPinned ? 'opacity-100 text-brand' : 'opacity-0 group-hover:opacity-100',
                )}
              >
                {isPinned ? <PinOff size={11} /> : <Pin size={11} />}
              </button>
              </div>

              {work.length > 0 && (
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
                            className="block truncate text-[12px] leading-[17px] text-ink-secondary"
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
                              'block truncate font-mono text-[10px] leading-[14px] text-ink-tertiary',
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
                            className="shrink-0 font-mono text-[8px] uppercase leading-[14px] tracking-wide"
                          >
                            {item.status}
                          </span>
                          {(() => {
                            /*
                             * What this card owns, and whether somebody else
                             * owns it too (CGLAB-190). Rendered only when there
                             * is something to say: every card in the database
                             * declares nothing, and a chip on all of them would
                             * be thirty rows announcing an absence.
                             *
                             * `held` is amber rather than red because it is not
                             * a failure - it is the mechanism working, and the
                             * card is waiting rather than broken.
                             */
                            const state = claimStateOf(item.id, allItemsForClaims as never);
                            const label = claimChipLabel(state);
                            if (!label) return null;
                            return (
                              <span
                                data-testid="card-claims"
                                title={claimChipTitle(state) ?? undefined}
                                className={clsx(
                                  'shrink-0 rounded-sm px-1 font-mono text-[8px] uppercase leading-[14px] tracking-wide',
                                  /*
                                   * Two-tone, the way every other amber TEXT
                                   * in this repo is (WorktreePanel, Settings).
                                   * Flat amber-500 as text is ~2:1 on the
                                   * light canvas at 8px - near invisible - and
                                   * tokens.css says so in as many words: the
                                   * muted tint is for decorative chips, not
                                   * for words somebody has to read.
                                   */
                                  state.rejected.length || state.heldBy.length
                                    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                    : 'text-ink-tertiary opacity-70',
                                )}
                              >
                                {label}
                              </span>
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
      {cardMenu && (
        <>
          {/* Anything that is not the menu dismisses it, including a second
              right-click elsewhere — a menu you can only close by choosing
              something is a trap. */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setCardMenu(null)}
            onContextMenu={e => { e.preventDefault(); setCardMenu(null); }}
          />
          <div
            role="menu"
            aria-label={`Actions for ${cardMenu.item.title}`}
            style={{ top: cardMenu.y, left: cardMenu.x }}
            className="fixed z-50 min-w-[10rem] overflow-hidden rounded-lg border border-border-soft bg-nav-surface py-1 shadow-2xl"
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
        </>
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
        className="shrink-0 border-t border-border-soft px-1.5 py-1.5"
      >
        <button
          type="button"
          onClick={openSettings}
          title="Settings"
          className={clsx(
            'flex w-full items-center gap-2 rounded-md py-1.5 text-left text-[12px] text-ink-secondary transition-colors hover:bg-canvas hover:text-ink',
            open ? 'px-2' : 'justify-center px-0',
          )}
        >
          <Settings size={13} className="shrink-0" />
          {/* The label goes, the button stays. `title` and the accessible name
              below keep it identifiable when only the icon is showing. */}
          {open ? <span className="flex-1">Settings</span> : <span className="sr-only">Settings</span>}
        </button>
      </div>
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

function SortMenu({ value, onChange }: { value: ProjectSort; onChange: (v: ProjectSort) => void }) {
  const [open, setOpen] = React.useState(false);

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
        aria-label="Sort projects"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Sort projects"
        className="flex items-center rounded p-1 text-ink-tertiary transition-colors hover:bg-canvas hover:text-ink-secondary"
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
              {value === option.value && <Check size={12} className="text-brand" />}
            </button>
          ))}
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
 * when Flows took its place, and Agents, which now renders the run feed it was
 * standing in for. With no row left waiting on a screen there is nothing for
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


