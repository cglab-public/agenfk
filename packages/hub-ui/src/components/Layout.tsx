import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, MeResponse } from '../api';
import { LayoutDashboard, Shield, LogOut } from 'lucide-react';

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 100 100" className="w-8 h-8 drop-shadow-sm" aria-hidden>
        <defs>
          <linearGradient id="hub-logo" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
        </defs>
        <rect width="100" height="100" rx="24" fill="url(#hub-logo)" />
        <path d="M50 25L25 75H35L50 45L65 75H75L50 25Z" fill="white" />
        <circle cx="50" cy="25" r="8" fill="white" />
        <circle cx="50" cy="25" r="4" fill="#6366f1" />
        <rect x="40" y="55" width="20" height="4" rx="2" fill="white" fillOpacity="0.8" />
      </svg>
      <div className="leading-tight">
        <div className="text-sm font-bold text-slate-900 dark:text-slate-100">AgEnFK</div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-indigo-600 dark:text-indigo-400">Hub</div>
      </div>
    </div>
  );
}

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

export function Layout({ children }: { children: React.ReactNode }) {
  const nav = useNavigate();
  const me = useQuery<MeResponse>({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data });
  const logout = useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSuccess: () => { nav('/login'); window.location.reload(); },
  });
  return (
    <div className="min-h-screen flex bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <aside className="w-60 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/40 backdrop-blur-sm p-4 flex flex-col gap-1">
        <div className="px-2 pt-1 pb-5">
          <Logo />
        </div>
        <NavItem to="/" icon={<LayoutDashboard className="w-4 h-4" />} label="Org rollup" />
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
      <main className="flex-1 min-w-0 p-6 lg:p-8">{children}</main>
    </div>
  );
}
