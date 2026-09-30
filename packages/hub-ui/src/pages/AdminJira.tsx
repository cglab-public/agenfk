import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { apiErrorText } from '../apiError';
import { buttonClass, cardClass, controlClass, CopyButton } from '../components/ui';

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
  const qc = useQueryClient();
  const cfg = useQuery<JiraAdminView>({
    queryKey: ['jira-config'],
    queryFn: async () => (await api.get('/v1/admin/jira')).data,
  });
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState('');

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

  if (!cfg.data) return <div className="text-sm text-ink-tertiary">Loading…</div>;
  const c = cfg.data;
  const idValue = clientId ?? c.clientId;

  return (
    <div className="space-y-4 max-w-2xl">
      <section className={cardCls}>
        <h3 className="text-sm font-semibold text-ink">Connections</h3>
        <p className="mt-1 text-sm text-ink-tertiary">
          {c.configured
            ? 'Each person connects their own JIRA account from their board; JIRA\'s permissions apply to each of them.'
            : 'Save the Atlassian app below, then each person connects their own JIRA account from their board.'}
        </p>
        <p className="mt-3 text-sm text-ink">
          <span data-testid="jira-connected-count" className="font-mono font-semibold">{c.connectedCount}</span>
          {' '}agenfk board{c.connectedCount === 1 ? '' : 's'} connected
        </p>
        {c.configured && (
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              className={dangerBtnCls}
              disabled={disconnectAll.isPending || c.connectedCount === 0}
              onClick={() => {
                if (window.confirm('Disconnect JIRA for every installation in this organization? Each person will have to connect again.')) {
                  disconnectAll.mutate();
                }
              }}
            >
              Disconnect everyone
            </button>
            {disconnectAll.isError && <span className="text-xs text-status-danger-text">{apiErrorText(disconnectAll.error)}</span>}
          </div>
        )}
      </section>

      <form
        className={cardCls}
        onSubmit={(e) => {
          e.preventDefault();
          const body: { clientId: string; clientSecret?: string } = { clientId: idValue.trim() };
          if (clientSecret) body.clientSecret = clientSecret;
          save.mutate(body);
        }}
      >
        <h3 className="text-sm font-semibold text-ink">Atlassian OAuth app</h3>
        <p className="mt-1 text-xs text-ink-tertiary">
          Create an OAuth 2.0 integration at developer.atlassian.com with the Jira API scopes
          <span className="font-mono"> read:jira-user</span> and <span className="font-mono">read:jira-work</span>, and register this callback URL:
        </p>
        <p className="mt-2 font-mono text-xs break-all text-ink">{c.redirectUri}</p>
        <CopyButton value={c.redirectUri} label="Copy callback URL" className="mt-1" />
        <p className="mt-3 text-xs text-status-warn-text" data-testid="jira-distribution-step">
          Then, in the app's <span className="font-semibold">Distribution</span> tab, set the distribution status to
          <span className="font-semibold"> Sharing</span>. Atlassian keeps a new app private: until it is shared, only the
          app's contributors can connect their JIRA, and everyone else is stopped at the consent screen.
        </p>
        <div className="mt-4 grid sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.14em] font-semibold text-ink-tertiary">Client ID</span>
            <input className={`${inputCls} mt-1.5`} value={idValue} onChange={(e) => { save.reset(); setClientId(e.target.value); }} />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.14em] font-semibold text-ink-tertiary">Client secret</span>
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
        <p className="mt-3 text-xs text-ink-tertiary">Changing the client ID disconnects everyone: their tokens belong to the old app.</p>
        <div className="mt-4 flex items-center gap-3">
          <button type="submit" disabled={save.isPending} className={primaryBtnCls}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {save.isSuccess && <span className="text-xs text-status-ok-text font-medium">✓ Saved</span>}
          {save.isError && <span className="text-xs text-status-danger-text font-medium">{apiErrorText(save.error)}</span>}
        </div>
      </form>
    </div>
  );
}
