import { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, KeyRound, Users, Trash2, Copy, Check, GitBranch, ArrowUpCircle, Server, Building2, X, EyeOff, Eye } from 'lucide-react';
import { api } from '../api';
import { fmtDate } from '../dates';
import { canDeleteUserRow } from './canDeleteUserRow';
import { hideTargetKey, partitionHiddenRows, canHideRow } from './hiddenPeople';

export function AdminLayout() {
  const link = ({ isActive }: { isActive: boolean }) =>
    'px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors ' + (isActive
      ? 'bg-[image:var(--gradient-accent)] text-navy shadow-glow'
      : 'text-ink-secondary hover:bg-chip');
  return (
    <div className="max-w-[1100px] mx-auto space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.18em] text-accent-text font-semibold">Settings</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">Admin</h1>
        <p className="mt-1 text-sm text-ink-tertiary">Configure sign-in providers, distribute installation tokens, and manage organization users.</p>
      </header>

      <nav className="inline-flex p-1 rounded-xl border border-border-soft bg-surface">
        <NavLink to="auth" className={link}>
          <span className="inline-flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> Auth</span>
        </NavLink>
        <NavLink to="keys" className={link}>
          <span className="inline-flex items-center gap-1.5"><KeyRound className="w-3.5 h-3.5" /> API keys</span>
        </NavLink>
        <NavLink to="users" className={link}>
          <span className="inline-flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> Users</span>
        </NavLink>
        <NavLink to="flows" className={link}>
          <span className="inline-flex items-center gap-1.5"><GitBranch className="w-3.5 h-3.5" /> Flows</span>
        </NavLink>
        <NavLink to="upgrades" className={link}>
          <span className="inline-flex items-center gap-1.5"><ArrowUpCircle className="w-3.5 h-3.5" /> Upgrades</span>
        </NavLink>
        <NavLink to="installations" className={link}>
          <span className="inline-flex items-center gap-1.5"><Server className="w-3.5 h-3.5" /> Installations</span>
        </NavLink>
        <NavLink to="org" className={link}>
          <span className="inline-flex items-center gap-1.5"><Building2 className="w-3.5 h-3.5" /> Organization</span>
        </NavLink>
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

const inputCls = 'w-full px-3 py-2 rounded-lg border border-border-soft bg-chip text-ink dark:text-white text-sm placeholder:text-ink-tertiary focus:outline-none focus:ring-2 focus:ring-brand';
const cardCls = 'bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5';
const primaryBtnCls = 'px-4 py-2 rounded-lg bg-[image:var(--gradient-accent)] text-navy shadow-glow disabled:opacity-50 text-sm font-bold transition-colors';

export function AdminAuth() {
  const qc = useQueryClient();
  const cfg = useQuery<AuthConfig>({ queryKey: ['auth-config'], queryFn: async () => (await api.get('/v1/admin/auth-config')).data });
  const save = useMutation({
    mutationFn: (body: any) => api.put('/v1/admin/auth-config', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth-config'] }),
  });
  const [draft, setDraft] = useState<any>({});
  if (!cfg.data) return <div className="text-sm text-ink-tertiary">Loading…</div>;
  const c = { ...cfg.data, ...draft };

  return (
    <form className="space-y-4 max-w-2xl" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
      <section className={cardCls}>
        <header className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Email + password</h3>
          <Toggle checked={c.passwordEnabled} onChange={(v) => setDraft({ ...draft, passwordEnabled: v })} />
        </header>
        <p className="mt-1 text-xs text-ink-tertiary">Allow users to sign in with email and a hashed password stored on this hub.</p>
      </section>

      <section className={cardCls}>
        <header className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink">Google</h3>
            <p className="mt-0.5 text-xs text-ink-tertiary">OAuth 2.0 sign-in with Google Workspace or consumer accounts.</p>
          </div>
          <Toggle checked={c.googleEnabled} onChange={(v) => setDraft({ ...draft, googleEnabled: v })} />
        </header>
        <div className="mt-4 grid sm:grid-cols-2 gap-3">
          <Field label="Client ID">
            <input className={inputCls} placeholder="123…apps.googleusercontent.com" value={c.google.clientId} onChange={(e) => setDraft({ ...draft, google: { ...c.google, clientId: e.target.value } })} />
          </Field>
          <Field label="Client secret">
            <input className={inputCls} type="password" placeholder={c.google.clientSecretSet ? '•••••• (leave blank to keep)' : 'GOCSPX-…'} onChange={(e) => setDraft({ ...draft, google: { ...c.google, clientSecret: e.target.value } })} />
          </Field>
        </div>
      </section>

      <section className={cardCls}>
        <header className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink">Microsoft Entra</h3>
            <p className="mt-0.5 text-xs text-ink-tertiary">OAuth 2.0 sign-in via Azure AD / Entra ID tenants.</p>
          </div>
          <Toggle checked={c.entraEnabled} onChange={(v) => setDraft({ ...draft, entraEnabled: v })} />
        </header>
        <div className="mt-4 grid sm:grid-cols-2 gap-3">
          <Field label="Tenant ID">
            <input className={inputCls} placeholder="common, organizations, or tenant GUID" value={c.entra.tenantId} onChange={(e) => setDraft({ ...draft, entra: { ...c.entra, tenantId: e.target.value } })} />
          </Field>
          <Field label="Client ID">
            <input className={inputCls} placeholder="application (client) ID" value={c.entra.clientId} onChange={(e) => setDraft({ ...draft, entra: { ...c.entra, clientId: e.target.value } })} />
          </Field>
          <Field label="Client secret" className="sm:col-span-2">
            <input className={inputCls} type="password" placeholder={c.entra.clientSecretSet ? '•••••• (leave blank to keep)' : 'client secret value'} onChange={(e) => setDraft({ ...draft, entra: { ...c.entra, clientSecret: e.target.value } })} />
          </Field>
        </div>
      </section>

      <section className={cardCls}>
        <h3 className="text-sm font-semibold text-ink">Email allowlist</h3>
        <p className="mt-1 text-xs text-ink-tertiary">Comma-separated domains. Only addresses ending in these domains may sign in. Leave empty to accept any.</p>
        <input className={`${inputCls} mt-3 font-mono text-xs`}
               placeholder='acme.com, *.subsidiary.com'
               defaultValue={c.emailAllowlist.join(', ')}
               onBlur={(e) => setDraft({ ...draft, emailAllowlist: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
      </section>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={save.isPending} className={primaryBtnCls}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>
        {save.isSuccess && <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">✓ Saved</span>}
        {save.isError && <span className="text-xs text-rose-600 dark:text-rose-400 font-medium">Error: {(save.error as any)?.message}</span>}
      </div>
    </form>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="text-[11px] uppercase tracking-[0.14em] font-semibold text-ink-tertiary">{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-5 rounded-full transition-colors ${checked ? 'bg-brand' : 'bg-border-soft'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-surface shadow-sm transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </button>
  );
}

interface KeyRow {
  tokenHashPreview: string;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
  installationId?: string | null;
  osUser?: string | null;
  gitName?: string | null;
  gitEmail?: string | null;
}

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
  const [issuedCopied, setIssuedCopied] = useState(false);
  interface InviteEntry { id: string; joinCommand: string; expiresAt: string; copied: boolean }
  const [invites, setInvites] = useState<InviteEntry[]>([]);

  return (
    <div className="space-y-6">
      <section className={`${cardCls} max-w-2xl`}>
        <header className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[image:var(--gradient-accent)] text-navy flex items-center justify-center">
            <KeyRound className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink">Magic-link invite</h3>
            <p className="mt-0.5 text-xs text-ink-tertiary">Generate a single-use, signed join command. Developers paste it into their terminal — they never see the token.</p>
          </div>
        </header>
        <button
          onClick={async () => {
            const r = await createInvite.mutateAsync();
            const data = r.data as { joinCommand: string; expiresAt: string };
            setInvites(prev => [
              ...prev,
              { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, joinCommand: data.joinCommand, expiresAt: data.expiresAt, copied: false },
            ]);
          }}
          disabled={createInvite.isPending}
          className={`mt-4 ${primaryBtnCls}`}
        >
          {createInvite.isPending ? 'Generating…' : invites.length === 0 ? 'Generate invite' : 'Generate another invite'}
        </button>
        {invites.length > 0 && (
          <div className="mt-4 space-y-3">
            {invites.map((inv, idx) => (
              <div key={inv.id} className="rounded-xl border border-border-brand bg-chip p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] uppercase tracking-[0.14em] text-accent-text font-semibold">
                    Share this command{invites.length > 1 ? ` · #${idx + 1}` : ''}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="text-[11px] text-ink-tertiary">expires {fmtDate(inv.expiresAt)}</span>
                    <button
                      onClick={() => setInvites(prev => prev.filter(p => p.id !== inv.id))}
                      title="Dismiss"
                      className="text-ink-tertiary hover:text-rose-600 dark:hover:text-rose-400"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <pre className="mt-2 px-3 py-2.5 rounded-lg bg-card-glass text-ink text-xs font-mono overflow-x-auto select-all">{inv.joinCommand}</pre>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(inv.joinCommand);
                      setInvites(prev => prev.map(p => p.id === inv.id ? { ...p, copied: true } : p));
                    } catch { /* ignore */ }
                  }}
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-accent-text hover:underline"
                >
                  {inv.copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {inv.copied ? 'Copied' : 'Copy to clipboard'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={`${cardCls} max-w-2xl`}>
        <header>
          <h3 className="text-sm font-semibold text-ink">Issue an API key</h3>
          <p className="mt-0.5 text-xs text-ink-tertiary">Manual installation token for legacy / scripted workflows. Prefer magic-link invites for human onboarding.</p>
        </header>
        <form className="mt-3 flex flex-col sm:flex-row gap-2" onSubmit={async (e) => {
          e.preventDefault();
          const r = await create.mutateAsync(label);
          setIssued((r.data as any).token);
          setIssuedCopied(false);
          setLabel('');
        }}>
          <input className={`${inputCls} flex-1`} placeholder="Label, e.g. laptop-alice" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button type="submit" className={primaryBtnCls}>Issue key</button>
        </form>
        {issued && (
          <div className="mt-3 rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-900/20 p-4">
            <div className="text-[11px] uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300 font-semibold">Save this token now — it won't be shown again</div>
            <pre className="mt-2 px-3 py-2.5 rounded-lg bg-card-glass text-ink text-xs font-mono break-all overflow-x-auto select-all">{issued}</pre>
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={async () => { try { await navigator.clipboard.writeText(issued); setIssuedCopied(true); } catch { /* ignore */ } }}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent-text hover:underline"
              >
                {issuedCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {issuedCopied ? 'Copied' : 'Copy'}
              </button>
              <button onClick={() => setIssued(null)} className="text-xs font-medium text-ink-tertiary hover:text-ink">I've saved it</button>
            </div>
          </div>
        )}
      </section>

      <section className={cardCls}>
        <header className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Active keys</h3>
          <span className="text-[11px] text-ink-tertiary">{(keys.data ?? []).filter(k => !k.revokedAt).length} active · {(keys.data ?? []).length} total</span>
        </header>
        <div className="mt-3 -mx-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-tertiary font-semibold">
                <th className="text-left px-5 py-2">Preview</th>
                <th className="text-left px-2 py-2">Label</th>
                <th className="text-left px-2 py-2">Installation</th>
                <th className="text-left px-2 py-2">Created</th>
                <th className="text-left px-2 py-2">Status</th>
                <th className="text-right px-5 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-soft">
              {(keys.data ?? []).map(k => {
                const ident = k.gitEmail ?? k.osUser;
                return (
                <tr key={k.tokenHashPreview} className="hover:bg-chip transition-colors">
                  <td className="px-5 py-2.5 font-mono text-xs text-ink-secondary">{k.tokenHashPreview}…</td>
                  <td className="px-2 py-2.5 text-ink-secondary">{k.label ?? <span className="text-ink-tertiary">—</span>}</td>
                  <td className="px-2 py-2.5 text-xs text-ink-secondary">
                    {ident ? (
                      <span className="font-mono" title={k.installationId ? `installation: ${k.installationId}` : undefined}>
                        {ident}
                        {k.installationId && (
                          <span className="ml-1 text-ink-tertiary">· {k.installationId.slice(0, 8)}…</span>
                        )}
                      </span>
                    ) : k.installationId ? (
                      <span className="font-mono text-ink-tertiary" title={k.installationId}>{k.installationId.slice(0, 8)}…</span>
                    ) : (
                      <span className="text-ink-tertiary">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-xs text-ink-tertiary tabular-nums">{fmtDate(k.createdAt)}</td>
                  <td className="px-2 py-2.5">
                    {k.revokedAt
                      ? <span className="px-2 py-0.5 rounded-md text-[10px] font-mono bg-rose-50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800">revoked</span>
                      : <span className="px-2 py-0.5 rounded-md text-[10px] font-mono bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">active</span>}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {!k.revokedAt && (
                      <button onClick={() => revoke.mutate(k.tokenHashPreview)}
                              className="inline-flex items-center gap-1 text-xs font-semibold text-ink-tertiary hover:text-rose-600 dark:hover:text-rose-400">
                        <Trash2 className="w-3 h-3" /> Revoke
                      </button>
                    )}
                  </td>
                </tr>
                );
              })}
              {keys.data?.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-6 text-center text-sm text-ink-tertiary">No keys yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

interface UserRow { id: string; email: string; provider: string; role: string; active: number; created_at: string; last_login_at: string | null }

const PROVIDER_BADGE: Record<string, string> = {
  password: 'bg-chip text-ink-secondary border-border-soft',
  google:   'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  entra:    'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300 border-cyan-200 dark:border-cyan-800',
};

export function AdminUsers() {
  const qc = useQueryClient();
  const users = useQuery<UserRow[]>({ queryKey: ['admin-users'], queryFn: async () => (await api.get('/v1/admin/users')).data });
  const me = useQuery<{ userId: string }>({ queryKey: ['auth-me'], queryFn: async () => (await api.get('/auth/me')).data });
  const invite = useMutation({
    mutationFn: (body: any) => api.post('/v1/admin/users/invite', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
  const update = useMutation({
    mutationFn: ({ id, ...rest }: any) => api.put(`/v1/admin/users/${id}`, rest),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/admin/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
  const [draft, setDraft] = useState<{ email: string; password: string; role: string; authMethod: 'password' | 'sso' }>({ email: '', password: '', role: 'viewer', authMethod: 'password' });

  return (
    <div className="space-y-6">
      <section className={`${cardCls} max-w-2xl`}>
        <header>
          <h3 className="text-sm font-semibold text-ink">Invite user</h3>
          <p className="mt-0.5 text-xs text-ink-tertiary">Only invited users can sign in — SSO does not auto-create accounts. Choose <strong>Password</strong> for an email + password login, or <strong>SSO only</strong> to require Google/Entra sign-in for the same email.</p>
        </header>
        <form
          className="mt-4 grid sm:grid-cols-12 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const body: any = { email: draft.email, role: draft.role };
            if (draft.authMethod === 'password') body.password = draft.password;
            invite.mutate(body);
            setDraft({ email: '', password: '', role: 'viewer', authMethod: draft.authMethod });
          }}
        >
          <Field label="Auth method" className="sm:col-span-12">
            <div className="inline-flex p-1 rounded-lg border border-border-soft bg-chip">
              {(['password', 'sso'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setDraft({ ...draft, authMethod: m, password: m === 'sso' ? '' : draft.password })}
                  className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${draft.authMethod === m ? 'bg-surface text-accent-text shadow-sm' : 'text-ink-tertiary hover:text-ink'}`}
                >
                  {m === 'password' ? 'Password' : 'SSO only'}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Email" className={draft.authMethod === 'password' ? 'sm:col-span-5' : 'sm:col-span-9'}>
            <input className={inputCls} placeholder="alice@acme.com" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
          </Field>
          {draft.authMethod === 'password' && (
            <Field label="Password" className="sm:col-span-4">
              <input className={inputCls} type="password" placeholder="≥ 8 characters" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
            </Field>
          )}
          <Field label="Role" className="sm:col-span-3">
            <select className={inputCls} value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
              <option value="viewer">viewer</option>
              <option value="admin">admin</option>
            </select>
          </Field>
          <div className="sm:col-span-12">
            <button type="submit" disabled={invite.isPending} className={primaryBtnCls}>
              {invite.isPending ? 'Inviting…' : 'Invite user'}
            </button>
          </div>
        </form>
      </section>

      <section className={cardCls}>
        <header className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Users</h3>
          <span className="text-[11px] text-ink-tertiary">{users.data?.length ?? 0} total</span>
        </header>
        <div className="mt-3 -mx-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-tertiary font-semibold">
                <th className="text-left px-5 py-2">Email</th>
                <th className="text-left px-2 py-2">Provider</th>
                <th className="text-left px-2 py-2">Role</th>
                <th className="text-left px-2 py-2">Last login</th>
                <th className="text-right px-2 py-2">Active</th>
                <th className="text-right px-5 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-soft">
              {(users.data ?? []).map(u => (
                <tr key={u.id} className="hover:bg-chip transition-colors">
                  <td className="px-5 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-[image:var(--gradient-accent)] text-navy text-[10px] font-bold flex items-center justify-center shrink-0">
                        {u.email.slice(0, 2).toUpperCase()}
                      </div>
                      <span className="font-mono text-xs text-ink-secondary">{u.email}</span>
                    </div>
                  </td>
                  <td className="px-2 py-2.5">
                    <span className={`px-2 py-0.5 rounded-md text-[10px] font-mono border ${PROVIDER_BADGE[u.provider] ?? PROVIDER_BADGE.password}`}>{u.provider}</span>
                  </td>
                  <td className="px-2 py-2.5">
                    <select
                      value={u.role}
                      onChange={(e) => update.mutate({ id: u.id, role: e.target.value })}
                      className="bg-transparent text-xs font-medium text-ink-secondary hover:bg-chip rounded-md px-1.5 py-0.5"
                    >
                      <option value="viewer">viewer</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="px-2 py-2.5 text-xs text-ink-tertiary tabular-nums">{u.last_login_at ? fmtDate(u.last_login_at) : <span className="text-ink-tertiary">never</span>}</td>
                  <td className="px-2 py-2.5 text-right">
                    <Toggle checked={!!u.active} onChange={(v) => update.mutate({ id: u.id, active: v })} />
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {canDeleteUserRow(u.id, me.data?.userId) && (
                      <button
                        onClick={() => {
                          if (window.confirm(`Permanently delete ${u.email}? This cannot be undone.`)) {
                            remove.mutate(u.id);
                          }
                        }}
                        disabled={remove.isPending}
                        title="Delete user"
                        className="inline-flex items-center gap-1 text-xs font-semibold text-ink-tertiary hover:text-rose-600 dark:hover:text-rose-400 disabled:opacity-50"
                      >
                        <Trash2 className="w-3 h-3" /> Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {users.data?.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-6 text-center text-sm text-ink-tertiary">No users yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

interface InstallationRow {
  id: string;
  agenfkVersion: string | null;
  agenfkVersionUpdatedAt: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  osUser: string | null;
  gitName: string | null;
  gitEmail: string | null;
  hidden?: boolean;
}

interface HiddenPersonRow {
  userKey: string;
  hiddenByEmail: string | null;
  createdAt: string;
}

export function AdminInstallations() {
  const qc = useQueryClient();
  // CGLAB-31: hidden people are excluded server-side by default; the toggle
  // re-fetches with ?includeHidden=1 and flags them inline.
  const [showHidden, setShowHidden] = useState(false);
  const installations = useQuery<InstallationRow[]>({
    queryKey: ['admin-installations', showHidden],
    queryFn: async () =>
      (await api.get(showHidden ? '/v1/admin/installations?includeHidden=1' : '/v1/admin/installations')).data,
  });
  const hiddenPeople = useQuery<HiddenPersonRow[]>({
    queryKey: ['admin-hidden-users'],
    queryFn: async () => (await api.get('/v1/admin/hidden-users')).data,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-installations'] });
    qc.invalidateQueries({ queryKey: ['admin-hidden-users'] });
    qc.invalidateQueries({ queryKey: ['api-keys'] });
  };
  const hide = useMutation({
    mutationFn: (userKey: string) => api.post('/v1/admin/hidden-users', { userKey }),
    onSuccess: invalidate,
  });
  const unhide = useMutation({
    mutationFn: (userKey: string) => api.delete(`/v1/admin/hidden-users/${encodeURIComponent(userKey)}`),
    onSuccess: invalidate,
  });

  const rows = installations.data ?? [];
  const { visible, hidden: hiddenRows } = partitionHiddenRows(rows);
  const hiddenCount = hiddenPeople.data?.length ?? hiddenRows.length;

  return (
    <div className="space-y-6">
      <section className={cardCls}>
        <header className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink">Installations</h3>
            <p className="mt-0.5 text-xs text-ink-tertiary">
              Every AgEnFK install that has reported events to this hub. Use this to audit which version is running where.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {hiddenCount > 0 && (
              <button
                onClick={() => setShowHidden(v => !v)}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-tertiary hover:text-ink"
              >
                {showHidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                {showHidden ? 'Hide hidden' : `Show hidden (${hiddenCount})`}
              </button>
            )}
            <span className="text-[11px] text-ink-tertiary">{showHidden ? rows.length : visible.length} total</span>
          </div>
        </header>
        <div className="mt-3 -mx-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-tertiary font-semibold">
                <th className="text-left px-5 py-2">Installation</th>
                <th className="text-left px-2 py-2">User</th>
                <th className="text-left px-2 py-2">Version</th>
                <th className="text-left px-2 py-2">Version updated</th>
                <th className="text-right px-5 py-2">Last seen</th>
                <th className="text-right px-5 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-soft">
              {rows.map(r => (
                <tr key={r.id} className={`hover:bg-chip transition-colors ${r.hidden ? 'opacity-50' : ''}`}>
                  <td className="px-5 py-2.5">
                    <span className="font-mono text-[11px] text-ink-secondary">{r.id}</span>
                    {r.hidden && (
                      <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">hidden</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5">
                    <div className="text-xs text-ink-secondary">{r.gitName ?? r.osUser ?? <span className="text-ink-tertiary">—</span>}</div>
                    {r.gitEmail && <div className="text-[11px] text-ink-tertiary font-mono">{r.gitEmail}</div>}
                  </td>
                  <td className="px-2 py-2.5">
                    {r.agenfkVersion
                      ? <span className="font-mono text-[11px] px-2 py-0.5 rounded-md border border-border-brand bg-chip text-accent-text">{r.agenfkVersion}</span>
                      : <span className="text-[11px] text-ink-tertiary italic">unknown</span>}
                  </td>
                  <td className="px-2 py-2.5 text-xs text-ink-tertiary tabular-nums">
                    {r.agenfkVersionUpdatedAt ? fmtDate(r.agenfkVersionUpdatedAt) : <span className="text-ink-tertiary">—</span>}
                  </td>
                  <td className="px-5 py-2.5 text-right text-xs text-ink-tertiary tabular-nums">
                    {r.lastSeen ? fmtDate(r.lastSeen) : <span className="text-ink-tertiary">—</span>}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {canHideRow(r) && (
                      <button
                        onClick={() => {
                          const key = hideTargetKey(r);
                          if (!key) return;
                          if (confirm(`Hide ${key}? Their installations disappear from pickers, their API keys are revoked, and new events are dropped. Historical data stays visible. This is reversible.`)) {
                            hide.mutate(key);
                          }
                        }}
                        disabled={hide.isPending}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-tertiary hover:text-amber-600 dark:hover:text-amber-400"
                        title="Hide this person from selection surfaces"
                      >
                        <EyeOff className="w-3.5 h-3.5" /> Hide
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-6 text-center text-sm text-ink-tertiary">No installations have reported yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {(hiddenPeople.data?.length ?? 0) > 0 && (
        <section className={cardCls}>
          <header>
            <h3 className="text-sm font-semibold text-ink">Hidden people</h3>
            <p className="mt-0.5 text-xs text-ink-tertiary">
              Hidden people no longer appear in installation pickers, their API keys are revoked, and new events from them are dropped. Historical dashboards are unaffected. Unhiding restores visibility but does not restore revoked keys.
            </p>
          </header>
          <ul className="mt-3 divide-y divide-border-soft">
            {hiddenPeople.data!.map(p => (
              <li key={p.userKey} className="flex items-center justify-between py-2">
                <div>
                  <div className="font-mono text-xs text-ink-secondary">{p.userKey}</div>
                  <div className="text-[11px] text-ink-tertiary">
                    hidden {fmtDate(p.createdAt)}{p.hiddenByEmail ? ` by ${p.hiddenByEmail}` : ''}
                  </div>
                </div>
                <button
                  onClick={() => unhide.mutate(p.userKey)}
                  disabled={unhide.isPending}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent-text hover:opacity-80"
                >
                  <Eye className="w-3.5 h-3.5" /> Unhide
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
