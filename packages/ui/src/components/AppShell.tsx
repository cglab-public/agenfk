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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Book, Check, ChevronDown, ChevronRight, Folder, FolderOpen, ListFilter, PanelLeftClose, PanelLeftOpen, Pin, PinOff, Plus } from 'lucide-react';
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
import { TerminalTab } from './TerminalTab';
import { NewTerminalDialog } from './NewTerminalDialog';
import { listAgentsFromBridge } from './agentBridge';
import { EmptyState } from './EmptyState';
import { ReadmeModal } from './ReadmeModal';
import { WhatsNewModal } from './WhatsNewModal';

type TabId = 'kanban' | 'terminal' | 'runs';

interface Tab {
  id: TabId;
  label: string;
}

const TABS: Tab[] = [
  { id: 'kanban', label: 'Kanban' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'runs', label: 'Runs' },
];

type Connection = 'connecting' | 'connected' | 'offline';

const SIDEBAR_KEY = 'agenfk_shell_sidebar';

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
  const { focusedItemId, newItemRequest, setActiveProjectId } = useActiveProject();
  /** The card a terminal is being opened FOR, while the dialog is up. */
  const [pending, setPending] = React.useState<
    { itemId: string; title: string; agentId?: string } | null
  >(null);
  /**
   * The card a terminal is currently open ON, with the choices made for it.
   *
   * Separate from `pending` on purpose: the agent and the auto-approve flag are
   * decided once, at open time, and must not change under a running session.
   */
  const [session, setSession] = React.useState<
    { itemId: string; agentId: string; autoApprove: boolean } | null
  >(null);

  const requestTerminal = React.useCallback((item: AgEnFKItem): void => {
    setActiveProjectId(item.projectId);
    // agentId comes off the ITEM, which is where it lives — the server keeps it
    // in the item's own record, so it follows the card rather than the machine.
    setPending({ itemId: item.id, title: item.title, agentId: item.agentId });
  }, [setActiveProjectId]);
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
        <Sidebar open={sidebarOpen} onToggle={toggleSidebar} isMac={isMac} requestTerminal={requestTerminal} />

        <main className="flex min-w-0 flex-1 flex-col">
          <div
            role="tablist"
            aria-label="Workspace"
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
            {TABS.map(tab => (
              <button
                key={tab.id}
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={active === tab.id}
                aria-controls={`panel-${tab.id}`}
                // Roving tabindex: one stop for the whole tablist, then arrows
                // move between tabs. Without it Tab walks every tab one by one,
                // which is the behaviour the ARIA pattern exists to avoid.
                tabIndex={active === tab.id ? 0 : -1}
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
            ))}
          </div>

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
            {terminalOpened && <TerminalTab session={session} />}
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

      {pending && (
        <NewTerminalDialog
          cardTitle={pending.title}
          defaultAgentId={pending.agentId}
          listAgents={listAgentsFromBridge}
          onClose={() => setPending(null)}
          onCreate={async ({ agentId, autoApprove }) => {
            // Latch and switch BEFORE clearing `pending`, so the panel exists
            // by the time the dialog goes away — otherwise the user watches an
            // empty tab for a frame while the pane mounts.
            // Open FIRST. Recording which agent a card uses is a nicety;
            // letting it fail — or even throw synchronously, as it did when the
            // api mock lacked the method — must never stop the terminal from
            // opening. Ordering is the guarantee here, not the try/catch.
            setSession({ itemId: pending.itemId, agentId, autoApprove });
            setTerminalOpened(true);
            setActive('terminal');
            setPending(null);

            // Remember the choice ON THE CARD, where it belongs: the server
            // keeps it in the item's own record, so it follows the card across
            // machines and clients instead of living in one browser's storage.
            if (agentId !== pending.agentId) {
              try {
                void api.updateItem(pending.itemId, { agentId } as never)?.catch?.(() => {});
              } catch { /* a lost preference is not worth a failed launch */ }
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
  /** Clicking a card asks the shell to open a terminal on it. */
  requestTerminal: (item: AgEnFKItem) => void;
}

function Sidebar({ open, onToggle, isMac, requestTerminal }: SidebarProps) {
  const queryClient = useQueryClient();
  const { activeProjectId, setActiveProjectId, focusItem, requestNewItem } = useActiveProject();
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
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
                <span className="shrink-0 font-mono text-[10px] text-ink-tertiary group-hover:invisible">
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

              {work.length > 0 && isOpen && (
                <ul id={`work-${project.id}`} className="mb-1 ml-2 border-l border-border-soft pl-2">
                  {work.map(item => (
                    <li key={item.id}>
                      {/* Clicking opens a terminal on the card, in that card's
                          own worktree — the sidebar lists work in flight, and
                          the thing you want from work in flight is a shell in
                          it. The board is still reachable from its own tab;
                          this row is the shortcut to the actual work. */}
                      <button
                        onClick={() => requestTerminal(item)}
                        title={item.title}
                        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-ink-tertiary transition-colors hover:bg-canvas hover:text-ink"
                      >
                        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                        <span className="truncate text-ink-secondary">{item.title}</span>
                        {/* The step is the thing that says where it is stuck. */}
                        <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-wide">
                          {item.status}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      </div>

      {/* A footer, not a peer. Projects is what you scan all day; this holds
          one line until CGLAB-170 gives it real sessions. */}
      <div data-testid="sessions-section" className="shrink-0 border-t border-border-soft pt-1">
        <SidebarLabel>Sessions</SidebarLabel>
        <p className="px-2 pb-1 text-[11px] leading-snug text-ink-tertiary">
          None running. Starting an agent on a card shows it here.
        </p>
      </div>
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


