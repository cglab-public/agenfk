import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, MeResponse } from '../api';
import { LayoutDashboard, Shield, LogOut, AlertTriangle, GitPullRequest } from 'lucide-react';
import { Logo } from './Logo';

interface NavItemProps { to: string; icon: React.ReactNode; label: string }
function NavItem({ to, icon, label }: NavItemProps) {
  const { pathname } = useLocation();
  const active = pathname === to || (to !== '/' && pathname.startsWith(to));
  return (
    <Link
      to={to}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors ${active
        ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-100'}`}
    >
      <span className={active ? 'text-indigo-500 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500'}>
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
  return (
    <div className="min-h-screen flex bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <aside className="w-60 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/40 backdrop-blur-sm p-4 flex flex-col gap-1">
        <div className="px-2 pt-1 pb-5">
          <Logo version={health.data?.version ?? null} />
        </div>
        <NavItem to="/" icon={<LayoutDashboard className="w-4 h-4" />} label="Org rollup" />
        <NavItem to="/prs" icon={<GitPullRequest className="w-4 h-4" />} label="PR overview" />
        {me.data?.role === 'admin' && (
          <NavItem to="/admin" icon={<Shield className="w-4 h-4" />} label="Admin" />
        )}
        <div className="mt-auto px-2 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
          <div className="text-[10px] uppercase tracking-[0.16em] text-slate-400 dark:text-slate-500">Signed in</div>
          <div className="mt-0.5 text-[12px] font-mono text-slate-700 dark:text-slate-200 truncate">{me.data?.userId ?? '—'}</div>
          <div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-indigo-600 dark:text-indigo-400">{me.data?.role}</div>
          <button
            onClick={() => logout.mutate()}
            className="mt-2 w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-semibold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-rose-50 hover:border-rose-200 hover:text-rose-600 dark:hover:bg-rose-900/20 dark:hover:border-rose-700 dark:hover:text-rose-400 transition-colors"
          >
            <LogOut className="w-3 h-3" /> Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 min-w-0 p-6 lg:p-8">
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
    <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 p-3">
      <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-300 mt-0.5 shrink-0" />
      <div className="flex-1 text-sm text-amber-900 dark:text-amber-100">
        <div className="font-semibold">Action required: update <code className="font-mono">AGENFK_HUB_ORG_ID</code></div>
        <p className="mt-0.5 text-amber-800 dark:text-amber-200">
          Set <code className="font-mono">AGENFK_HUB_ORG_ID={value}</code> in your hub deployment manifest before the next restart. Otherwise the hub will boot in maintenance mode on the wrong env.
        </p>
      </div>
      <button
        className="px-3 py-1.5 rounded-lg bg-white dark:bg-amber-950 border border-amber-300 dark:border-amber-700 text-xs font-semibold text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900 disabled:opacity-50"
        disabled={ack.isPending}
        onClick={() => ack.mutate()}
      >
        I've updated my deployment
      </button>
    </div>
  );
}
