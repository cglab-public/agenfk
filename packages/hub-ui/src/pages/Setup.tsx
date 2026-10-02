import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ProvidersResponse } from '../api';
import { buildSetupPayload, canSubmitSetup } from './setupSubmit';
import { Logo } from '../components/Logo';
import { Button, Field, Input } from '../components/ui';
import type { LoginNotice } from './Login';

export function SetupPage() {
  const providers = useQuery<ProvidersResponse>({
    queryKey: ['providers'],
    queryFn: async () => (await api.get('/auth/providers')).data,
  });
  const nav = useNavigate();
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const setup = useMutation({
    mutationFn: () => api.post('/setup/initial-admin', buildSetupPayload({ token, email, password })),
    onSuccess: () => {
      // The cached providers still say setup is required; left alone, the
      // sign-in page would bounce straight back here and lose the notice.
      qc.setQueryData<ProvidersResponse>(['providers'], (d) => d && { ...d, requiresSetup: false });
      nav('/login', { replace: true, state: { notice: 'admin-created' satisfies LoginNotice } });
    },
    onError: (e: any) => setErr(e?.response?.data?.error ?? 'Setup failed'),
  });

  const setupDone = !!providers.data && !providers.data.requiresSetup;
  useEffect(() => { if (setupDone && !setup.isSuccess) nav('/login'); }, [setupDone, setup.isSuccess, nav]);
  if (setupDone) return null;

  const submittable = canSubmitSetup({ token, email, password, isPending: setup.isPending });

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-canvas text-ink">
      <div className="w-full max-w-sm space-y-6 bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-6">
        <Logo />
        <h1 className="text-title font-semibold">First-run setup</h1>
        <p className="text-body text-ink-tertiary">
          Paste the bootstrap token printed in the hub's startup logs, then create the initial admin account.
          After this, sign-in is gated by the providers you enable.
        </p>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setErr(null); setup.mutate(); }}>
          <Field label="Bootstrap token" hint="Printed in the hub's startup logs.">
            <Input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          <Field label="Admin email">
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" hint="At least 8 characters.">
            <Input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" className="w-full" disabled={!submittable}>
            {setup.isPending ? 'Creating…' : 'Create admin'}
          </Button>
          {err && <div role="alert" className="text-body text-danger-text">{err}</div>}
        </form>
      </div>
    </div>
  );
}
