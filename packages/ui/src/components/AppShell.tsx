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
import { Book, Check, ChevronDown, ChevronRight, Folder, FolderOpen, ListFilter, PanelLeftClose, PanelLeftOpen, Pin, PinOff, Plus, Settings } from 'lucide-react';
import { useSocketEvent, useSocket } from '../SocketContext';
import { desktopInfo } from '../desktop';
import { useActiveProject } from '../ActiveProject';
import {
  readPinned, togglePinned, sortProjectsByPin,
  readExpanded, toggleExpanded,
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
import { SessionsRail, type SessionRow, type SessionState } from './SessionsRail';
import { LiveAgents } from '../liveAgents';
import { EmptyState } from './EmptyState';
import { ReadmeModal } from './ReadmeModal';
import { WhatsNewModal } from './WhatsNewModal';
import { moveTab } from '../tabReorder';
import { liveSessions } from '../liveSessions';
import { CardPicker } from './CardPicker';

type TabId = 'kanban' | 'terminal' | 'runs' | 'settings';

interface Tab {
  id: TabId;
  label: string;
}

/**
 * The views the shell can show, and the order it falls back to.
 *
 * The ORDER is the user's, not this list's — see `useShellTabs`. This is the
 * set of what exists, which is a different question from what order they sit
 * in, and conflating the two is why the bar was a constant in the first place.
 */
const TABS: Tab[] = [
  { id: 'kanban', label: 'Kanban' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'runs', label: 'Runs' },
];

type Connection = 'connecting' | 'connected' | 'offline';

const SIDEBAR_KEY = 'agenfk_shell_sidebar';
const TABS_KEY = 'agenfk_shell_tabs';
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
 * Where the Runs view sits.
 *
 * A CLOSED set, and that is the design rather than a limitation. Free layout
 * becomes window management: state that is hard to persist and easy to leave
 * unusable, for flexibility nobody asked for. Two positions give nearly all of
 * the perceived freedom at a fraction of that cost.
 *
 * `bottom` exists because live logs are something you follow WHILE looking at
 * the board, and a sibling tab makes that a choice between them.
 */
type RunsDock = 'tab' | 'bottom';
const RUNS_DOCKS: RunsDock[] = ['tab', 'bottom'];

function readRunsDock(): RunsDock {
  try {
    const stored = JSON.parse(localStorage.getItem(RUNS_DOCK_KEY) ?? 'null');
    // An unrecognised zone — another version, or a hand-edited value — must
    // not put the view nowhere.
    return RUNS_DOCKS.includes(stored) ? stored : 'tab';
  } catch { return 'tab'; }
}

/**
 * The tab bar's order, remembered.
 *
 * Rearranging something that resets on the next launch is worse than not being
 * able to rearrange it at all, so the order is stored — but the stored value is
 * treated as a SUGGESTION and not as the truth:
 *
 *  - an id it names that this build does not have is dropped, because
 *    rendering a tab with no panel is a hole in the bar;
 *  - a tab this build has that it does not name is appended, because a build
 *    that adds a view must not hide it from everyone who has ever reordered;
 *  - anything that is not a list of strings is ignored entirely.
 *
 * All three are "written by a different version", which is the ordinary case
 * for anything kept in localStorage across upgrades.
 */
/**
 * The tabs actually on screen, in order.
 *
 * Docked below, Runs is not a tab — so the stored order and the rendered bar
 * disagree, and anything that counts or steps through tabs has to use THIS one.
 * Two places got that wrong at once: the move-left button stepped to a hidden
 * neighbour and did nothing visible, and the screen-reader announcement
 * described a bar with a tab in it that nobody could see.
 */
function visibleOrder(order: readonly TabId[], dock: RunsDock): TabId[] {
  return order.filter(id => !(id === 'runs' && dock === 'bottom'));
}

function readTabOrder(): TabId[] {
  const known = TABS.map(t => t.id);
  let stored: unknown;
  try { stored = JSON.parse(localStorage.getItem(TABS_KEY) ?? 'null'); } catch { stored = null; }
  if (!Array.isArray(stored)) return known;
  const kept = stored.filter((id): id is TabId => typeof id === 'string' && (known as string[]).includes(id));
  const missing = known.filter(id => !kept.includes(id));
  return [...kept, ...missing];
}

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  offline: 'Offline',
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const [active, setActive] = React.useState<TabId>('kanban');
  // A latch, not a mirror of `active`. Opening a terminal launches an agent
  // CLI, so it must not happen before the user asks — but once it has, the
  // session outlives every tab switch.
  const [terminalOpened, setTerminalOpened] = React.useState(false);
  // The bar's order, seeded from storage in the initializer so there is no
  // first paint in an order the user already changed away from.
  const [tabOrder, setTabOrder] = React.useState<TabId[]>(() => readTabOrder());
  const [runsDock, setRunsDock] = React.useState<RunsDock>(() => readRunsDock());
  const moveRunsTo = React.useCallback((dock: RunsDock) => {
    setRunsDock(dock);
    try { localStorage.setItem(RUNS_DOCK_KEY, JSON.stringify(dock)); } catch { /* a lost preference */ }
    // Leaving the tab while it is the selected one would show an empty main
    // area; the board is the only view that is always there.
    if (dock === 'bottom') setActive(cur => (cur === 'runs' ? 'kanban' : cur));
  }, []);
  const orderedTabs = React.useMemo(
    // Docked below, Runs is not a tab. Two places to reach one view is how the
    // rail and the terminal came to disagree earlier in this epic — and the
    // same filter has to be the one `placeTab` counts with, or the bar and the
    // announcement describe different things.
    () => visibleOrder(tabOrder, runsDock).map(id => TABS.find(t => t.id === id)!).filter(Boolean),
    [tabOrder, runsDock],
  );
  /**
   * The tab under the pointer during a drag, for the drop line.
   *
   * Local to the bar and never persisted: it is where the pointer IS, not a
   * preference. `dragging` is kept as state rather than read back out of the
   * DataTransfer because `dragover` is not allowed to read it — the drag data
   * store is in protected mode until the drop.
   */
  const [dragTab, setDragTab] = React.useState<TabId | null>(null);
  const [dragOverTab, setDragOverTab] = React.useState<TabId | null>(null);
  /**
   * What a screen reader is told after a move.
   *
   * Dragging is silent for anyone not watching the pointer, and this feature
   * only earns its place as an ADDITION to the arrow button — so the outcome
   * has to be announced rather than merely rendered.
   */
  const [tabMoveAnnouncement, setTabMoveAnnouncement] = React.useState('');
  /**
   * Put `id` where `target` currently is, and remember it.
   *
   * The single writer for BOTH reorder affordances. The arrow button had its
   * own splice and dragging would have added a second one — two versions of one
   * rule that agree right up until somebody edits one of them, which is the
   * failure this epic kept producing.
   */
  const placeTab = React.useCallback((id: TabId, target: TabId) => {
    // Read from state and write once, rather than computing inside the updater.
    // The updater runs twice under StrictMode, and announcing a move from
    // inside one would announce it twice and set state during another
    // component's render.
    const next = moveTab(tabOrder, id, target);
    setTabOrder(next);
    try { localStorage.setItem(TABS_KEY, JSON.stringify(next)); } catch { /* a lost preference, not a failure */ }
    const label = TABS.find(t => t.id === id)?.label ?? id;
    /*
     * Counted over the VISIBLE bar, not over the stored order.
     *
     * They differ whenever Runs is docked below: the stored order still has
     * three ids and the bar shows two. Announcing "position 2 of 3" to a
     * screen reader while a sighted user sees two tabs describes a bar that is
     * not on screen — which is worse than announcing nothing, because it is
     * the only description that user gets.
     *
     * The POSITION and not "moved left", because after a drag across the bar
     * the direction is not the useful part. 1-based, which is how it is read
     * aloud.
     */
    const shown = visibleOrder(next, runsDock);
    setTabMoveAnnouncement(`${label} moved to position ${shown.indexOf(id) + 1} of ${shown.length}`);
  }, [tabOrder, runsDock]);
  // Same latch idea as the terminal, for a much smaller reason: no request goes
  // out for a screen the user has never opened.
  const [settingsOpened, setSettingsOpened] = React.useState(false);
  const { focusedItemId, newItemRequest, setActiveProjectId, markProjectWorked, focusItem, terminalRequest } = useActiveProject();
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
    // SessionsRail.
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
  // and never on mount: the Runs tab stays selected until the user actually
  // asks for a card.
  React.useEffect(() => {
    if (!focusedItemId && !newItemRequest) return;
    setActive('kanban');
  }, [focusedItemId, newItemRequest]);

  // One place, so the latch cannot be missed by a new route into the tab —
  // there are already two (click and arrow keys).
  React.useEffect(() => {
    if (active === 'terminal') setTerminalOpened(true);
  }, [active]);

  const onTablistKeyDown = (event: React.KeyboardEvent): void => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    let next: TabId | null = null;
    if (delta !== 0) {
      const at = TABS.findIndex(t => t.id === active);
      next = TABS[(at + delta + TABS.length) % TABS.length].id;
    } else if (event.key === 'Home') {
      next = TABS[0].id;
    } else if (event.key === 'End') {
      next = TABS[TABS.length - 1].id;
    }
    if (!next) return;
    event.preventDefault();
    setActive(next);
    // Follow focus, as the ARIA tabs pattern requires for automatic activation.
    document.getElementById(`tab-${next}`)?.focus();
  };

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
          openTerminalCount={sessions.length}
          openSession={openSession}
          stopSession={stopSession}
          openSettings={() => { setSettingsOpened(true); setActive('settings'); }}
          revealOnBoard={revealOnBoard}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <div
            role="tablist"
            aria-label="Views"
            onKeyDown={onTablistKeyDown}
            // The main column's top row IS the title bar here, so it drags the
            // window like one. Without this the only handle is the sliver of
            // rail left over beside the traffic lights when collapsed.
            data-app-region={isMac ? 'drag' : undefined}
            // Collapsed, the sidebar rail is ~40px while the macOS traffic
            // lights occupy ~78px from the window edge. Without reserving the
            // difference the first tab renders UNDER the window buttons —
            // unclickable, with the OS window menu opening on top of it.
            data-reserves-window-controls={reservesWindowControls ? 'true' : undefined}
            className={clsx(
              'flex shrink-0 gap-1 border-b border-border-soft bg-nav-surface pt-2 pr-3',
              reservesWindowControls ? 'pl-12' : 'pl-3',
            )}
          >
            {orderedTabs.map((tab, index) => (
              <div
                key={tab.id}
                className={clsx(
                  'group relative flex items-end',
                  /*
                   * Where it would land. A line rather than a filled box: the
                   * question during a drag is which SLOT the tab is taking,
                   * and a highlighted tab reads as "this one is selected".
                   *
                   * The SIDE follows the direction, and getting that wrong is
                   * not cosmetic. A tab dragged rightward lands AFTER the
                   * target, so a line on the target's left edge promises a gap
                   * the tab will not land in — a drop that looks like it
                   * missed by one, on exactly the case that is already the
                   * least obvious.
                   */
                  dragOverTab === tab.id && dragTab !== tab.id && (
                    orderedTabs.findIndex(t => t.id === dragTab) < index
                      ? 'after:absolute after:inset-y-1 after:-right-0.5 after:w-0.5 after:rounded after:bg-accent-text'
                      : 'before:absolute before:inset-y-1 before:-left-0.5 before:w-0.5 before:rounded before:bg-accent-text'
                  ),
                  dragTab === tab.id && 'opacity-50',
                )}
                // Dragging the TAB, not the window. Without this the macOS
                // title-bar drag region above wins and the whole window moves.
                data-app-region="no-drag"
                draggable
                onDragStart={e => {
                  setDragTab(tab.id);
                  e.dataTransfer.effectAllowed = 'move';
                  // Some browsers refuse to start a drag with an empty data
                  // store. The id is not read back on drop — `dragTab` is —
                  // because the store is unreadable until then anyway.
                  try { e.dataTransfer.setData('text/plain', tab.id); } catch { /* not fatal to the drag */ }
                }}
                onDragEnd={() => { setDragTab(null); setDragOverTab(null); }}
                onDragOver={e => {
                  // Only for a tab of ours. Without the guard the bar accepts a
                  // file or a text selection dropped on it and moves nothing,
                  // which looks like the drop was understood.
                  if (!dragTab) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDragOverTab(tab.id);
                }}
                onDragLeave={() => setDragOverTab(cur => (cur === tab.id ? null : cur))}
                onDrop={e => {
                  e.preventDefault();
                  const moved = dragTab;
                  setDragTab(null);
                  setDragOverTab(null);
                  if (moved && moved !== tab.id) placeTab(moved, tab.id);
                }}
              >
              <button
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={active === tab.id}
                aria-controls={`panel-${tab.id}`}
                // Roving tabindex: one stop for the whole tablist, then arrows
                // move between tabs. Without it Tab walks every tab one by one,
                // which is the behaviour the ARIA pattern exists to avoid.
                /* When Settings is active, no member of TABS matches — which gave every
                 tab tabIndex -1 and dropped the whole tablist out of the keyboard
                 order, with no way back to the board without a mouse. The first tab
                 holds the stop in that case. */
              tabIndex={active === tab.id || (!TABS.some(t => t.id === active) && tab.id === orderedTabs[0]?.id) ? 0 : -1}
                // Opt back out: a drag region swallows pointer events.
                data-app-region="no-drag"
                onClick={() => setActive(tab.id)}
                className={clsx(
                  'rounded-t-lg border border-b-0 px-3 py-1.5 text-xs font-semibold transition-colors',
                  active === tab.id
                    ? '-mb-px border-border-soft bg-canvas text-ink'
                    : 'border-transparent text-ink-tertiary hover:text-ink-secondary',
                )}
              >
                {tab.label}
              </button>
              {/* No move-left on the first tab: it has nowhere to go, and a
                  control that does nothing is worse than its absence. The
                  built-in views have no close button either — closing Kanban
                  would leave no way back to the board, and a bar that can be
                  emptied is a dead end. */}
              {index > 0 && (
                <button
                  data-app-region="no-drag"
                  aria-label={`Move ${tab.label} left`}
                  title={`Move ${tab.label} left`}
                  // The neighbour ON SCREEN, taken from the list being
                  // rendered. Re-deriving it from the stored order stepped to
                  // a tab that is not shown when Runs is docked below: the bar
                  // did not move, and the live region still said it had.
                  onClick={() => placeTab(tab.id, orderedTabs[index - 1].id)}
                  className="absolute -left-1 bottom-1.5 rounded px-0.5 font-mono text-[9px] text-ink-tertiary opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100"
                >
                  ‹
                </button>
              )}
              </div>
            ))}

            {/* A BUTTON, not a drag target. Keyboard parity is in the card,
                and a drag-only affordance is unreachable without a pointer.
                Only while Runs IS a tab: once it is docked, the way back lives
                on the strip itself, where the user is already looking. Two
                controls for one action is two things to keep in step. */}
            {runsDock === 'tab' && (
              <button
                data-app-region="no-drag"
                onClick={() => moveRunsTo('bottom')}
                aria-label="Dock Runs below the board"
                title="Dock Runs below the board"
                className="ml-auto self-center rounded px-2 py-1 font-mono text-[10px] text-ink-tertiary transition-colors hover:text-ink"
              >
                Runs ↓
              </button>
            )}
          </div>

          {/* Outside the tablist: a live region inside it would be a child of
              role="tablist", where only tabs belong. Polite, because a reorder
              is never urgent enough to cut off what is being read. */}
          <div role="status" aria-live="polite" className="sr-only">
            {tabMoveAnnouncement}
          </div>

          {/* The panels and the Runs strip share this column. The board stays
              exactly where it is in the tree whichever position Runs is in —
              moving `children` to a different parent would unmount and remount
              it, losing scroll position, open menus and anything half-typed,
              which is the one cost this feature must not have. */}
          {/* Rendered, not conditionally mounted — see rule 1 above. */}
          <div
            role="tabpanel"
            id="panel-kanban"
            aria-labelledby="tab-kanban"
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
          <div
            role="tabpanel"
            id="panel-terminal"
            aria-labelledby="tab-terminal"
            tabIndex={0}
            hidden={active !== 'terminal'}
            className="min-h-0 flex-1"
          >
            {terminalOpened && (
              <TerminalTab
                sessions={sessions}
                activeId={activeSession}
                onSelect={setActiveSession}
                onClose={closeSession}
                editors={editors}
                showWorktree
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

          <div
            role="tabpanel"
            id="panel-runs"
            aria-labelledby="tab-runs"
            tabIndex={0}
            hidden={active !== 'runs'}
            className="min-h-0 flex-1 overflow-auto scrollbar-slim p-6"
          >
            <EmptyState
              title="No agent runs open"
              body="Runs started from a card appear here. Open a card and start work to see its live log."
            />
          </div>

          {/* Below the board, in the same column, so both are visible at once —
              which is the whole reason the card calls a sibling tab the wrong
              place for a live log. */}
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
                  onClick={() => moveRunsTo('tab')}
                  aria-label="Put Runs back to a tab"
                  className="ml-auto rounded px-1.5 font-mono text-[10px] text-ink-tertiary transition-colors hover:text-ink"
                >
                  ↑
                </button>
              </header>
              <div className="min-h-0 flex-1 overflow-auto scrollbar-slim p-4">
                <EmptyState
                  title="No agent runs open"
                  body="Runs started from a card appear here."
                />
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
  openTerminalCount: number;
  openSession: (row: SessionRow) => void;
  stopSession: (runId: string) => void;
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
}

function Sidebar({ open, onToggle, isMac, requestTerminal, sessionRows, liveItems, openTerminalCount, openSession, stopSession, openSettings, revealOnBoard }: SidebarProps) {
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
  useSocketEvent('items_updated', () => queryClient.invalidateQueries({ queryKey: ['active-items'] }));
  // Anything that changed while the socket was down produced no event, so the
  // counts stay wrong until the next unrelated item change. The board already
  // refetches its own queries on connect; this one is keyed differently and
  // was not covered by that.
  useSocketEvent('connect', () => queryClient.invalidateQueries({ queryKey: ['active-items'] }));

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
      {isMac && <div data-app-region="drag" className="h-9 shrink-0" />}

      <div
        className={clsx(
          'flex shrink-0 items-center',
          open ? 'justify-between px-2 pr-1' : 'justify-center pt-2',
        )}
      >
        {open && <SidebarLabel>Projects</SidebarLabel>}
        {open && (
          <div className="ml-auto flex items-center">
            <SortMenu value={sort} onChange={next => setSort(writeProjectSort(next))} />
            <NewProjectButton onCreated={id => setActiveProjectId(id)} />
          </div>
        )}
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
      <div data-testid="projects-section" className="flex min-h-0 flex-1 flex-col">
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
                <span data-testid="project-name" className="truncate">{project.name}</span>
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
                        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-ink-tertiary transition-colors hover:bg-canvas hover:text-ink"
                      >
                        {/* Only when an agent is actually working on it.
                            Before, every row got the same dot in the same
                            colour — it distinguished nothing, which makes it
                            decoration rather than information. If nothing is
                            happening, nothing is drawn: the absence is the
                            answer, and the step label on the right already
                            says where the card is sitting. */}
                        {/* The SLOT is always there; only the dot inside it
                            comes and goes. Rendering nothing removed 6px of
                            dot and 6px of gap, which left a ragged left edge
                            in any list mixing live and quiet cards — and made
                            the title jump sideways and re-truncate on its own
                            when the dot appeared on an event or went out on
                            the TTL, with no user action behind it. */}
                        <span
                          data-testid={liveItems.has(item.id) ? 'live-dot' : undefined}
                          className={clsx(
                            'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
                            liveItems.has(item.id)
                              ? 'animate-pulse bg-emerald-500 motion-reduce:animate-none'
                              : 'invisible',
                          )}
                        />
                        {liveItems.has(item.id) && (
                          // Said in words for anyone not looking at colour: a
                          // 6px dot with a `title` is a mouse-only fact, and
                          // the title on a non-focusable span never reaches
                          // assistive tech at all.
                          <span className="sr-only">An agent is working on this now</span>
                        )}
                        <span className="truncate text-ink-secondary">{item.title}</span>
                        {/* The step is the thing that says where it is stuck. */}
                        <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-wide">
                          {item.status}
                        </span>
                      </button>
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

      <div data-testid="sessions-section" className="flex min-h-0 shrink-0 flex-col border-t border-border-soft pt-1">
        <div className="flex items-center gap-2 px-2 pt-2">
          <h2 className="text-[10px] font-bold uppercase tracking-wider text-ink-tertiary">Sessions</h2>
          {openTerminalCount > 0 && (
            // How many terminals you have OPEN, which is a different number
            // from how many agents are running: a card can have a terminal
            // with nothing working in it, and a run can exist with no terminal
            // of ours at all.
            <span
              data-testid="open-terminal-count"
              title={`${openTerminalCount} terminal${openTerminalCount === 1 ? '' : 's'} open`}
              className="rounded-full bg-canvas px-1.5 font-mono text-[9px] font-semibold text-ink-secondary"
            >
              {openTerminalCount}
            </span>
          )}
        </div>
        <div className="min-h-0 overflow-y-auto scrollbar-slim">
          <SessionsRail rows={sessionRows} onOpen={openSession} onStop={stopSession} onReveal={revealOnBoard} />
        </div>
      </div>

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

function SidebarLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="px-2 pt-2 text-[10px] font-bold uppercase tracking-wider text-ink-tertiary">
      {children}
    </h2>
  );
}


