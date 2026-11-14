import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, ProvidersResponse } from '../api';
import { Logo } from '../components/Logo';
import { Button, buttonClass, Field, Input } from '../components/ui';

/** Router state a page can hand the sign-in page when it redirects here. */
export type LoginNotice = 'admin-created';
const NOTICES: Record<LoginNotice, string> = {
  'admin-created': 'Admin account created. Sign in with it.',
};

export function LoginPage() {
  const providers = useQuery<ProvidersResponse>({
    queryKey: ['providers'],
    queryFn: async () => (await api.get('/auth/providers')).data,
  });
  const nav = useNavigate();
  const location = useLocation();
  // Read once, then drop it from history: a reload or Back must not announce
  // the account again. Local state keeps it on screen for this visit.
  const [notice, setNotice] = useState((location.state as { notice?: LoginNotice } | null)?.notice);
  useEffect(() => {
    if (location.state) nav(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, nav]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const login = useMutation({
    mutationFn: () => api.post('/auth/login', { email, password }),
    onSuccess: () => nav('/'),
    onError: (e: any) => setErr(e?.response?.data?.error ?? 'Login failed'),
  });

  const needsSetup = !!providers.data?.requiresSetup;
  useEffect(() => { if (needsSetup) nav('/setup'); }, [needsSetup, nav]);
  if (needsSetup) return null;

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-canvas text-ink">
      <div className="w-full max-w-sm space-y-6 bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-6">
        <Logo />
        <h1 className="text-title font-semibold">Sign in to AgEnFK Hub</h1>
        {notice && NOTICES[notice] && (
          <p role="status" className="text-body rounded-lg px-3 py-2 bg-status-ok-bg text-status-ok-text">{NOTICES[notice]}</p>
        )}
        {providers.data?.password && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setErr(null); setNotice(undefined); login.mutate(); }}>
            <Field label="Email">
              <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" className="w-full" disabled={login.isPending}>
              {login.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
            {err && <div role="alert" className="text-body text-danger-text">{err}</div>}
          </form>
        )}
        <div className="space-y-2">
          {providers.data?.google && (
            <a href="/auth/google/start" className={buttonClass('secondary', 'md', 'w-full')}>Sign in with Google</a>
          )}
          {providers.data?.entra && (
            <a href="/auth/entra/start" className={buttonClass('secondary', 'md', 'w-full')}>Sign in with Microsoft</a>
          )}
        </div>
      </div>
    </div>
  );
}
