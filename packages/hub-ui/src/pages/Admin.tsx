import { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

export function AdminLayout() {
  const link = ({ isActive }: { isActive: boolean }) =>
    'px-3 py-1 rounded ' + (isActive ? 'bg-zinc-900 text-white' : 'hover:bg-zinc-100');
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <nav className="flex gap-2 text-sm">
        <NavLink to="auth" className={link}>Auth</NavLink>
        <NavLink to="keys" className={link}>API keys</NavLink>
        <NavLink to="users" className={link}>Users</NavLink>
      </nav>
      <Outlet />
    </div>
  );
}

interface AuthConfig {
  passwordEnabled: boolean; googleEnabled: boolean; entraEnabled: boolean;
  google: { clientId: string; clientSecretSet: boolean };
  entra: { tenantId: string; clientId: string; clientSecretSet: boolean };
  emailAllowlist: string[];
}

export function AdminAuth() {
  const qc = useQueryClient();
  const cfg = useQuery<AuthConfig>({ queryKey: ['auth-config'], queryFn: async () => (await api.get('/v1/admin/auth-config')).data });
  const save = useMutation({
    mutationFn: (body: any) => api.put('/v1/admin/auth-config', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth-config'] }),
  });
  const [draft, setDraft] = useState<any>({});
  if (!cfg.data) return null;
  const c = { ...cfg.data, ...draft };

  return (
    <form className="space-y-4 max-w-xl" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
      <fieldset className="border rounded p-3 space-y-2">
        <legend className="px-2 font-semibold">Email + password</legend>
        <Toggle label="Enable password sign-in" checked={c.passwordEnabled} onChange={(v) => setDraft({ ...draft, passwordEnabled: v })} />
      </fieldset>

      <fieldset className="border rounded p-3 space-y-2">
        <legend className="px-2 font-semibold">Google</legend>
        <Toggle label="Enable" checked={c.googleEnabled} onChange={(v) => setDraft({ ...draft, googleEnabled: v })} />
        <input className="w-full px-2 py-1 border rounded" placeholder="client_id" value={c.google.clientId} onChange={(e) => setDraft({ ...draft, google: { ...c.google, clientId: e.target.value } })} />
        <input className="w-full px-2 py-1 border rounded" type="password" placeholder={c.google.clientSecretSet ? '•••••• (leave blank to keep)' : 'client_secret'} onChange={(e) => setDraft({ ...draft, google: { ...c.google, clientSecret: e.target.value } })} />
      </fieldset>

      <fieldset className="border rounded p-3 space-y-2">
        <legend className="px-2 font-semibold">Microsoft Entra</legend>
        <Toggle label="Enable" checked={c.entraEnabled} onChange={(v) => setDraft({ ...draft, entraEnabled: v })} />
        <input className="w-full px-2 py-1 border rounded" placeholder="tenant_id" value={c.entra.tenantId} onChange={(e) => setDraft({ ...draft, entra: { ...c.entra, tenantId: e.target.value } })} />
        <input className="w-full px-2 py-1 border rounded" placeholder="client_id" value={c.entra.clientId} onChange={(e) => setDraft({ ...draft, entra: { ...c.entra, clientId: e.target.value } })} />
        <input className="w-full px-2 py-1 border rounded" type="password" placeholder={c.entra.clientSecretSet ? '•••••• (leave blank to keep)' : 'client_secret'} onChange={(e) => setDraft({ ...draft, entra: { ...c.entra, clientSecret: e.target.value } })} />
      </fieldset>

      <fieldset className="border rounded p-3 space-y-2">
        <legend className="px-2 font-semibold">Email allowlist</legend>
        <input className="w-full px-2 py-1 border rounded" placeholder='comma-separated, e.g. "acme.com, *.subsidiary.com"'
               defaultValue={c.emailAllowlist.join(', ')}
               onBlur={(e) => setDraft({ ...draft, emailAllowlist: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
      </fieldset>

      <button type="submit" className="px-3 py-2 bg-zinc-900 text-white rounded">Save</button>
    </form>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

interface KeyRow { tokenHashPreview: string; label: string | null; createdAt: string; revokedAt: string | null }

export function AdminKeys() {
  const qc = useQueryClient();
  const keys = useQuery<KeyRow[]>({ queryKey: ['api-keys'], queryFn: async () => (await api.get('/v1/admin/api-keys')).data });
  const create = useMutation({
    mutationFn: (label: string) => api.post('/v1/admin/api-keys', { label }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });
  const revoke = useMutation({
    mutationFn: (preview: string) => api.delete(`/v1/admin/api-keys/${preview}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });
  const createInvite = useMutation({
    mutationFn: () => api.post('/hub/invite/create'),
  });
  const [label, setLabel] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ joinCommand: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-6 max-w-2xl">
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Magic-link invite</h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Generate a single-use, signed join command developers can paste into their terminal. They never see the underlying token.
        </p>
        <button
          onClick={async () => {
            const r = await createInvite.mutateAsync();
            setInvite(r.data as any);
            setCopied(false);
          }}
          disabled={createInvite.isPending}
          className="mt-3 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
        >
          {createInvite.isPending ? 'Generating…' : 'Generate invite'}
        </button>
        {invite && (
          <div className="mt-4 rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50/60 dark:bg-indigo-900/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-[0.14em] text-indigo-600 dark:text-indigo-400 font-semibold">Share this command</span>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">expires {new Date(invite.expiresAt).toLocaleDateString()}</span>
            </div>
            <pre className="mt-2 px-3 py-2 rounded-lg bg-slate-900 text-slate-100 text-xs font-mono overflow-x-auto select-all">{invite.joinCommand}</pre>
            <button
              onClick={async () => {
                try { await navigator.clipboard.writeText(invite.joinCommand); setCopied(true); } catch { /* ignore */ }
              }}
              className="mt-2 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              {copied ? '✓ Copied' : 'Copy to clipboard'}
            </button>
          </div>
        )}
      </section>

      <form className="flex gap-2" onSubmit={async (e) => {
        e.preventDefault();
        const r = await create.mutateAsync(label);
        setIssued((r.data as any).token);
        setLabel('');
      }}>
        <input className="flex-1 px-2 py-1 border rounded" placeholder="label (e.g. laptop-alice)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit" className="px-3 py-1 bg-zinc-900 text-white rounded">Issue key</button>
      </form>
      {issued && (
        <div className="border rounded p-3 bg-yellow-50 text-yellow-900 text-sm">
          Save this token now — it will not be shown again:
          <pre className="mt-1 break-all font-mono">{issued}</pre>
          <button className="mt-2 underline text-xs" onClick={() => setIssued(null)}>I&apos;ve saved it</button>
        </div>
      )}
      <table className="w-full text-sm">
        <thead><tr className="text-left text-zinc-500"><th>Preview</th><th>Label</th><th>Created</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {(keys.data ?? []).map(k => (
            <tr key={k.tokenHashPreview} className="border-t">
              <td className="font-mono">{k.tokenHashPreview}…</td>
              <td>{k.label ?? '—'}</td>
              <td>{k.createdAt}</td>
              <td>{k.revokedAt ? 'revoked' : 'active'}</td>
              <td>{!k.revokedAt && <button className="text-red-600 hover:underline" onClick={() => revoke.mutate(k.tokenHashPreview)}>Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface UserRow { id: string; email: string; provider: string; role: string; active: number; created_at: string; last_login_at: string | null }

export function AdminUsers() {
  const qc = useQueryClient();
  const users = useQuery<UserRow[]>({ queryKey: ['admin-users'], queryFn: async () => (await api.get('/v1/admin/users')).data });
  const invite = useMutation({
    mutationFn: (body: any) => api.post('/v1/admin/users/invite', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
  const update = useMutation({
    mutationFn: ({ id, ...rest }: any) => api.put(`/v1/admin/users/${id}`, rest),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
  const [draft, setDraft] = useState({ email: '', password: '', role: 'viewer' });

  return (
    <div className="space-y-4 max-w-xl">
      <form className="grid grid-cols-4 gap-2" onSubmit={(e) => { e.preventDefault(); invite.mutate(draft); setDraft({ email: '', password: '', role: 'viewer' }); }}>
        <input className="col-span-2 px-2 py-1 border rounded" placeholder="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
        <input className="px-2 py-1 border rounded" type="password" placeholder="password (≥8)" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
        <select className="px-2 py-1 border rounded" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
          <option value="viewer">viewer</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit" className="col-span-4 px-3 py-1 bg-zinc-900 text-white rounded">Invite</button>
      </form>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-zinc-500"><th>Email</th><th>Provider</th><th>Role</th><th>Active</th></tr></thead>
        <tbody>
          {(users.data ?? []).map(u => (
            <tr key={u.id} className="border-t">
              <td>{u.email}</td>
              <td>{u.provider}</td>
              <td>
                <select value={u.role} onChange={(e) => update.mutate({ id: u.id, role: e.target.value })} className="bg-transparent">
                  <option value="viewer">viewer</option>
                  <option value="admin">admin</option>
                </select>
              </td>
              <td>
                <input type="checkbox" checked={!!u.active} onChange={(e) => update.mutate({ id: u.id, active: e.target.checked })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
