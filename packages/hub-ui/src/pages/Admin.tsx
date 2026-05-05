import { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, KeyRound, Users, Trash2, Copy, Check, GitBranch, ArrowUpCircle } from 'lucide-react';
import { api } from '../api';
import { fmtDate } from '../dates';

export function AdminLayout() {
  const link = ({ isActive }: { isActive: boolean }) =>
    'px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors ' + (isActive
      ? 'bg-indigo-600 text-white shadow-sm'
      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800');
  return (
    <div className="max-w-[1100px] mx-auto space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.18em] text-indigo-600 dark:text-indigo-400 font-semibold">Settings</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Admin</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Configure sign-in providers, distribute installation tokens, and manage organization users.</p>
      </header>

      <nav className="inline-flex p-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
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

const inputCls = 'w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500';
const cardCls = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5';
const primaryBtnCls = 'px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors';

export function AdminAuth() {
  const qc = useQueryClient();
  const cfg = useQuery<AuthConfig>({ queryKey: ['auth-config'], queryFn: async () => (await api.get('/v1/admin/auth-config')).data });
  const save = useMutation({
    mutationFn: (body: any) => api.put('/v1/admin/auth-config', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth-config'] }),
  });
  const [draft, setDraft] = useState<any>({});
  if (!cfg.data) return <div className="text-sm text-slate-500">Loading…</div>;
  const c = { ...cfg.data, ...draft };

  return (
    <form className="space-y-4 max-w-2xl" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
      <section className={cardCls}>
        <header className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Email + password</h3>
          <Toggle checked={c.passwordEnabled} onChange={(v) => setDraft({ ...draft, passwordEnabled: v })} />
        </header>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Allow users to sign in with email and a hashed password stored on this hub.</p>
      </section>

      <section className={cardCls}>
        <header className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Google</h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">OAuth 2.0 sign-in with Google Workspace or consumer accounts.</p>
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
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Microsoft Entra</h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">OAuth 2.0 sign-in via Azure AD / Entra ID tenants.</p>
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
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Email allowlist</h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Comma-separated domains. Only addresses ending in these domains may sign in. Leave empty to accept any.</p>
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
      <span className="text-[11px] uppercase tracking-[0.14em] font-semibold text-slate-500 dark:text-slate-400">{label}</span>
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
      className={`relative w-10 h-5 rounded-full transition-colors ${checked ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-700'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-5' : ''}`} />
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
  const [invite, setInvite] = useState<{ joinCommand: string; expiresAt: string } | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  return (
    <div className="space-y-6">
      <section className={`${cardCls} max-w-2xl`}>
        <header className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white flex items-center justify-center">
            <KeyRound className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Magic-link invite</h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Generate a single-use, signed join command. Developers paste it into their terminal — they never see the token.</p>
          </div>
        </header>
        <button
          onClick={async () => {
            const r = await createInvite.mutateAsync();
            setInvite(r.data as any);
            setInviteCopied(false);
          }}
          disabled={createInvite.isPending}
          className={`mt-4 ${primaryBtnCls}`}
        >
          {createInvite.isPending ? 'Generating…' : 'Generate invite'}
        </button>
        {invite && (
          <div className="mt-4 rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50/60 dark:bg-indigo-900/20 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-[0.14em] text-indigo-700 dark:text-indigo-300 font-semibold">Share this command</span>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">expires {fmtDate(invite.expiresAt)}</span>
            </div>
            <pre className="mt-2 px-3 py-2.5 rounded-lg bg-slate-900 text-slate-100 text-xs font-mono overflow-x-auto select-all">{invite.joinCommand}</pre>
            <button
              onClick={async () => {
                try { await navigator.clipboard.writeText(invite.joinCommand); setInviteCopied(true); } catch { /* ignore */ }
              }}
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              {inviteCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {inviteCopied ? 'Copied' : 'Copy to clipboard'}
            </button>
          </div>
        )}
      </section>

      <section className={`${cardCls} max-w-2xl`}>
        <header>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Issue an API key</h3>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Manual installation token for legacy / scripted workflows. Prefer magic-link invites for human onboarding.</p>
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
            <pre className="mt-2 px-3 py-2.5 rounded-lg bg-slate-900 text-slate-100 text-xs font-mono break-all overflow-x-auto select-all">{issued}</pre>
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={async () => { try { await navigator.clipboard.writeText(issued); setIssuedCopied(true); } catch { /* ignore */ } }}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                {issuedCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {issuedCopied ? 'Copied' : 'Copy'}
              </button>
              <button onClick={() => setIssued(null)} className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">I've saved it</button>
            </div>
          </div>
        )}
      </section>

      <section className={cardCls}>
        <header className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Active keys</h3>
          <span className="text-[11px] text-slate-500">{(keys.data ?? []).filter(k => !k.revokedAt).length} active · {(keys.data ?? []).length} total</span>
        </header>
        <div className="mt-3 -mx-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500 font-semibold">
                <th className="text-left px-5 py-2">Preview</th>
                <th className="text-left px-2 py-2">Label</th>
                <th className="text-left px-2 py-2">Installation</th>
                <th className="text-left px-2 py-2">Created</th>
                <th className="text-left px-2 py-2">Status</th>
                <th className="text-right px-5 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {(keys.data ?? []).map(k => {
                const ident = k.gitEmail ?? k.osUser;
                return (
                <tr key={k.tokenHashPreview} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                  <td className="px-5 py-2.5 font-mono text-xs text-slate-700 dark:text-slate-300">{k.tokenHashPreview}…</td>
                  <td className="px-2 py-2.5 text-slate-700 dark:text-slate-300">{k.label ?? <span className="text-slate-400">—</span>}</td>
                  <td className="px-2 py-2.5 text-xs text-slate-600 dark:text-slate-300">
                    {ident ? (
                      <span className="font-mono" title={k.installationId ? `installation: ${k.installationId}` : undefined}>
                        {ident}
                        {k.installationId && (
                          <span className="ml-1 text-slate-400 dark:text-slate-500">· {k.installationId.slice(0, 8)}…</span>
                        )}
                      </span>
                    ) : k.installationId ? (
                      <span className="font-mono text-slate-500" title={k.installationId}>{k.installationId.slice(0, 8)}…</span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-xs text-slate-500 tabular-nums">{fmtDate(k.createdAt)}</td>
                  <td className="px-2 py-2.5">
                    {k.revokedAt
                      ? <span className="px-2 py-0.5 rounded-md text-[10px] font-mono bg-rose-50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800">revoked</span>
                      : <span className="px-2 py-0.5 rounded-md text-[10px] font-mono bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">active</span>}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {!k.revokedAt && (
                      <button onClick={() => revoke.mutate(k.tokenHashPreview)}
                              className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-rose-600 dark:hover:text-rose-400">
                        <Trash2 className="w-3 h-3" /> Revoke
                      </button>
                    )}
                  </td>
                </tr>
                );
              })}
              {keys.data?.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-6 text-center text-sm text-slate-500">No keys yet.</td></tr>
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
  password: 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  google:   'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  entra:    'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300 border-cyan-200 dark:border-cyan-800',
};

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
    <div className="space-y-6">
      <section className={`${cardCls} max-w-2xl`}>
        <header>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Invite user</h3>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Create an account with email + password. They can switch to SSO later if enabled.</p>
        </header>
        <form className="mt-4 grid sm:grid-cols-12 gap-3" onSubmit={(e) => { e.preventDefault(); invite.mutate(draft); setDraft({ email: '', password: '', role: 'viewer' }); }}>
          <Field label="Email" className="sm:col-span-5">
            <input className={inputCls} placeholder="alice@acme.com" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
          </Field>
          <Field label="Password" className="sm:col-span-4">
            <input className={inputCls} type="password" placeholder="≥ 8 characters" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
          </Field>
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
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Users</h3>
          <span className="text-[11px] text-slate-500">{users.data?.length ?? 0} total</span>
        </header>
        <div className="mt-3 -mx-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500 font-semibold">
                <th className="text-left px-5 py-2">Email</th>
                <th className="text-left px-2 py-2">Provider</th>
                <th className="text-left px-2 py-2">Role</th>
                <th className="text-left px-2 py-2">Last login</th>
                <th className="text-right px-5 py-2">Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {(users.data ?? []).map(u => (
                <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                  <td className="px-5 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                        {u.email.slice(0, 2).toUpperCase()}
                      </div>
                      <span className="font-mono text-xs text-slate-700 dark:text-slate-200">{u.email}</span>
                    </div>
                  </td>
                  <td className="px-2 py-2.5">
                    <span className={`px-2 py-0.5 rounded-md text-[10px] font-mono border ${PROVIDER_BADGE[u.provider] ?? PROVIDER_BADGE.password}`}>{u.provider}</span>
                  </td>
                  <td className="px-2 py-2.5">
                    <select
                      value={u.role}
                      onChange={(e) => update.mutate({ id: u.id, role: e.target.value })}
                      className="bg-transparent text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md px-1.5 py-0.5"
                    >
                      <option value="viewer">viewer</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="px-2 py-2.5 text-xs text-slate-500 tabular-nums">{u.last_login_at ? fmtDate(u.last_login_at) : <span className="text-slate-400">never</span>}</td>
                  <td className="px-5 py-2.5 text-right">
                    <Toggle checked={!!u.active} onChange={(v) => update.mutate({ id: u.id, active: v })} />
                  </td>
                </tr>
              ))}
              {users.data?.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-6 text-center text-sm text-slate-500">No users yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
