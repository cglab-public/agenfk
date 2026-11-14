import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { apiErrorText } from '../apiError';
import { buttonClass, cardClass, controlClass, CopyButton, QueryError, useConfirm } from '../components/ui';

/**
 * Admin → JIRA (CGLAB-412). The admin registers the org's Atlassian OAuth app
 * here, once. Each person then connects their OWN JIRA from their board: the
 * hub holds every user's token encrypted, relays JIRA calls with the caller's
 * token, and no JIRA credential ever reaches a laptop. The secret is
 * write-only - the hub reports only that one is stored.
 */
export interface JiraAdminView {
  configured: boolean;
  clientId: string;
  clientSecretSet: boolean;
  connectedCount: number;
  redirectUri: string;
}

const inputCls = controlClass;
const cardCls = cardClass;
const primaryBtnCls = buttonClass('primary');
const dangerBtnCls = buttonClass('danger');

export function AdminJira() {
  const { confirm, dialog } = useConfirm();
  const qc = useQueryClient();
  const cfg = useQuery<JiraAdminView>({
    queryKey: ['jira-config'],
    queryFn: async () => (await api.get('/v1/admin/jira')).data,
  });
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const onSaved = (data: JiraAdminView) => {
    qc.setQueryData(['jira-config'], data);
    setClientId(null);
    setClientSecret('');
  };
  const save = useMutation({
    mutationFn: async (body: { clientId: string; clientSecret?: string }) => (await api.put('/v1/admin/jira', body)).data as JiraAdminView,
    onSuccess: onSaved,
  });
  const disconnectAll = useMutation({
    mutationFn: async () => (await api.post('/v1/admin/jira/disconnect-all')).data as JiraAdminView,
    onSuccess: onSaved,
  });

  // Only a failed first load replaces the page; a failed refresh keeps it.
  if (cfg.isError && !cfg.data) return <QueryError error={cfg.error} onRetry={() => cfg.refetch()} />;
  if (!cfg.data) return <p role="status" className="text-body text-ink-tertiary">Loading…</p>;
  const c = cfg.data;
  const idValue = clientId ?? c.clientId;

  return (
    <div className="space-y-4 max-w-form">
      {dialog}
      {cfg.isError && <QueryError error={cfg.error} onRetry={() => cfg.refetch()} />}
      <section className={cardCls}>
        <h3 className="text-body font-semibold text-ink">Connections</h3>
        <p className="mt-1 text-body text-ink-tertiary">
          {c.configured
            ? 'Each person connects their own JIRA account from their board; JIRA\'s permissions apply to each of them.'
            : 'Save the Atlassian app below, then each person connects their own JIRA account from their board.'}
        </p>
        <p className="mt-3 text-body text-ink">
          <span data-testid="jira-connected-count" className="font-mono font-semibold">{c.connectedCount}</span>
          {' '}agenfk board{c.connectedCount === 1 ? '' : 's'} connected
        </p>
        {c.configured && (
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              className={dangerBtnCls}
              disabled={disconnectAll.isPending || c.connectedCount === 0}
              onClick={async () => {
                if (await confirm({
                  title: 'Disconnect JIRA for everyone?',
                  body: `All ${c.connectedCount} connected board${c.connectedCount === 1 ? '' : 's'} lose their JIRA access. Each person will have to connect again.`,
                  confirmLabel: 'Disconnect everyone',
                })) disconnectAll.mutate();
              }}
            >
              Disconnect everyone
            </button>
            {disconnectAll.isError && <span className="text-small text-status-danger-text">{apiErrorText(disconnectAll.error)}</span>}
          </div>
        )}
      </section>

      <form
        className={cardCls}
        onSubmit={async (e) => {
          e.preventDefault();
          const body: { clientId: string; clientSecret?: string } = { clientId: idValue.trim() };
          if (clientSecret) body.clientSecret = clientSecret;
          // A new client ID is a different Atlassian app: every existing JIRA
          // token belongs to the old one, so everyone is disconnected.
          const replacesApp = !!c.clientId && body.clientId !== c.clientId;
          // The hub refuses a new app without its secret; say so before asking
          // the admin to confirm a save that cannot succeed.
          if (replacesApp && !clientSecret) {
            setFormError('A new client ID needs its client secret: paste the new app\'s secret too.');
            return;
          }
          setFormError(null);
          if (replacesApp && !(await confirm({
            title: 'Change the JIRA client ID?',
            body: `This points the hub at a different Atlassian app. Everyone connected through the current one (${c.connectedCount}) is disconnected and has to connect again.`,
            confirmLabel: 'Change client ID',
          }))) return;
          save.mutate(body);
        }}
      >
        <h3 className="text-body font-semibold text-ink">Atlassian OAuth app</h3>
        <p className="mt-1 text-small text-ink-tertiary">
          Create an OAuth 2.0 integration at developer.atlassian.com with the Jira API scopes
          <span className="font-mono"> read:jira-user</span> and <span className="font-mono">read:jira-work</span>, and register this callback URL:
        </p>
        <p className="mt-2 font-mono text-small break-all text-ink">{c.redirectUri}</p>
        <CopyButton value={c.redirectUri} label="Copy callback URL" className="mt-1" />
        <p className="mt-3 text-small text-status-warn-text" data-testid="jira-distribution-step">
          Then, in the app's <span className="font-semibold">Distribution</span> tab, set the distribution status to
          <span className="font-semibold"> Sharing</span>. Atlassian keeps a new app private: until it is shared, only the
          app's contributors can connect their JIRA, and everyone else is stopped at the consent screen.
        </p>
        <div className="mt-4 grid sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="eyebrow text-ink-tertiary">Client ID</span>
            <input className={`${inputCls} mt-1.5`} value={idValue} onChange={(e) => { save.reset(); setClientId(e.target.value); }} />
          </label>
          <label className="block">
            <span className="eyebrow text-ink-tertiary">Client secret</span>
            <input
              className={`${inputCls} mt-1.5`}
              type="password"
              autoComplete="off"
              placeholder={c.clientSecretSet ? '•••••• (leave blank to keep)' : 'client secret'}
              value={clientSecret}
              onChange={(e) => { save.reset(); setClientSecret(e.target.value); }}
            />
          </label>
        </div>
        <p className="mt-3 text-small text-ink-tertiary">Changing the client ID disconnects everyone: their tokens belong to the old app.</p>
        {formError && <p role="alert" className="mt-2 text-small text-status-danger-text">{formError}</p>}
        <div className="mt-4 flex items-center gap-3">
          <button type="submit" disabled={save.isPending} className={primaryBtnCls}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {save.isSuccess && <span className="text-small text-status-ok-text font-medium">✓ Saved</span>}
          {save.isError && <span className="text-small text-status-danger-text font-medium">{apiErrorText(save.error)}</span>}
        </div>
      </form>
    </div>
  );
}
