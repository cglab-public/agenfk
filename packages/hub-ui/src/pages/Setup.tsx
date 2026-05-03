import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ProvidersResponse } from '../api';

export function SetupPage() {
  const providers = useQuery<ProvidersResponse>({
    queryKey: ['providers'],
    queryFn: async () => (await api.get('/auth/providers')).data,
  });
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const setup = useMutation({
    mutationFn: () => api.post('/setup/initial-admin', { email, password }),
    onSuccess: () => nav('/login'),
    onError: (e: any) => setErr(e?.response?.data?.error ?? 'Setup failed'),
  });

  if (providers.data && !providers.data.requiresSetup) { nav('/login'); return null; }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <h1 className="text-xl font-semibold">First-run setup</h1>
        <p className="text-sm text-zinc-500">Create the initial admin account. After this, sign-in is gated by the providers you enable.</p>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setErr(null); setup.mutate(); }}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin email" className="w-full px-3 py-2 border rounded" />
          <input type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password (≥8 chars)" className="w-full px-3 py-2 border rounded" />
          <button type="submit" className="w-full px-3 py-2 bg-zinc-900 text-white rounded hover:bg-zinc-800" disabled={setup.isPending}>
            {setup.isPending ? 'Creating…' : 'Create admin'}
          </button>
          {err && <div className="text-sm text-red-600">{err}</div>}
        </form>
      </div>
    </div>
  );
}
