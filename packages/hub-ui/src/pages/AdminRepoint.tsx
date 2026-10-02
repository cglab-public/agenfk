/**
 * Admin → Repoint section (CGLAB-66).
 *
 * A hub can change DNS name without anyone rejoining, but only if you can tell
 * when it is safe to drop the old name. This board is that answer: it opens a
 * campaign onto the new URL, shows each installation's progress, and refuses to
 * say "safe" until every one of them has confirmed ON the new hostname.
 */
import { useState } from 'react';
import { addressChangeError } from './adminValidation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, AlertTriangle, CheckCircle2, Clock, Ban } from 'lucide-react';
import { api } from '../api';
import { cardClass, InlineError, useConfirm } from '../components/ui';
import {
  classifyTarget,
  sortTargets,
  drainSummary,
  canDropOldName,
  type RepointTargetLike,
  type TargetClass,
} from './repointBoard';

const cardCls = cardClass;

interface BoardResponse {
  campaign: { id: string; targetUrl: string; allowedHost: string; createdAt: string } | null;
  counts: Record<string, number>;
  targets: RepointTargetLike[];
  drained: boolean;
}

const CLASS_LABEL: Record<TargetClass, string> = {
  done: 'moved',
  waiting: 'waiting',
  stale: 'not checking in',
  blocked: 'blocked by env',
  failed: 'failed',
};

const CLASS_STYLE: Record<TargetClass, string> = {
  done: 'text-status-ok-text',
  waiting: 'text-ink-tertiary',
  stale: 'text-status-warn-text',
  blocked: 'text-status-warn-text',
  failed: 'text-status-danger-text',
};

function ClassIcon({ cls }: { cls: TargetClass }) {
  if (cls === 'done') return <CheckCircle2 className="w-3.5 h-3.5" />;
  if (cls === 'failed') return <AlertTriangle className="w-3.5 h-3.5" />;
  if (cls === 'blocked') return <Ban className="w-3.5 h-3.5" />;
  return <Clock className="w-3.5 h-3.5" />;
}

