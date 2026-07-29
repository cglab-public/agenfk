import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ProvidersResponse } from '../api';
import { buildSetupPayload, canSubmitSetup } from './setupSubmit';

export function SetupPage() {
  const providers = useQuery<ProvidersResponse>({
    queryKey: ['providers'],
    queryFn: async () => (await api.get('/auth/providers')).data,
  });
  const nav = useNavigate();
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const setup = useMutation({
    mutationFn: () => api.post('/setup/initial-admin', buildSetupPayload({ token, email, password })),
    onSuccess: () => nav('/login'),
    onError: (e: any) => setErr(e?.response?.data?.error ?? 'Setup failed'),
  });

  if (providers.data && !providers.data.requiresSetup) { nav('/login'); return null; }

  const submittable = canSubmitSetup({ token, email, password, isPending: setup.isPending });

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-canvas text-ink">
      <div className="w-full max-w-sm space-y-6 bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-6">
        <h1 className="text-xl font-semibold">First-run setup</h1>
        <p className="text-sm text-ink-tertiary">
          Paste the bootstrap token printed in the hub's startup logs, then create the initial admin account.
          After this, sign-in is gated by the providers you enable.
        </p>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setErr(null); setup.mutate(); }}>
          <input
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="bootstrap token (from hub startup logs)"
            autoComplete="off"
            spellCheck={false}
            className="w-full px-3 py-2 border border-border-soft rounded-lg bg-canvas text-ink font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand"
          />
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin email" className="w-full px-3 py-2 border border-border-soft rounded-lg bg-canvas text-ink focus:outline-none focus:ring-2 focus:ring-brand" />
          <input type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password (≥8 chars)" className="w-full px-3 py-2 border border-border-soft rounded-lg bg-canvas text-ink focus:outline-none focus:ring-2 focus:ring-brand" />
          <button type="submit" className="w-full px-3 py-2 bg-[image:var(--gradient-accent)] text-navy shadow-glow rounded-lg font-bold disabled:opacity-50" disabled={!submittable}>
            {setup.isPending ? 'Creating…' : 'Create admin'}
          </button>
          {err && <div className="text-sm text-danger-muted">{err}</div>}
        </form>
      </div>
    </div>
  );
}
