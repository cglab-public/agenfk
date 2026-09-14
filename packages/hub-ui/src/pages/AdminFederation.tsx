/**
 * Admin → Parent hub (CGLAB-181).
 *
 * The child's half of federation. The rule this screen exists to make legible:
 * **a child hub cannot let itself out of a group.** Joining is the child's to
 * do; leaving is the parent's to grant. So Leave stays disabled, with the
 * reason on screen, until the parent has actually released this hub — and the
 * way to get there is to ask.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Network, AlertTriangle, Clock } from 'lucide-react';
import { api } from '../api';
import { apiErrorText as errText } from '../apiError';
import { fmtDateTime } from '../dates';

const cardCls = 'bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5';
const inputCls = 'w-full rounded-lg border border-border-soft bg-surface px-2 py-1.5 text-sm text-ink';

interface Status {
  bound: boolean;
  unreadable?: boolean;
  error?: string;
  parentUrl?: string;
  childHubId?: string;
  state?: 'active' | 'revoked';
  enrolledAt?: string;
  outboxDepth: number;
  releaseRequested?: boolean;
  canLeave?: boolean;
}

export function AdminFederation() {
  const qc = useQueryClient();
  const [parentUrl, setParentUrl] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);

  const status = useQuery<Status>({
    queryKey: ['admin-federation'],
    queryFn: async () => (await api.get('/v1/admin/federation')).data,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-federation'] });

  const join = useMutation({
    mutationFn: () => api.post('/v1/admin/federation/join', {
      parentUrl: parentUrl.trim(), inviteToken: inviteToken.trim(),
      // Omitted rather than sent empty, so the server picks its own default
      // instead of being handed a blank name to validate.
      ...(name.trim() ? { name: name.trim() } : {}),
    }),
    onSuccess: () => { setParentUrl(''); setInviteToken(''); setName(''); invalidate(); },
  });
  const requestRelease = useMutation({
    mutationFn: () => api.post('/v1/admin/federation/release-request', { reason: reason.trim() }),
    onSuccess: () => { setReason(''); invalidate(); },
  });
  const leave = useMutation({
    mutationFn: () => api.delete('/v1/admin/federation'),
    onSuccess: () => { setConfirmLeave(false); invalidate(); },
  });

  const d = status.data;

  if (status.isLoading) {
    return <section className={cardCls}><p className="text-xs text-ink-tertiary">Loading…</p></section>;
  }
  if (status.isError) {
    return (
      <section className={cardCls}>
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          Could not load federation status: {errText(status.error)}
        </p>
      </section>
    );
  }
  // A binding we cannot decrypt is NOT "no parent": saying so would invite an
  // admin to enrol again and end up with two.
  if (d?.unreadable) {
    return (
      <section className={cardCls}>
        <h2 className="text-sm font-semibold text-ink inline-flex items-center gap-1.5">
          <AlertTriangle className="w-4 h-4 text-amber-500" /> Parent hub
        </h2>
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          This hub has a parent, but its stored credential cannot be read: {d.error}
        </p>
        <p className="mt-2 text-xs text-ink-tertiary">
          This usually means AGENFK_HUB_SECRET_KEY changed. Restore the previous key, or ask the
          parent hub to detach this one and enrol again.
        </p>
      </section>
    );
  }

  if (!d?.bound) {
    return (
      <section className={cardCls}>
        <h2 className="text-sm font-semibold text-ink inline-flex items-center gap-1.5">
          <Network className="w-4 h-4" /> Parent hub
        </h2>
        <p className="mt-1 text-xs text-ink-tertiary">
          This hub is standalone. Join a group with a token from the parent hub&apos;s Child hubs tab.
        </p>
        <div className="mt-4 grid gap-2 max-w-lg">
          <label className="text-xs text-ink-tertiary">
            Parent hub URL
            <input aria-label="Parent hub URL" className={`mt-1 ${inputCls}`}
              value={parentUrl} onChange={e => setParentUrl(e.target.value)} placeholder="https://hub.example.com" />
          </label>
          <label className="text-xs text-ink-tertiary">
            Name on the parent&apos;s roster (optional)
            <input aria-label="Name on the parent's roster" className={`mt-1 ${inputCls}`}
              value={name} onChange={e => setName(e.target.value)} placeholder="acme-emea" />
          </label>
          <label className="text-xs text-ink-tertiary">
            Join token
            <input aria-label="Join token" className={`mt-1 ${inputCls}`}
              value={inviteToken} onChange={e => setInviteToken(e.target.value)} />
          </label>
          <div>
            <button type="button" onClick={() => join.mutate()}
              disabled={!parentUrl.trim() || !inviteToken.trim() || join.isPending}
              className="rounded-lg border border-border-soft px-3 py-1.5 text-xs font-medium text-ink hover:bg-chip disabled:opacity-50">
              Join
            </button>
          </div>
          {join.isError && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">{errText(join.error)}</p>
          )}
        </div>
      </section>
    );
  }

  // The server's own verdict, not a second copy of the rule. Two predicates
  // for one guarantee is how they drift.
  const released = d.canLeave === true;
  return (
    <div className="space-y-5">
      <section className={cardCls}>
        <h2 className="text-sm font-semibold text-ink inline-flex items-center gap-1.5">
          <Network className="w-4 h-4" /> Parent hub
        </h2>
        <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-xs text-ink-tertiary">Reports to</dt>
          <dd className="font-mono text-xs text-ink break-all">{d.parentUrl}</dd>
          <dt className="text-xs text-ink-tertiary">Known there as</dt>
          <dd className="font-mono text-xs text-ink">{d.childHubId}</dd>
          <dt className="text-xs text-ink-tertiary">Joined</dt>
          <dd className="text-xs text-ink">{d.enrolledAt ? fmtDateTime(d.enrolledAt) : '—'}</dd>
          <dt className="text-xs text-ink-tertiary">Waiting to send</dt>
          <dd className="text-xs text-ink tabular-nums">{d.outboxDepth}</dd>
          <dt className="text-xs text-ink-tertiary">Status</dt>
          <dd className="text-xs text-ink">
            {released ? 'released by the parent — this hub may now leave' : 'active'}
          </dd>
        </dl>
      </section>

      {!released && (
        <section className={cardCls}>
          <h3 className="text-sm font-semibold text-ink">Leaving this group</h3>
          <p className="mt-2 text-xs text-ink-tertiary">
            Only the parent hub can release this hub. Ask it to, and once an administrator there
            detaches this one, Leave becomes available.
          </p>
          {d.releaseRequested ? (
            <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <Clock className="w-3.5 h-3.5" /> Waiting for the parent hub to release this hub.
            </p>
          ) : (
            <div className="mt-3 grid gap-2 max-w-lg">
              <label className="text-xs text-ink-tertiary">
                Reason (optional)
                <input aria-label="Reason" className={`mt-1 ${inputCls}`}
                  value={reason} onChange={e => setReason(e.target.value)} />
              </label>
              <div>
                <button type="button" onClick={() => requestRelease.mutate()} disabled={requestRelease.isPending}
                  className="rounded-lg border border-border-soft px-3 py-1.5 text-xs font-medium text-ink hover:bg-chip disabled:opacity-50">
                  Request release
                </button>
              </div>
            </div>
          )}
          {requestRelease.isError && (
            <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{errText(requestRelease.error)}</p>
          )}
          <div className="mt-4">
            <button type="button" disabled
              title="Only the parent hub can release this hub"
              className="rounded-lg border border-border-soft px-3 py-1.5 text-xs text-ink-tertiary opacity-50">
              Leave
            </button>
          </div>
        </section>
      )}

      {released && (
        <section className={cardCls}>
          <h3 className="text-sm font-semibold text-ink">This hub has been released</h3>
          <p className="mt-2 text-xs text-ink-tertiary">
            The parent has detached it, so it no longer receives anything from the group. Leaving
            clears the stored credential.
          </p>
          <div className="mt-3">
            <button type="button" onClick={() => setConfirmLeave(true)}
              className="rounded-lg border border-border-soft px-3 py-1.5 text-xs font-medium text-ink hover:bg-chip">
              Leave
            </button>
          </div>
          {confirmLeave && (
            <div className="mt-3 rounded-xl border border-border-soft p-3">
              <p className="text-xs text-ink">
                Clear this hub&apos;s parent? It becomes standalone again.
              </p>
              {d.outboxDepth > 0 && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  {d.outboxDepth} queued item(s) were never delivered. They stay on this hub, but
                  nothing will send them.
                </p>
              )}
              <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={() => leave.mutate()} disabled={leave.isPending}
                  className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-chip disabled:opacity-50">
                  Yes, leave
                </button>
                <button type="button" onClick={() => setConfirmLeave(false)}
                  className="rounded-lg px-3 py-1.5 text-xs text-ink-tertiary hover:bg-chip">
                  Cancel
                </button>
              </div>
              {leave.isError && (
                <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{errText(leave.error)}</p>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
