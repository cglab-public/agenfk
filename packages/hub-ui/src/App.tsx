import { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, MeResponse, ProvidersResponse } from './api';
import { LoginPage } from './pages/Login';
import { SetupPage } from './pages/Setup';
import { OrgPage } from './pages/Org';
import { UserDetailPage } from './pages/UserDetail';
import { ConnectPage } from './pages/Connect';
import { AdminLayout, AdminAuth, AdminKeys, AdminUsers, AdminInstallations } from './pages/Admin';
import { AdminFlows } from './pages/AdminFlows';
import { AdminUpgrades } from './pages/AdminUpgrades';
import { Layout } from './components/Layout';

function useMe() {
  return useQuery<MeResponse | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try { return (await api.get('/auth/me')).data; }
      catch { return null; }
    },
  });
}

function useProviders() {
  return useQuery<ProvidersResponse>({
    queryKey: ['providers'],
    queryFn: async () => (await api.get('/auth/providers')).data,
  });
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const providers = useProviders();
  const nav = useNavigate();
  useEffect(() => {
    if (!me.isLoading && !me.data) {
      if (providers.data?.requiresSetup) nav('/setup');
      else nav('/login');
    }
  }, [me.isLoading, me.data, providers.data, nav]);
  if (me.isLoading || !me.data) return <div className="p-8 text-zinc-500">Loading…</div>;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/connect" element={<RequireAuth><ConnectPage /></RequireAuth>} />
      <Route path="/" element={<RequireAuth><Layout><OrgPage /></Layout></RequireAuth>} />
      <Route path="/users/:userKey" element={<RequireAuth><Layout><UserDetailPage /></Layout></RequireAuth>} />
      <Route path="/admin" element={<RequireAuth><Layout><AdminLayout /></Layout></RequireAuth>}>
        <Route path="auth" element={<AdminAuth />} />
        <Route path="keys" element={<AdminKeys />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="flows" element={<AdminFlows />} />
        <Route path="upgrades" element={<AdminUpgrades />} />
        <Route path="installations" element={<AdminInstallations />} />
        <Route index element={<Navigate to="auth" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