export function AdminRepoint() {
  const { confirm, dialog } = useConfirm();
  const qc = useQueryClient();
  const [targetUrl, setTargetUrl] = useState('');

  const board = useQuery<BoardResponse>({
    queryKey: ['admin-repoint'],
    queryFn: async () => (await api.get('/v1/admin/repoint')).data,
    // Installations poll on their own slow cadence, so refresh while a campaign
    // is open rather than making the admin reload to watch it drain.
    refetchInterval: (q) => (q.state.data?.campaign ? 15_000 : false),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-repoint'] });
    qc.invalidateQueries({ queryKey: ['admin-installations'] });
  };
  const open = useMutation({
    mutationFn: () => api.post('/v1/admin/repoint', { targetUrl: targetUrl.trim() }),
    onSuccess: () => { setTargetUrl(''); invalidate(); },
  });
  const close = useMutation({
    mutationFn: (id: string) => api.post(`/v1/admin/repoint/${encodeURIComponent(id)}/close`),
    onSuccess: invalidate,
  });

  const campaign = board.data?.campaign ?? null;
  const [urlTouched, setUrlTouched] = useState(false);
  const urlProblem = addressChangeError(targetUrl);
  // Shown once the admin leaves the field; the button is disabled either way.
  const urlError = urlTouched ? urlProblem : null;
  const targets = board.data?.targets ?? [];
  const openedAt = campaign?.createdAt ?? '';
  const summary = drainSummary(targets, openedAt);
  const safe = canDropOldName(targets, openedAt);
  const openError = (open.error as any)?.response?.data?.error ?? null;

  return (
    <div className="space-y-6">
      {dialog}
      <section className={cardCls}>
        <header>
          <h3 className="text-body font-semibold text-ink inline-flex items-center gap-1.5">
            <ArrowRightLeft className="w-4 h-4" /> Move this hub to a new address
          </h3>
          <p className="mt-0.5 text-small text-ink-tertiary">
            Serve both DNS names while this runs. Each installation verifies the new address
            before it switches, and reports back on the new name — that confirmation is the
            only evidence that it really moved.
          </p>
        </header>

        {!campaign && (
          <div className="mt-4 flex items-center gap-2">
            <input
              value={targetUrl}
              onChange={e => setTargetUrl(e.target.value)}
              onBlur={() => setUrlTouched(true)}
              placeholder="https://hub.new-domain.com"
              aria-label="New hub address"
              aria-invalid={!!urlError}
              aria-describedby={urlError ? 'address-change-url-error' : undefined}
              className="flex-1 rounded-lg border border-border-soft bg-surface px-3 py-2 text-body text-ink"
            />
            <button
              onClick={async () => {
                if (await confirm({
                  title: `Move this hub to ${targetUrl.trim()}?`,
                  body: 'Every installation will be told to switch to the new address once it can reach it there. '
                    + 'Keep serving both addresses until the board says every installation has moved.',
                  confirmLabel: 'Start the address change',
                  tone: 'default',
                })) open.mutate();
              }}
              disabled={!targetUrl.trim() || !!urlProblem || open.isPending}
              className="rounded-lg border border-accent bg-accent-fill px-3 py-2 text-small font-semibold text-accent-ink disabled:opacity-50"
            >
              Start the address change
            </button>
          </div>
        )}
        {!campaign && urlError && (
          <p id="address-change-url-error" className="mt-2 text-small text-status-danger-text">{urlError}</p>
        )}
        {openError && (
          <p className="mt-2 text-small text-status-danger-text">{String(openError)}</p>
        )}

        {campaign && (
          <div className="mt-4 rounded-lg border border-border-soft bg-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-small text-ink-tertiary">Moving to</div>
                <div className="font-mono text-body text-ink">{campaign.targetUrl}</div>
              </div>
              <button
                onClick={async () => {
                  if (await confirm({
                    title: 'End the address change?',
                    body: `Installations that have not moved to ${campaign.targetUrl} yet stay on the old address `
                      + 'and stop being asked to move. Only end it once every installation has moved, or the rest are retired.',
                    confirmLabel: 'End the address change',
                  })) close.mutate(campaign.id);
                }}
                disabled={close.isPending}
                className="text-caption font-semibold text-ink-tertiary hover:text-ink"
              >
                End the address change
              </button>
            </div>
            <InlineError error={close.error} className="mt-2" />

            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-tertiary tabular-nums">
              <span>{summary.done}/{summary.total} moved</span>
              {summary.waiting > 0 && <span>{summary.waiting} waiting</span>}
              {summary.stale > 0 && <span className="text-status-warn-text">{summary.stale} not checking in</span>}
              {summary.blocked > 0 && <span className="text-status-warn-text">{summary.blocked} blocked</span>}
              {summary.failed > 0 && <span className="text-status-danger-text">{summary.failed} failed</span>}
            </div>

            <p className={`mt-3 text-small ${safe ? 'text-status-ok-text' : 'text-ink-tertiary'}`}>
              {safe
                ? 'Every installation has confirmed on the new address. Delete the old DNS record — do not point it at a proxy that answers 404.'
                : 'Keep serving the old address. Installations that stopped checking in will never move on their own: retire them under Installations to finish the address change.'}
            </p>
          </div>
        )}
      </section>

      {campaign && (
        <section className={cardCls}>
          <h3 className="text-body font-semibold text-ink">Fleet</h3>
          <div className="mt-3 -mx-5 overflow-x-auto">
            <table className="w-full text-body">
              <thead>
                <tr className="eyebrow text-ink-tertiary">
                  <th className="text-left px-5 py-2">Installation</th>
                  <th className="text-left px-2 py-2">User</th>
                  <th className="text-left px-2 py-2">State</th>
                  <th className="text-left px-2 py-2">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-soft">
                {sortTargets(targets, openedAt).map(t => {
                  const cls = classifyTarget(t, openedAt);
                  return (
                    <tr key={t.installationId} className="hover:bg-accent-fill transition-colors">
                      <td className="px-5 py-2.5 font-mono text-caption text-ink-secondary">{t.installationId}</td>
                      <td className="px-2 py-2.5 text-small text-ink-secondary">
                        {t.gitEmail ?? t.gitName ?? t.osUser ?? <span className="text-ink-tertiary">—</span>}
                      </td>
                      <td className={`px-2 py-2.5 text-small font-semibold ${CLASS_STYLE[cls]}`}>
                        <span className="inline-flex items-center gap-1.5"><ClassIcon cls={cls} /> {CLASS_LABEL[cls]}</span>
                      </td>
                      <td className="px-2 py-2.5 text-caption text-ink-tertiary">
                        {t.errorMessage ?? t.reportedUrl ?? '—'}
                      </td>
                    </tr>
                  );
                })}
                {targets.length === 0 && (
                  <tr><td colSpan={4} className="px-5 py-6 text-center text-body text-ink-tertiary">No live installations are targeted.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
