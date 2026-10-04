import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Logo } from '../components/Logo';
import { Button, Field, Input } from '../components/ui';

const MIN_PASSWORD_LENGTH = 8;

/**
 * Admin recovery (STORY a44f3697): where an operator pastes the token the hub
 * logged at boot for the admin AGENFK_HUB_RESET_ADMIN_EMAIL names. Redeeming
 * it sets that admin's password and signs them in, so they land on
 * Admin → Sign-in to repair what locked everyone out.
 */
export function RecoverPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const recover = useMutation({
    mutationFn: () => api.post('/auth/recover', { token: token.trim(), password }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav('/admin/auth', { replace: true });
    },
    onError: (e: any) => setErr(e?.response?.data?.error ?? 'Recovery failed'),
  });
  const submittable = token.trim().length > 0 && password.length >= MIN_PASSWORD_LENGTH && !recover.isPending;

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-canvas text-ink">
      <div className="w-full max-w-sm space-y-6 bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-6">
        <Logo />
        <h1 className="text-title font-semibold">Recover admin access</h1>
        <p className="text-body text-ink-tertiary">
          For when sign-in is broken for every admin. Restart the hub with <code className="font-mono">AGENFK_HUB_RESET_ADMIN_EMAIL</code> set
          to an admin's email: it prints a one-time recovery token in its startup logs. Paste it here with a new password for that admin.
        </p>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setErr(null); recover.mutate(); }}>
          <Field label="Recovery token" hint="Printed in the hub's startup logs. Works once, for an hour.">
            <Input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          <Field label="New password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
            <Input type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" className="w-full" disabled={!submittable}>
            {recover.isPending ? 'Recovering…' : 'Recover access'}
          </Button>
          {err && <div role="alert" className="text-body text-danger-text">{err}</div>}
        </form>
      </div>
    </div>
  );
}
