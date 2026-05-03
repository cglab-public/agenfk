import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, MeResponse } from '../api';
import { LayoutDashboard, Users, Shield, LogOut } from 'lucide-react';

export function Layout({ children }: { children: React.ReactNode }) {
  const nav = useNavigate();
  const me = useQuery<MeResponse>({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data });
  const logout = useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSuccess: () => { nav('/login'); window.location.reload(); },
  });
  return (
    <div className="min-h-screen flex">
      <aside className="w-56 border-r border-zinc-200 dark:border-zinc-800 p-4 flex flex-col gap-1">
        <div className="font-semibold text-lg mb-6">AgEnFK Hub</div>
        <Link to="/" className="flex items-center gap-2 px-2 py-1 rounded hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50">
          <LayoutDashboard className="w-4 h-4" /> Org rollup
        </Link>
        {me.data?.role === 'admin' && (
          <Link to="/admin" className="flex items-center gap-2 px-2 py-1 rounded hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50">
            <Shield className="w-4 h-4" /> Admin
          </Link>
        )}
        <div className="mt-auto text-xs text-zinc-500">
          <div className="mb-2">{me.data?.role}</div>
          <button className="flex items-center gap-2 hover:underline" onClick={() => logout.mutate()}>
            <LogOut className="w-3 h-3" /> Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
