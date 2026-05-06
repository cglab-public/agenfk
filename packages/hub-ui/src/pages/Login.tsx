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
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <h1 className="text-xl font-semibold">Sign in to AgEnFK Hub</h1>
        {providers.data?.password && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setErr(null); login.mutate(); }}>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" className="w-full px-3 py-2 border rounded" />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" className="w-full px-3 py-2 border rounded" />
            <button type="submit" className="w-full px-3 py-2 bg-zinc-900 text-white rounded hover:bg-zinc-800" disabled={login.isPending}>
              {login.isPending ? 'Signing in…' : 'Sign in'}
            </button>
            {err && <div className="text-sm text-red-600">{err}</div>}
          </form>
        )}
        <div className="space-y-2">
          {providers.data?.google && (
            <a href="/auth/google/start" className="block w-full text-center px-3 py-2 border rounded hover:bg-zinc-100">Sign in with Google</a>
          )}
          {providers.data?.entra && (
            <a href="/auth/entra/start" className="block w-full text-center px-3 py-2 border rounded hover:bg-zinc-100">Sign in with Microsoft</a>
          )}
        </div>
      </div>
    </div>
  );
}
