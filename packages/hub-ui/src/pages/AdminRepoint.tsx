/**
 * Admin → Repoint section (CGLAB-66).
 *
 * A hub can change DNS name without anyone rejoining, but only if you can tell
 * when it is safe to drop the old name. This board is that answer: it opens a
 * campaign onto the new URL, shows each installation's progress, and refuses to
 * say "safe" until every one of them has confirmed ON the new hostname.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, AlertTriangle, CheckCircle2, Clock, Ban } from 'lucide-react';
import { api } from '../api';
import {
  classifyTarget,
  sortTargets,
  drainSummary,
  canDropOldName,
  type RepointTargetLike,
  type TargetClass,
} from './repointBoard';

const cardCls = 'bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5';

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
  done: 'text-emerald-600 dark:text-emerald-400',
  waiting: 'text-ink-tertiary',
  stale: 'text-amber-600 dark:text-amber-400',
  blocked: 'text-amber-600 dark:text-amber-400',
  failed: 'text-red-600 dark:text-red-400',
};

function ClassIcon({ cls }: { cls: TargetClass }) {
  if (cls === 'done') return <CheckCircle2 className="w-3.5 h-3.5" />;
  if (cls === 'failed') return <AlertTriangle className="w-3.5 h-3.5" />;
  if (cls === 'blocked') return <Ban className="w-3.5 h-3.5" />;
  return <Clock className="w-3.5 h-3.5" />;
}

export function AdminRepoint() {
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
  const targets = board.data?.targets ?? [];
  const openedAt = campaign?.createdAt ?? '';
  const summary = drainSummary(targets, openedAt);
  const safe = canDropOldName(targets, openedAt);
  const openError = (open.error as any)?.response?.data?.error ?? null;

  return (
    <div className="space-y-6">
      <section className={cardCls}>
        <header>
          <h3 className="text-sm font-semibold text-ink inline-flex items-center gap-1.5">
            <ArrowRightLeft className="w-4 h-4" /> Move this hub to a new address
          </h3>
          <p className="mt-0.5 text-xs text-ink-tertiary">
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
              placeholder="https://hub.new-domain.com"
              className="flex-1 rounded-lg border border-border-soft bg-surface px-3 py-2 text-sm text-ink"
            />
            <button
              onClick={() => open.mutate()}
              disabled={!targetUrl.trim() || open.isPending}
              className="rounded-lg border border-border-brand bg-chip px-3 py-2 text-xs font-semibold text-accent-text disabled:opacity-50"
            >
              Start campaign
            </button>
          </div>
        )}
        {openError && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">{String(openError)}</p>
        )}

        {campaign && (
          <div className="mt-4 rounded-lg border border-border-soft bg-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs text-ink-tertiary">Moving to</div>
                <div className="font-mono text-sm text-ink">{campaign.targetUrl}</div>
              </div>
              <button
                onClick={() => close.mutate(campaign.id)}
                disabled={close.isPending}
                className="text-[11px] font-semibold text-ink-tertiary hover:text-ink"
              >
                Close campaign
              </button>
            </div>

            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-tertiary tabular-nums">
              <span>{summary.done}/{summary.total} moved</span>
              {summary.waiting > 0 && <span>{summary.waiting} waiting</span>}
              {summary.stale > 0 && <span className="text-amber-600 dark:text-amber-400">{summary.stale} not checking in</span>}
              {summary.blocked > 0 && <span className="text-amber-600 dark:text-amber-400">{summary.blocked} blocked</span>}
              {summary.failed > 0 && <span className="text-red-600 dark:text-red-400">{summary.failed} failed</span>}
            </div>

            <p className={`mt-3 text-xs ${safe ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink-tertiary'}`}>
              {safe
                ? 'Every installation has confirmed on the new address. Delete the old DNS record — do not point it at a proxy that answers 404.'
                : 'Keep serving the old address. Installations that stopped checking in will never move on their own: retire them under Installations to finish the campaign.'}
            </p>
          </div>
        )}
      </section>

      {campaign && (
        <section className={cardCls}>
          <h3 className="text-sm font-semibold text-ink">Fleet</h3>
          <div className="mt-3 -mx-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-tertiary font-semibold">
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
                    <tr key={t.installationId} className="hover:bg-chip transition-colors">
                      <td className="px-5 py-2.5 font-mono text-[11px] text-ink-secondary">{t.installationId}</td>
                      <td className="px-2 py-2.5 text-xs text-ink-secondary">
                        {t.gitEmail ?? t.gitName ?? t.osUser ?? <span className="text-ink-tertiary">—</span>}
                      </td>
                      <td className={`px-2 py-2.5 text-xs font-semibold ${CLASS_STYLE[cls]}`}>
                        <span className="inline-flex items-center gap-1.5"><ClassIcon cls={cls} /> {CLASS_LABEL[cls]}</span>
                      </td>
                      <td className="px-2 py-2.5 text-[11px] text-ink-tertiary">
                        {t.errorMessage ?? t.reportedUrl ?? '—'}
                      </td>
                    </tr>
                  );
                })}
                {targets.length === 0 && (
                  <tr><td colSpan={4} className="px-5 py-6 text-center text-sm text-ink-tertiary">No live installations are targeted.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
