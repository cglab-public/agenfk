import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, MeResponse } from '../api';
import { LayoutDashboard, Shield, LogOut, GitPullRequest, Menu, X } from 'lucide-react';
import { Button, Callout, CopyButton } from './ui';
import { Logo } from './Logo';
import { ThemeToggle, sidebarButtonClass } from './ThemeToggle';

interface NavItemProps { to: string; icon: React.ReactNode; label: string; onNavigate: () => void }
function NavItem({ to, icon, label, onNavigate }: NavItemProps) {
  const { pathname } = useLocation();
  const active = pathname === to || (to !== '/' && pathname.startsWith(to));
  return (
    <Link
      to={to}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-body font-medium transition-colors ${active
        ? 'text-accent-ink bg-accent-fill'
        : 'text-ink-secondary hover:text-ink hover:bg-accent-fill/50'}`}
    >
      <span className={active ? 'text-accent-ink' : 'text-ink-tertiary'}>
        {icon}
      </span>
      {label}
    </Link>
  );
}

interface HealthResponse { ok: boolean; version: string }

export function Layout({ children }: { children: React.ReactNode }) {
  const nav = useNavigate();
  const me = useQuery<MeResponse>({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data });
  const health = useQuery<HealthResponse>({
    queryKey: ['hub-healthz'],
    queryFn: async () => (await api.get('/healthz')).data,
    staleTime: 5 * 60_000,
  });
  const logout = useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSuccess: () => { nav('/login'); window.location.reload(); },
  });
  // Who is signed in, best available: the provider's display name, else the
  // email, and only then the opaque id. `isOpaqueId` drives the monospace
  // treatment: a UUID is meant to be compared character by character, while a
  // name or an email is meant to be read.
  const identity = (() => {
    const name = me.data?.name?.trim();
    if (name) return { label: name, isOpaqueId: false };
    const email = me.data?.email?.trim();
    if (email) return { label: email, isOpaqueId: false };
    return { label: me.data?.userId ?? '—', isOpaqueId: true };
  })();

  // Below md the sidebar is a drawer behind the top bar's menu button. From
  // md up it is the static sidebar and none of this state shows.
  const [navOpen, setNavOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  // Focus goes back to the menu button only after the close has rendered:
  // until then the top bar is still inert, and browsers ignore focus() there.
  const returnFocusRef = useRef(false);
  const closeNav = useCallback((returnFocus: boolean) => {
    returnFocusRef.current = returnFocus;
    setNavOpen(false);
  }, []);
  useEffect(() => {
    if (!navOpen) {
      if (returnFocusRef.current) menuButtonRef.current?.focus();
      returnFocusRef.current = false;
      return;
    }
    drawerRef.current?.querySelector<HTMLElement>('button, a')?.focus();
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') closeNav(true); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [navOpen, closeNav]);
  // Widening to md turns the drawer into the static sidebar; an open drawer
  // left behind would come back, backdrop and all, on the way down again.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const atMd = window.matchMedia('(min-width: 48rem)');
    const onChange = (e: { matches: boolean }) => { if (e.matches) setNavOpen(false); };
    atMd.addEventListener('change', onChange);
    return () => atMd.removeEventListener('change', onChange);
  }, []);
  const followLink = () => closeNav(false);
  return (
    // The shell is the viewport: the sidebar stays full height and the content
    // pane scrolls on its own (it is the scroll root scrollPageToTop moves).
    <div className="h-dvh flex flex-col md:flex-row overflow-hidden bg-canvas text-ink">
      <header data-topbar inert={navOpen || undefined} className="md:hidden shrink-0 flex items-center justify-between gap-3 px-4 py-2 border-b border-border-soft bg-nav-surface">
        <Logo version={health.data?.version ?? null} />
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setNavOpen(true)}
          aria-label="Open navigation"
          aria-expanded={navOpen}
          aria-controls="hub-sidebar"
          className={sidebarButtonClass}
        >
          <Menu className="w-4 h-4" />
        </button>
      </header>
      {navOpen && (
        <div data-testid="drawer-backdrop" aria-hidden="true" onClick={() => closeNav(false)} className="md:hidden fixed inset-0 z-30 bg-navy-deep/60" />
      )}
      {/* Closed below md it is off screen AND invisible, so it leaves the tab
          order and the accessibility tree rather than hiding focusable links.
          Open, it is a modal dialog: the page behind is inert. Visibility
          flips at once on open (focus() is refused while it is still hidden)
          and only after the 200ms slide on close. */}
      <aside
        id="hub-sidebar"
        ref={drawerRef}
        {...(navOpen ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Navigation' } : {})}
        className={`fixed inset-y-0 left-0 z-40 md:static md:z-auto md:translate-x-0 md:visible motion-reduce:transition-none md:transition-none w-60 shrink-0 overflow-y-auto border-r border-border-soft bg-surface md:bg-nav-surface backdrop-blur-sm p-4 flex flex-col gap-1 ${navOpen ? 'translate-x-0 [transition:translate_200ms,visibility_0s]' : '-translate-x-full invisible [transition:translate_200ms,visibility_0s_200ms]'}`}
      >
        <div className="px-2 pt-1 pb-5 flex items-start justify-between gap-2">
          <Logo version={health.data?.version ?? null} />
          <button type="button" onClick={() => closeNav(true)} aria-label="Close navigation" className={`md:hidden ${sidebarButtonClass}`}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <NavItem to="/" icon={<LayoutDashboard className="w-4 h-4" />} label="Org rollup" onNavigate={followLink} />
        <NavItem to="/prs" icon={<GitPullRequest className="w-4 h-4" />} label="PR overview" onNavigate={followLink} />
        {me.data?.role === 'admin' && (
          <NavItem to="/admin" icon={<Shield className="w-4 h-4" />} label="Admin" onNavigate={followLink} />
        )}
        <div data-testid="sidebar-footer" className="mt-auto px-2 py-2 rounded-lg border border-border-soft bg-card-glass">
          <div className="eyebrow text-ink-tertiary">Signed in</div>
          <div
            // Wrapped, not truncated: a long name or address was cut off with
            // the rest only in a mouse-only title.
            className={`mt-0.5 text-small text-ink ${identity.isOpaqueId ? 'font-mono break-all' : 'break-words'}`}
          >
            {identity.label}
          </div>
          <div className="eyebrow mt-0.5 text-accent-ink">{me.data?.role}</div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <ThemeToggle />
            <button
              onClick={() => logout.mutate()}
              className={`${sidebarButtonClass} hover:bg-danger-muted/10 hover:border-danger-muted/40 hover:text-danger-muted`}
            >
              <LogOut className="w-3 h-3" /> Sign out
            </button>
          </div>
        </div>
      </aside>
      {/* relative: absolutely positioned children (sr-only text in tables) must
          be contained here, or they stretch the page past the h-dvh shell. */}
      <main data-scroll-root inert={navOpen || undefined} className="relative flex-1 min-w-0 overflow-y-auto p-4 md:p-6 lg:p-8">
        {me.data?.role === 'admin' && <PendingEnvOrgIdBanner />}
        {children}
      </main>
    </div>
  );
}

function PendingEnvOrgIdBanner() {
  const qc = useQueryClient();
  const pending = useQuery<{ pendingEnvOrgId: string | null }>({
    queryKey: ['system-pending'],
    queryFn: async () => (await api.get('/v1/admin/system/pending')).data,
    // Refresh on focus so the banner clears across sessions once acked.
    refetchOnWindowFocus: true,
    // 401s on non-admin shouldn't keep retrying.
    retry: false,
  });
  const ack = useMutation({
    mutationFn: () => api.post('/v1/admin/system/pending/ack', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['system-pending'] }),
  });
  const value = pending.data?.pendingEnvOrgId;
  if (!value) return null;
  return (
    <Callout
      tone="warn"
      className="mb-4"
      title={<>Action required: update <code className="font-mono">AGENFK_HUB_ORG_ID</code></>}
      action={<Button size="sm" disabled={ack.isPending} onClick={() => ack.mutate()}>I've updated my deployment</Button>}
    >
      Set <code className="font-mono">AGENFK_HUB_ORG_ID={value}</code> in your hub deployment manifest before the next restart. Otherwise the hub will boot in maintenance mode on the wrong env.
      {' '}<CopyButton value={`AGENFK_HUB_ORG_ID=${value}`} label="Copy setting" />
    </Callout>
  );
}
