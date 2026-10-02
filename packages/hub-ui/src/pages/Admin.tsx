import { useEffect, useId, useState } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { ADMIN_GROUPS } from './adminSections';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Users, Trash2, X, EyeOff, Eye, Archive, ArchiveRestore } from 'lucide-react';
import { api } from '../api';
import { canDeleteUserRow } from './canDeleteUserRow';
import { hideTargetKey, partitionHiddenRows, canHideRow } from './hiddenPeople';
import { canRetireRow, canUnretireRow, countRetired, retireConfirmMessage } from './retiredInstallations';
import { isAttributedByUsername, attributionWarning, countAttributedByUsername } from './attributionWarning';
import { Page, Toggle, RowMenu, CopyButton, Badge, LocalTime, QueryError, InlineError, buttonClass, cardClass, controlClass, useConfirm } from '../components/ui';
import { inviteErrors } from './adminValidation';
import { providerStatus, ProviderRequirement, noWorkingSignInMethod, googleRequires, entraRequires } from './signInProviderStatus';
import { userAccessLock, isLastActiveAdmin } from './userAccessLock';
import { silentDays } from './installationStaleness';

export function AdminLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const current = pathname.replace(/^\/admin\/?/, '').split('/')[0];
  const link = ({ isActive }: { isActive: boolean }) =>
    'flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-body font-medium transition-colors ' + (isActive
      ? 'bg-accent-fill text-accent-ink'
      : 'text-ink-secondary hover:bg-nav-surface hover:text-ink');
  return (
    <Page>
      <header>
        <p className="eyebrow text-accent-ink">Settings</p>
        <h1 className="mt-1 text-display font-bold tracking-tight text-ink">Admin</h1>
        <p className="mt-1 text-body text-ink-tertiary">People, access, fleet-wide settings and the hub itself.</p>
      </header>

      {/* Narrow screens: one select instead of a rail. */}
      <label className="block lg:hidden">
        <span className="sr-only">Admin section</span>
        <select
          aria-label="Admin section"
          value={current || ''}
          onChange={e => navigate(e.target.value ? `/admin/${e.target.value}` : '/admin')}
          className={controlClass}
        >
          <option value="">Overview</option>
          {ADMIN_GROUPS.map(g => (
            <optgroup key={g.id} label={g.label}>
              {g.sections.map(s => <option key={s.to} value={s.to}>{s.label}</option>)}
            </optgroup>
          ))}
        </select>
      </label>

      <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
        <nav aria-label="Admin sections" className="hidden lg:block space-y-5">
          <NavLink to="/admin" end className={link}>Overview</NavLink>
          {ADMIN_GROUPS.map(g => (
            <div key={g.id} role="group" aria-labelledby={`admin-nav-${g.id}`}>
              <p id={`admin-nav-${g.id}`} className="eyebrow px-2.5 mb-1 text-ink-tertiary">{g.label}</p>
              <ul className="space-y-0.5">
                {g.sections.map(s => (
                  <li key={s.to}>
                    <NavLink to={s.to} className={link}>
                      <s.icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      {s.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </Page>
  );
}

interface AuthConfig {
  passwordEnabled: boolean; googleEnabled: boolean; entraEnabled: boolean;
  google: { clientId: string; clientSecretSet: boolean };
  entra: { tenantId: string; clientId: string; clientSecretSet: boolean };
  emailAllowlist: string[];
}

const inputCls = controlClass;
const cardCls = cardClass;
const primaryBtnCls = buttonClass('primary');

/** A sign-in provider's state, next to its name. */
function ProviderBadge(p: { enabled: boolean; requires: ProviderRequirement[] }) {
  const s = providerStatus(p);
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function AdminAuth() {
  const qc = useQueryClient();
  const cfg = useQuery<AuthConfig>({ queryKey: ['auth-config'], queryFn: async () => (await api.get('/v1/admin/auth-config')).data });
  const save = useMutation({
    mutationFn: (body: any) => api.put('/v1/admin/auth-config', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth-config'] }),
  });
  const [draft, setDraftState] = useState<any>({});
  // An edit after a save makes "✓ Saved" untrue.
  const setDraft = (d: any) => { save.reset(); setDraftState(d); };
  // Only a first load that failed replaces the form; a failed background
  // refresh keeps the loaded form (and the admin's edits) on screen.
  if (cfg.isError && !cfg.data) return <QueryError error={cfg.error} onRetry={() => cfg.refetch()} />;
  if (!cfg.data) return <p role="status" className="text-body text-ink-tertiary">Loading…</p>;
  const c = { ...cfg.data, ...draft };
  // Blocks only a save that makes things worse, like the hub: an org whose
  // stored config already works for nobody must be able to save a partial fix.
  const lockedOut = noWorkingSignInMethod(c) && !noWorkingSignInMethod(cfg.data);

  return (
    <form className="space-y-4 max-w-form" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
      {cfg.isError && <QueryError error={cfg.error} onRetry={() => cfg.refetch()} />}
      <section className={cardCls}>
        <header className="flex items-center justify-between">
          <h3 className="text-body font-semibold text-ink">Email + password</h3>
          <Toggle label="Email + password sign-in" checked={c.passwordEnabled} onChange={(v) => setDraft({ ...draft, passwordEnabled: v })} />
        </header>
        <p className="mt-1 text-small text-ink-tertiary">Allow users to sign in with email and a hashed password stored on this hub.</p>
      </section>

      <section className={cardCls}>
        <header className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-body font-semibold text-ink">Google</h3>
              <ProviderBadge enabled={c.googleEnabled} requires={googleRequires(c.google)} />
            </div>
            <p className="mt-0.5 text-small text-ink-tertiary">OAuth 2.0 sign-in with Google Workspace or consumer accounts.</p>
          </div>
          <Toggle label="Google sign-in" checked={c.googleEnabled} onChange={(v) => setDraft({ ...draft, googleEnabled: v })} />
        </header>
        {c.googleEnabled && (
        <div className="mt-4 grid sm:grid-cols-2 gap-3">
          <Field label="Client ID">
            <input className={inputCls} placeholder="123…apps.googleusercontent.com" value={c.google.clientId} onChange={(e) => setDraft({ ...draft, google: { ...c.google, clientId: e.target.value } })} />
          </Field>
          <Field label="Client secret">
            <input className={inputCls} type="password" placeholder={c.google.clientSecretSet ? '•••••• (leave blank to keep)' : 'GOCSPX-…'} value={c.google.clientSecret ?? ''} onChange={(e) => setDraft({ ...draft, google: { ...c.google, clientSecret: e.target.value } })} />
          </Field>
        </div>
        )}
      </section>

      <section className={cardCls}>
        <header className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-body font-semibold text-ink">Microsoft Entra</h3>
              <ProviderBadge enabled={c.entraEnabled} requires={entraRequires(c.entra)} />
            </div>
            <p className="mt-0.5 text-small text-ink-tertiary">OAuth 2.0 sign-in via Azure AD / Entra ID tenants.</p>
          </div>
          <Toggle label="Microsoft Entra sign-in" checked={c.entraEnabled} onChange={(v) => setDraft({ ...draft, entraEnabled: v })} />
        </header>
        {c.entraEnabled && (
        <div className="mt-4 grid sm:grid-cols-2 gap-3">
          <Field label="Tenant ID">
            <input className={inputCls} placeholder="common, organizations, or tenant GUID" value={c.entra.tenantId} onChange={(e) => setDraft({ ...draft, entra: { ...c.entra, tenantId: e.target.value } })} />
          </Field>
          <Field label="Client ID">
            <input className={inputCls} placeholder="application (client) ID" value={c.entra.clientId} onChange={(e) => setDraft({ ...draft, entra: { ...c.entra, clientId: e.target.value } })} />
          </Field>
          <Field label="Client secret" className="sm:col-span-2">
            <input className={inputCls} type="password" placeholder={c.entra.clientSecretSet ? '•••••• (leave blank to keep)' : 'client secret value'} value={c.entra.clientSecret ?? ''} onChange={(e) => setDraft({ ...draft, entra: { ...c.entra, clientSecret: e.target.value } })} />
          </Field>
        </div>
        )}
      </section>

      <section className={cardCls}>
        <h3 id="auth-email-allowlist" className="text-body font-semibold text-ink">Email allowlist</h3>
        <p className="mt-1 text-small text-ink-tertiary">Comma-separated domains. Only addresses ending in these domains may sign in. Leave empty to accept any.</p>
        <input className={`${inputCls} mt-3 font-mono text-small`}
               aria-labelledby="auth-email-allowlist"
               placeholder='acme.com, *.subsidiary.com'
               defaultValue={c.emailAllowlist.join(', ')}
               onBlur={(e) => setDraft({ ...draft, emailAllowlist: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
      </section>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={save.isPending || lockedOut} aria-describedby={lockedOut ? 'signin-lockout' : undefined} className={primaryBtnCls}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>
        {lockedOut && (
          <span id="signin-lockout" role="alert" className="text-small text-status-danger-text font-medium">
            This would leave no way to sign in. Keep email + password on, or finish setting up another provider first.
          </span>
        )}
        {save.isSuccess && <span className="text-small text-status-ok-text font-medium">✓ Saved</span>}
        <InlineError error={save.error} className="font-medium" />
      </div>
    </form>
  );
}

function Field({ label, error, errorId, children, className }: { label: string; error?: string; errorId?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="eyebrow text-ink-tertiary">{label}</span>
      <div className="mt-1.5">{children}</div>
      {/* Tied to its input by aria-describedby, not announced as an alert on every keystroke. */}
      {error && <span id={errorId} className="mt-1 block text-small text-status-danger-text">{error}</span>}
    </label>
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
  const { confirm, dialog } = useConfirm();
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
  // The token is shown once. Leaving the page while it is up loses it, so
  // the browser asks first. (In-app route changes can't be held under
  // BrowserRouter; the notice above the token says to save it now.)
  useEffect(() => {
    if (!issued) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = 'unsaved'; };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [issued]);
  interface InviteEntry { id: string; joinCommand: string; expiresAt: string }
  const [invites, setInvites] = useState<InviteEntry[]>([]);

  return (
    <div className="space-y-6">
      {dialog}
      <section className={`${cardCls} max-w-form`}>
        <header className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent-fill text-accent-ink flex items-center justify-center">
            <KeyRound className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-body font-semibold text-ink">Magic-link invite</h3>
            <p className="mt-0.5 text-small text-ink-tertiary">Generate a single-use, signed join command. Developers paste it into their terminal — they never see the token.</p>
          </div>
        </header>
        <button
          onClick={async () => {
            // A refusal is shown from createInvite.error below; caught here so
            // it does not escape as an unhandled rejection.
            const r = await createInvite.mutateAsync().catch(() => null);
            if (!r) return;
            const data = r.data as { joinCommand: string; expiresAt: string };
            setInvites(prev => [
              ...prev,
              { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, joinCommand: data.joinCommand, expiresAt: data.expiresAt },
            ]);
          }}
          disabled={createInvite.isPending}
          className={`mt-4 ${primaryBtnCls}`}
        >
          {createInvite.isPending ? 'Generating…' : invites.length === 0 ? 'Generate invite' : 'Generate another invite'}
        </button>
        <InlineError error={createInvite.error} className="mt-2" />
        {invites.length > 0 && (
          <div className="mt-4 space-y-3">
            {invites.map((inv, idx) => (
              <div key={inv.id} className="rounded-xl border border-border-soft bg-canvas p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="eyebrow text-accent-ink">
                    Share this command{invites.length > 1 ? ` · #${idx + 1}` : ''}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="text-caption text-ink-tertiary">expires {<LocalTime value={inv.expiresAt} format="date" />}</span>
                    <button
                      onClick={() => setInvites(prev => prev.filter(p => p.id !== inv.id))}
                      aria-label={`Dismiss invite ${idx + 1}`}
                      title="Dismiss"
                      className="text-ink-tertiary hover:text-status-danger-text"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <pre className="mt-2 px-3 py-2.5 rounded-lg bg-canvas text-ink text-small font-mono relative overflow-x-auto select-all">{inv.joinCommand}</pre>
                <CopyButton value={inv.joinCommand} label={`Copy invite ${idx + 1} command`} className="mt-2" />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={`${cardCls} max-w-form`}>
        <header>
          <h3 className="text-body font-semibold text-ink">Issue an API key</h3>
          <p className="mt-0.5 text-small text-ink-tertiary">Manual installation token for legacy / scripted workflows. Prefer magic-link invites for human onboarding.</p>
        </header>
        <form className="mt-3 flex flex-col sm:flex-row gap-2" onSubmit={async (e) => {
          e.preventDefault();
          // A refusal is shown from create.error below; the label stays for a retry.
          const r = await create.mutateAsync(label).catch(() => null);
          if (!r) return;
          setIssued((r.data as any).token);
          setLabel('');
        }}>
          <input className={`${inputCls} flex-1`} aria-label="Key label" placeholder="Label, e.g. laptop-alice" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button type="submit" className={primaryBtnCls}>Issue key</button>
        </form>
        <InlineError error={create.error} className="mt-2" />
        {issued && (
          <div className="mt-3 rounded-xl border border-status-warn-text/40 bg-status-warn-bg p-4">
            <div className="eyebrow text-status-warn-text">Save this token now — it won't be shown again</div>
            <pre className="mt-2 px-3 py-2.5 rounded-lg bg-canvas text-ink text-small font-mono break-all relative overflow-x-auto select-all">{issued}</pre>
            <div className="mt-2 flex items-center gap-3">
              <CopyButton value={issued} label="Copy" />
              <button onClick={() => setIssued(null)} className="text-small font-medium text-ink-tertiary hover:text-ink">I've saved it</button>
            </div>
          </div>
        )}
      </section>

      <section className={cardCls}>
        <header className="flex items-center justify-between">
          <h3 className="text-body font-semibold text-ink">Active keys</h3>
          <span className="text-caption text-ink-tertiary">{(keys.data ?? []).filter(k => !k.revokedAt).length} active · {(keys.data ?? []).length} total</span>
        </header>
        <InlineError error={revoke.error} className="mt-2" />
        <div className="mt-3 -mx-5 relative overflow-x-auto">
          <table className="w-full text-body">
            <thead>
              <tr className="eyebrow text-ink-tertiary">
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
                <tr key={k.tokenHashPreview} className="hover:bg-accent-fill transition-colors">
                  <td className="px-5 py-2.5 font-mono text-small text-ink-secondary">{k.tokenHashPreview}…</td>
                  <td className="px-2 py-2.5 text-ink-secondary">{k.label ?? <span className="text-ink-tertiary">—</span>}</td>
                  <td className="px-2 py-2.5 text-small text-ink-secondary">
                    {ident ? (
                      <span className="font-mono" title={k.installationId ? `installation: ${k.installationId}` : undefined}>
                        {ident}
                        {k.installationId && (
                          <span className="ml-1 text-ink-tertiary">
                            <span aria-hidden="true">· {k.installationId.slice(0, 8)}…</span>
                            <span className="sr-only">installation {k.installationId}</span>
                          </span>
                        )}
                      </span>
                    ) : k.installationId ? (
                      <span className="font-mono text-ink-tertiary" title={k.installationId}>
                        <span aria-hidden="true">{k.installationId.slice(0, 8)}…</span>
                        <span className="sr-only">installation {k.installationId}</span>
                      </span>
                    ) : (
                      <span className="text-ink-tertiary">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-small text-ink-tertiary tabular-nums">{<LocalTime value={k.createdAt} format="date" />}</td>
                  <td className="px-2 py-2.5">
                    {k.revokedAt
                      ? <span className="px-2 py-0.5 rounded-md text-caption font-mono bg-status-danger-bg text-status-danger-text border border-status-danger-text/40">revoked</span>
                      : <span className="px-2 py-0.5 rounded-md text-caption font-mono bg-status-ok-bg text-status-ok-text border border-status-ok-text/40">active</span>}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {!k.revokedAt && (
                      <button onClick={async () => {
                                if (await confirm({
                                  title: `Revoke the key ${k.label ?? k.tokenHashPreview}?`,
                                  body: 'Any machine using it stops reporting to the hub at once, and the key cannot be restored: the machine has to join again for a new one.',
                                  confirmLabel: 'Revoke key',
                                })) revoke.mutate(k.tokenHashPreview);
                              }}
                              aria-label={`Revoke key ${k.label ?? k.tokenHashPreview}`}
                              className="inline-flex items-center gap-1 text-small font-semibold text-ink-tertiary hover:text-status-danger-text">
                        <Trash2 className="w-3 h-3" /> Revoke
                      </button>
                    )}
                  </td>
                </tr>
                );
              })}
              {keys.isError && (
                <tr><td colSpan={6} className="px-5 py-4"><QueryError error={keys.error} onRetry={() => keys.refetch()} /></td></tr>
              )}
              {keys.isPending && (
                <tr><td colSpan={6} className="px-5 py-6 text-center text-body text-ink-tertiary" role="status">Loading…</td></tr>
              )}
              {keys.data?.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-6 text-center text-body text-ink-tertiary">No keys yet.</td></tr>
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
  password: 'bg-canvas text-ink-secondary border-border-soft',
  google:   'bg-canvas text-ink-secondary border-border-soft',
  entra:    'bg-canvas text-ink-secondary border-border-soft',
};

export function AdminUsers() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const users = useQuery<UserRow[]>({ queryKey: ['admin-users'], queryFn: async () => (await api.get('/v1/admin/users')).data });
  const me = useQuery<{ userId: string }>({ queryKey: ['auth-me'], queryFn: async () => (await api.get('/auth/me')).data });
  const invite = useMutation({
    mutationFn: (body: any) => api.post('/v1/admin/users/invite', body),
    onSuccess: () => {
      // Cleared only once the hub accepted it: a refused invite keeps what was
      // typed, next to the reason.
      setDraft(d => ({ email: '', password: '', role: 'viewer', authMethod: d.authMethod }));
      setTouched({});
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });
  // A success on the card clears the other action's leftover error: the
  // errors are not tied to a row, so a stale one would read as current. Only
  // an errored one: reset() on a running mutation would lose its outcome.
  const update = useMutation({
    mutationFn: ({ id, ...rest }: any) => api.put(`/v1/admin/users/${id}`, rest),
    onSuccess: () => { if (remove.isError) remove.reset(); qc.invalidateQueries({ queryKey: ['admin-users'] }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/admin/users/${id}`),
    onSuccess: () => { if (update.isError) update.reset(); qc.invalidateQueries({ queryKey: ['admin-users'] }); },
  });
  const [draft, setDraft] = useState<{ email: string; password: string; role: string; authMethod: 'password' | 'sso' }>({ email: '', password: '', role: 'viewer', authMethod: 'password' });
  const draftErrors = inviteErrors(draft);
  const inviteReady = !!draft.email && (draft.authMethod === 'sso' || !!draft.password) && !draftErrors.email && !draftErrors.password;
  // Say what is wrong once the admin leaves a field, not from the first keystroke.
  const [touched, setTouched] = useState<{ email?: boolean; password?: boolean }>({});
  const shownErrors = { email: touched.email ? draftErrors.email : undefined, password: touched.password ? draftErrors.password : undefined };

  return (
    <div className="space-y-6">
      {dialog}
      <section className={`${cardCls} max-w-form`}>
        <header>
          <h3 className="text-body font-semibold text-ink">Invite user</h3>
          <p className="mt-0.5 text-small text-ink-tertiary">Only invited users can sign in — SSO does not auto-create accounts. Choose <strong>Password</strong> for an email + password login, or <strong>SSO only</strong> to require Google/Entra sign-in for the same email.</p>
        </header>
        <form
          className="mt-4 grid sm:grid-cols-12 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const body: any = { email: draft.email.trim(), role: draft.role };
            if (draft.authMethod === 'password') body.password = draft.password;
            invite.mutate(body);
          }}
        >
          {/* Not a Field: a <label> around buttons names the first one and
              presses it when the caption is clicked. */}
          <div className="block sm:col-span-12">
            <span id="invite-auth-method" className="eyebrow text-ink-tertiary">Auth method</span>
            <div role="group" aria-labelledby="invite-auth-method" className="mt-1.5 inline-flex p-1 rounded-lg border border-border-soft bg-canvas">
              {(['password', 'sso'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={draft.authMethod === m}
                  onClick={() => setDraft({ ...draft, authMethod: m, password: m === 'sso' ? '' : draft.password })}
                  className={`px-3 py-1 rounded-md text-small font-semibold transition-colors ${draft.authMethod === m ? 'bg-surface text-accent-ink shadow-sm' : 'text-ink-tertiary hover:text-ink'}`}
                >
                  {m === 'password' ? 'Password' : 'SSO only'}
                </button>
              ))}
            </div>
          </div>
          <Field label="Email" error={shownErrors.email} errorId="invite-email-error" className={draft.authMethod === 'password' ? 'sm:col-span-5' : 'sm:col-span-9'}>
            <input className={inputCls} placeholder="alice@acme.com" value={draft.email}
              aria-invalid={!!shownErrors.email} aria-describedby={shownErrors.email ? 'invite-email-error' : undefined}
              onBlur={() => setTouched(t => ({ ...t, email: true }))}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
          </Field>
          {draft.authMethod === 'password' && (
            <Field label="Password" error={shownErrors.password} errorId="invite-password-error" className="sm:col-span-4">
              <input className={inputCls} type="password" placeholder="≥ 8 characters" value={draft.password}
                aria-invalid={!!shownErrors.password} aria-describedby={shownErrors.password ? 'invite-password-error' : undefined}
                onBlur={() => setTouched(t => ({ ...t, password: true }))}
                onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
            </Field>
          )}
          <Field label="Role" className="sm:col-span-3">
            <select className={inputCls} value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
              <option value="viewer">viewer</option>
              <option value="admin">admin</option>
            </select>
          </Field>
          <div className="sm:col-span-12">
            <button type="submit" disabled={invite.isPending || !inviteReady} className={primaryBtnCls}>
              {invite.isPending ? 'Inviting…' : 'Invite user'}
            </button>
          </div>
        </form>
        <InlineError error={invite.error} className="mt-2" />
      </section>

      <section className={cardCls}>
        <header className="flex items-center justify-between">
          <h3 className="text-body font-semibold text-ink">Users</h3>
          <span className="text-caption text-ink-tertiary">{users.data?.length ?? 0} total</span>
        </header>
        <InlineError error={update.error} className="mt-2" />
        <InlineError error={remove.error} className="mt-2" />
        <div className="mt-3 -mx-5 relative overflow-x-auto">
          <table className="w-full text-body">
            <thead>
              <tr className="eyebrow text-ink-tertiary">
                <th className="text-left px-5 py-2">Email</th>
                <th className="text-left px-2 py-2">Provider</th>
                <th className="text-left px-2 py-2">Role</th>
                <th className="text-left px-2 py-2">Last login</th>
                <th className="text-right px-2 py-2">Active</th>
                <th className="text-right px-5 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-soft">
              {(users.data ?? []).map(u => {
                const lock = userAccessLock(u, me.data?.userId, users.data ?? []);
                // Until /auth/me answers every row is locked, but there is nothing to explain yet.
                const lockNote = me.data ? lock : null;
                const lockId = `user-lock-${u.id}`;
                return (
                <tr key={u.id} className="hover:bg-accent-fill transition-colors">
                  <td className="px-5 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-accent-fill text-accent-ink text-caption font-bold flex items-center justify-center shrink-0">
                        {u.email.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <span className="font-mono text-small text-ink-secondary">{u.email}</span>
                        {lockNote && <p id={lockId} className="text-caption text-ink-tertiary">{lockNote}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-2.5">
                    <span className={`px-2 py-0.5 rounded-md text-caption font-mono border ${PROVIDER_BADGE[u.provider] ?? PROVIDER_BADGE.password}`}>{u.provider}</span>
                  </td>
                  <td className="px-2 py-2.5">
                    <select
                      value={u.role}
                      disabled={!!lock}
                      aria-label={`Role: ${u.email}`}
                      aria-describedby={lockNote ? lockId : undefined}
                      onChange={(e) => update.mutate({ id: u.id, role: e.target.value })}
                      className="bg-transparent text-small font-medium text-ink-secondary hover:bg-accent-fill rounded-md px-1.5 py-0.5 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      <option value="viewer">viewer</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="px-2 py-2.5 text-small text-ink-tertiary tabular-nums">{u.last_login_at ? <LocalTime value={u.last_login_at} format="date" /> : <span className="text-ink-tertiary">never</span>}</td>
                  <td className="px-2 py-2.5 text-right">
                    <Toggle label={`Active: ${u.email}`} checked={!!u.active} disabled={!!lock} aria-describedby={lockNote ? lockId : undefined} onChange={(v) => update.mutate({ id: u.id, active: v })} />
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {canDeleteUserRow(u.id, me.data?.userId) && !isLastActiveAdmin(u, users.data ?? []) && (
                      <button
                        onClick={async () => {
                          if (await confirm({
                            title: `Delete ${u.email}?`,
                            body: 'They can no longer sign in, and the account cannot be undone or restored. Their history on the dashboards stays.',
                            confirmLabel: 'Delete user',
                          })) remove.mutate(u.id);
                        }}
                        disabled={remove.isPending}
                        aria-label={`Delete ${u.email}`}
                        title="Delete user"
                        className="inline-flex items-center gap-1 text-small font-semibold text-ink-tertiary hover:text-status-danger-text disabled:opacity-50"
                      >
                        <Trash2 className="w-3 h-3" /> Delete
                      </button>
                    )}
                  </td>
                </tr>
                );
              })}
              {/* Without the signed-in user every row stays locked; say why. If the list itself failed there are no rows, and its error says enough. */}
              {me.isError && !users.isError && (
                <tr><td colSpan={6} className="px-5 py-4"><QueryError error={me.error} onRetry={() => me.refetch()} /></td></tr>
              )}
              {users.isError && (
                <tr><td colSpan={6} className="px-5 py-4"><QueryError error={users.error} onRetry={() => users.refetch()} /></td></tr>
              )}
              {users.isPending && (
                <tr><td colSpan={6} className="px-5 py-6 text-center text-body text-ink-tertiary" role="status">Loading…</td></tr>
              )}
              {users.data?.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-6 text-center text-body text-ink-tertiary">No users yet.</td></tr>
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
  retired?: boolean;
  retiredAt?: string | null;
  retiredByEmail?: string | null;
}

interface HiddenPersonRow {
  userKey: string;
  hiddenByEmail: string | null;
  createdAt: string;
}

/** Who an installation belongs to: the Person cell's headline, and what its row actions name. */
const personLabel = (r: InstallationRow): string => r.gitName ?? r.osUser ?? r.gitEmail ?? r.id.slice(0, 8);

export function AdminInstallations() {
  const { confirm, dialog } = useConfirm();
  const retiredHintId = useId();
  const qc = useQueryClient();
  // CGLAB-31: hidden people are excluded server-side by default; the toggle
  // re-fetches with ?includeHidden=1 and flags them inline.
  const [showHidden, setShowHidden] = useState(false);
  // CGLAB-64: retired installations are excluded server-side too, on their own
  // flag, so an admin can review dead endpoints without un-hiding people.
  const [showRetired, setShowRetired] = useState(false);
  const installations = useQuery<InstallationRow[]>({
    queryKey: ['admin-installations', showHidden, showRetired],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (showHidden) params.set('includeHidden', '1');
      if (showRetired) params.set('includeRetired', '1');
      const qs = params.toString();
      return (await api.get(`/v1/admin/installations${qs ? `?${qs}` : ''}`)).data;
    },
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
  // A success clears the other actions' leftover errors (see AdminUsers).
  const succeeded = () => { for (const m of [hide, unhide, retire, unretire]) if (m.isError) m.reset(); invalidate(); };
  const hide = useMutation({
    mutationFn: (userKey: string) => api.post('/v1/admin/hidden-users', { userKey }),
    onSuccess: () => succeeded(),
  });
  const unhide = useMutation({
    mutationFn: (userKey: string) => api.delete(`/v1/admin/hidden-users/${encodeURIComponent(userKey)}`),
    onSuccess: () => succeeded(),
  });
  const retire = useMutation({
    mutationFn: (id: string) => api.post(`/v1/admin/installations/${encodeURIComponent(id)}/retire`),
    onSuccess: () => succeeded(),
  });
  const unretire = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/admin/installations/${encodeURIComponent(id)}/retire`),
    onSuccess: () => succeeded(),
  });

  const rows = installations.data ?? [];
  const { visible, hidden: hiddenRows } = partitionHiddenRows(rows);
  const hiddenCount = hiddenPeople.data?.length ?? hiddenRows.length;
  // Only meaningful once includeRetired=1 has loaded them; before that the
  // server has already filtered them out, so the count reads 0.
  const retiredCount = countRetired(rows);
  const attributedByUsername = countAttributedByUsername(rows);

  return (
    <div className="space-y-6">
      {dialog}
      <section className={cardCls}>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-body font-semibold text-ink">Installations</h3>
            <p className="mt-0.5 text-small text-ink-tertiary">
              Every AgEnFK install that has reported events to this hub. Use this to audit which version is running where.
              {' '}<span id={retiredHintId}>Retired installations are dead endpoints, excluded from upgrades and address changes.</span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {hiddenCount > 0 && (
              <button
                onClick={() => setShowHidden(v => !v)}
                className="inline-flex items-center gap-1 text-caption font-semibold text-ink-tertiary hover:text-ink"
              >
                {showHidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                {showHidden ? 'Hide hidden' : `Show hidden (${hiddenCount})`}
              </button>
            )}
            {/* Always available: the server filters retired rows out by default,
                so their count is unknowable until the toggle loads them — which
                is why this label only counts once they are on screen. */}
            <button
              onClick={() => setShowRetired(v => !v)}
              className="inline-flex items-center gap-1 text-caption font-semibold text-ink-tertiary hover:text-ink"
              // What retired means is in the header's description, on screen.
              aria-describedby={retiredHintId}
            >
              {showRetired ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
              {showRetired ? `Hide retired (${retiredCount})` : 'Show retired'}
            </button>
            {attributedByUsername > 0 && (
              <span className="text-caption font-semibold text-status-warn-text">
                {attributedByUsername} attributed by username
              </span>
            )}
            <span className="text-caption text-ink-tertiary">{showHidden ? rows.length : visible.length} total</span>
          </div>
        </header>
        {attributedByUsername > 0 && (
          <p className="mt-1 text-caption text-ink-tertiary">
            {attributedByUsername === 1 ? 'One install has' : `${attributedByUsername} installs have`} no git email, so their work is filed under an OS username instead of a person.
          </p>
        )}
        <InlineError error={hide.error} className="mt-2" />
        <InlineError error={retire.error} className="mt-2" />
        <InlineError error={unretire.error} className="mt-2" />
        <div className="mt-3 -mx-5 relative overflow-x-auto">
          <table className="w-full text-body">
            <thead>
              <tr className="eyebrow text-ink-tertiary">
                <th className="text-left px-5 py-2">Person</th>
                <th className="text-left px-2 py-2">Installation</th>
                <th className="text-left px-2 py-2">Version</th>
                <th className="text-left px-2 py-2">Version updated</th>
                <th className="text-right px-5 py-2">Last seen</th>
                <th className="text-right px-5 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-soft">
              {rows.map(r => (
                <tr key={r.id} className={`hover:bg-accent-fill transition-colors ${r.hidden || r.retired ? 'opacity-50' : ''}`}>
                  <td className="px-5 py-2.5">
                    <div className="text-body font-medium text-ink">{personLabel(r)}</div>
                    {r.gitEmail
                      ? <div className="text-caption text-ink-tertiary font-mono">{r.gitEmail}</div>
                      : (
                        // Their whole history is filed under an OS username, and
                        // fixing it later splits them into two identities.
                        <details className="text-caption text-status-warn-text">
                          <summary className="font-semibold cursor-pointer">no git email — attributed by username</summary>
                          <p className="mt-0.5 max-w-prose text-ink-secondary">{attributionWarning(r.osUser)}</p>
                        </details>
                      )}
                  </td>
                  <td className="px-2 py-2.5">
                    <span className="font-mono text-caption text-ink-secondary" title={r.id}>
                      <span aria-hidden="true">{r.id.slice(0, 8)}</span>
                      <span className="sr-only">installation {r.id}</span>
                    </span>
                    <CopyButton value={r.id} iconOnly label={`Copy installation id for ${personLabel(r)}`} copiedLabel={`Copied installation id for ${personLabel(r)}`} className="ml-1.5 align-middle" />
                    {r.hidden && (
                      <span className="eyebrow ml-2 text-status-warn-text">hidden</span>
                    )}
                    {r.retired && (
                      <span className="eyebrow ml-2 text-ink-tertiary">
                        retired
                        {r.retiredByEmail && <span className="ml-1 normal-case tracking-normal font-normal">by {r.retiredByEmail}</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2.5">
                    {r.agenfkVersion
                      ? <span className="font-mono text-caption px-2 py-0.5 rounded-md border border-accent bg-accent-fill text-accent-ink">{r.agenfkVersion}</span>
                      : <span className="text-caption text-ink-tertiary italic">unknown</span>}
                  </td>
                  <td className="px-2 py-2.5 text-small text-ink-tertiary tabular-nums">
                    {r.agenfkVersionUpdatedAt ? <LocalTime value={r.agenfkVersionUpdatedAt} format="date" /> : <span className="text-ink-tertiary">—</span>}
                  </td>
                  <td className="px-5 py-2.5 text-right text-small text-ink-tertiary tabular-nums">
                    {r.lastSeen ? <LocalTime value={r.lastSeen} format="date" /> : <span className="text-ink-tertiary">—</span>}
                    {silentDays(r.lastSeen) !== null && (
                      <span className="ml-2 rounded-md border border-status-warn-text/40 bg-status-warn-bg px-1.5 py-0.5 text-caption font-semibold text-status-warn-text">
                        silent {silentDays(r.lastSeen)}d
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <RowMenu
                      label={`Actions for ${personLabel(r)}`}
                      items={[
                        ...(canHideRow(r) ? [{
                          label: `Hide ${personLabel(r)}`,
                          disabled: hide.isPending,
                          onSelect: async () => {
                            const key = hideTargetKey(r);
                            if (!key) return;
                            if (await confirm({
                              title: `Hide ${key}?`,
                              body: 'Their installations disappear from pickers, their API keys are revoked, and new events are dropped. Historical data stays visible. You can unhide them later, but the keys stay revoked: their machines must join again.',
                              confirmLabel: 'Hide',
                            })) hide.mutate(key);
                          },
                        }] : []),
                        ...(canRetireRow(r) ? [{
                          label: `Retire ${personLabel(r)}'s installation`,
                          tone: 'danger' as const,
                          disabled: retire.isPending,
                          onSelect: async () => {
                            if (await confirm({ title: `Retire ${personLabel(r)}'s installation?`, body: retireConfirmMessage(r.id), confirmLabel: 'Retire installation' })) retire.mutate(r.id);
                          },
                        }] : []),
                        ...(canUnretireRow(r) ? [{
                          label: `Restore ${personLabel(r)}'s installation`,
                          disabled: unretire.isPending,
                          onSelect: () => unretire.mutate(r.id),
                        }] : []),
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-6 text-center text-body text-ink-tertiary">No installations have reported yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {(hiddenPeople.data?.length ?? 0) > 0 && (
        <section className={cardCls}>
          <header>
            <h3 className="text-body font-semibold text-ink">Hidden people</h3>
            <p className="mt-0.5 text-small text-ink-tertiary">
              Hidden people no longer appear in installation pickers, their API keys are revoked, and new events from them are dropped. Historical dashboards are unaffected. Unhiding restores visibility but does not restore revoked keys.
            </p>
          </header>
          <InlineError error={unhide.error} className="mt-2" />
          <ul className="mt-3 divide-y divide-border-soft">
            {hiddenPeople.data!.map(p => (
              <li key={p.userKey} className="flex items-center justify-between py-2">
                <div>
                  <div className="font-mono text-small text-ink-secondary">{p.userKey}</div>
                  <div className="text-caption text-ink-tertiary">
                    hidden {<LocalTime value={p.createdAt} format="date" />}{p.hiddenByEmail ? ` by ${p.hiddenByEmail}` : ''}
                  </div>
                </div>
                <button
                  onClick={() => unhide.mutate(p.userKey)}
                  disabled={unhide.isPending}
                  aria-label={`Unhide ${p.userKey}`}
                  className="inline-flex items-center gap-1 text-caption font-semibold text-accent-ink hover:opacity-80"
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
