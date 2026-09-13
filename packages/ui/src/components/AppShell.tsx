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
import { useQuery } from '@tanstack/react-query';
import { Book, PanelLeftClose, PanelLeftOpen, Pin, PinOff } from 'lucide-react';
import { useSocketEvent, useSocket } from '../SocketContext';
import { desktopInfo } from '../desktop';
import { useActiveProject } from '../ActiveProject';
import { readPinned, togglePinned, sortProjectsByPin } from '../sidebarPrefs';
import { NewProjectButton } from './NewProjectButton';
import { api } from '../api';
import type { Project } from '../types';
import { ReadmeModal } from './ReadmeModal';
import { WhatsNewModal } from './WhatsNewModal';

type TabId = 'kanban' | 'runs';

interface Tab {
  id: TabId;
  label: string;
}

const TABS: Tab[] = [
  { id: 'kanban', label: 'Kanban' },
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
        <Sidebar open={sidebarOpen} onToggle={toggleSidebar} isMac={isMac} />

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

      <ReadmeModal isOpen={readmeOpen} onClose={() => setReadmeOpen(false)} />
      <WhatsNewModal isOpen={whatsNewOpen} onClose={() => setWhatsNewOpen(false)} />
    </div>
  );
}

/**
 * How many projects fit before the list has to scroll instead of grow.
 * Past this, an unbounded list pushes Sessions off the bottom of the window.
 */
const PROJECTS_BEFORE_SCROLL = 5;

function Sidebar({ open, onToggle, isMac }: { open: boolean; onToggle: () => void; isMac: boolean }) {
  const { activeProjectId, setActiveProjectId } = useActiveProject();
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const [pinned, setPinned] = React.useState<string[]>(() => readPinned());

  // Pinned first, in the order they were pinned; the rest keep server order.
  const ordered = React.useMemo(
    () => sortProjectsByPin(projects as Project[], pinned),
    [projects, pinned],
  );
  const overflowing = ordered.length > PROJECTS_BEFORE_SCROLL;

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
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-slim px-2 pb-2">
      <ul
        data-testid="project-list"
        className={clsx(
          'flex flex-col',
          // Cap and scroll only once it would otherwise crowd out Sessions —
          // a short list should sit at its natural height, not inside a box.
          // Sized to the threshold: five rows at ~30px. Anything taller would
          // mean the cap engages without the list ever scrolling.
          overflowing && 'max-h-[150px] overflow-y-auto scrollbar-slim',
        )}
      >
        {ordered.map((project: Project) => {
          const isActive = project.id === activeProjectId;
          const isPinned = pinned.includes(project.id);
          return (
            <li key={project.id} className="group relative flex items-center">
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
                <span data-testid="project-name" className="truncate">{project.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-ink-tertiary group-hover:invisible">
                  {relativeAge(project.updatedAt)}
                </span>
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
            </li>
          );
        })}
      </ul>

      <SidebarLabel>Sessions</SidebarLabel>
      <p className="px-2 pb-2 text-[11px] leading-relaxed text-ink-tertiary">
        No active sessions. Starting an agent on a card will run it in its own
        git worktree and show it here.
      </p>
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

function SidebarLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="px-2 pt-2 text-[10px] font-bold uppercase tracking-wider text-ink-tertiary">
      {children}
    </h2>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto mt-16 max-w-sm text-center">
      <p className="text-sm font-semibold text-ink-secondary">{title}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-tertiary">{body}</p>
    </div>
  );
}
