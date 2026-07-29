import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, ProvidersResponse } from '../api';

export function LoginPage() {
  const providers = useQuery<ProvidersResponse>({
    queryKey: ['providers'],
    queryFn: async () => (await api.get('/auth/providers')).data,
  });
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const login = useMutation({
    mutationFn: () => api.post('/auth/login', { email, password }),
    onSuccess: () => nav('/'),
    onError: (e: any) => setErr(e?.response?.data?.error ?? 'Login failed'),
  });

  if (providers.data?.requiresSetup) { nav('/setup'); return null; }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-canvas text-ink">
      <div className="w-full max-w-sm space-y-6 bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-6">
        <h1 className="text-xl font-semibold">Sign in to AgEnFK Hub</h1>
        {providers.data?.password && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setErr(null); login.mutate(); }}>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" className="w-full px-3 py-2 border border-border-soft rounded-lg bg-canvas text-ink focus:outline-none focus:ring-2 focus:ring-brand" />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" className="w-full px-3 py-2 border border-border-soft rounded-lg bg-canvas text-ink focus:outline-none focus:ring-2 focus:ring-brand" />
            <button type="submit" className="w-full px-3 py-2 bg-[image:var(--gradient-accent)] text-navy shadow-glow rounded-lg font-bold disabled:opacity-50" disabled={login.isPending}>
              {login.isPending ? 'Signing in…' : 'Sign in'}
            </button>
            {err && <div className="text-sm text-danger-muted">{err}</div>}
          </form>
        )}
        <div className="space-y-2">
          {providers.data?.google && (
            <a href="/auth/google/start" className="block w-full text-center px-3 py-2 border border-border-soft rounded-lg hover:border-border-brand hover:text-accent-text transition-colors">Sign in with Google</a>
          )}
          {providers.data?.entra && (
            <a href="/auth/entra/start" className="block w-full text-center px-3 py-2 border border-border-soft rounded-lg hover:border-border-brand hover:text-accent-text transition-colors">Sign in with Microsoft</a>
          )}
        </div>
      </div>
    </div>
  );
}
