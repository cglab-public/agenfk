/**
 * Admin → Identities tab (task f78c0849).
 *
 * The hub attributes every event with `gitEmail || osUser`, so an install with
 * no git email files its work under an OS username. When that person later sets
 * their email they become a second identity, and the only way back is a merge —
 * which rewrites history and cannot be undone.
 *
 * So this page does three things in order of preference: prevent (show the
 * installs still attributed by username), repair the unambiguous cases with one
 * click, and refuse to make the risky ones easy.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, AlertTriangle, Merge, History, ShieldAlert, Undo2 } from 'lucide-react';
import { api } from '../api';
import {
  canMergeInOneClick,
  mergeBlockedReason,
  sortSuggestions,
  suggestionSummary,
  isValidManualMerge,
  type SuggestionLike,
} from './identityPanel';
import { isAttributedByUsername } from './attributionWarning';

const cardCls = 'bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5';

interface MergeRecord {
  id: string;
  from: string;
  to: string;
  eventsMoved: number;
  mergedByEmail: string | null;
  revertedAt: string | null;
  createdAt: string | null;
}

interface InstallationRow {
  id: string;
  gitName: string | null;
  gitEmail: string | null;
  osUser: string | null;
}

const fmtDay = (iso: string | null) => (iso ? String(iso).slice(0, 10) : '—');

export function AdminIdentities() {
  const qc = useQueryClient();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);

  const suggestionsQ = useQuery<SuggestionLike[]>({
    queryKey: ['admin-identity-suggestions'],
    queryFn: async () => (await api.get('/v1/admin/identity-suggestions')).data,
  });
  const mergesQ = useQuery<MergeRecord[]>({
    queryKey: ['admin-user-key-merges'],
    queryFn: async () => (await api.get('/v1/admin/user-keys/merges')).data,
  });
  const installsQ = useQuery<InstallationRow[]>({
    queryKey: ['admin-installations', false, false],
    queryFn: async () => (await api.get('/v1/admin/installations')).data,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-identity-suggestions'] });
    qc.invalidateQueries({ queryKey: ['admin-user-key-merges'] });
    qc.invalidateQueries({ queryKey: ['admin-installations'] });
  };
  const revert = useMutation({
    mutationFn: (id: string) => api.post(`/v1/admin/user-keys/merges/${encodeURIComponent(id)}/revert`),
    onSuccess: (r: any) => {
      // A zero-restore is a real outcome, not a failure: a newer merge has
      // claimed those rows and must be reverted first.
      setError(r?.data?.eventsRestored === 0 ? (r?.data?.note ?? null) : null);
      invalidate();
    },
    onError: (e: any) => setError(e?.response?.data?.error ?? 'Revert failed'),
  });
  const merge = useMutation({
    mutationFn: (v: { from: string; to: string }) => api.post('/v1/admin/user-keys/merge', v),
    onSuccess: () => { setFrom(''); setTo(''); setError(null); invalidate(); },
    onError: (e: any) => setError(e?.response?.data?.error ?? 'Merge failed'),
  });

  const suggestions = sortSuggestions(suggestionsQ.data ?? []);
  const summary = suggestionSummary(suggestions);
  const misattributed = (installsQ.data ?? []).filter(isAttributedByUsername);

  return (
    <div className="space-y-6">
      <section className={cardCls}>
        <header className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink inline-flex items-center gap-1.5">
              <Users className="w-4 h-4" /> Identity suggestions
            </h3>
            <p className="mt-0.5 text-xs text-ink-tertiary">
              An installation whose history was recorded under one identity but which now reports a
              different one. Merging rewrites history and cannot be undone, so only unambiguous
              cases are offered as a single action.
            </p>
          </div>
          {summary.total > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums text-ink-tertiary shrink-0">
              <span>{summary.ready} ready</span>
              {summary.conflated > 0 && <span className="text-amber-600 dark:text-amber-400">{summary.conflated} need review</span>}
              {summary.blocked > 0 && <span className="text-amber-600 dark:text-amber-400">{summary.blocked} blocked</span>}
            </div>
          )}
        </header>

        {suggestions.length === 0 && (
          <p className="mt-4 text-sm text-ink-tertiary">
            {suggestionQLoading(suggestionsQ) ? 'Loading…' : 'No split identities detected.'}
          </p>
        )}

        <div className="mt-4 space-y-3">
          {suggestions.map(sug => {
            const blocked = mergeBlockedReason(sug);
            return (
              <div key={`${sug.from}->${sug.to}`} className="rounded-lg border border-border-soft bg-surface p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-ink font-mono break-all">
                      {sug.from} <span className="text-ink-tertiary">→</span> {sug.to}
                    </div>
                    <div className="mt-1 text-[11px] text-ink-tertiary tabular-nums">
                      {sug.events} event{sug.events === 1 ? '' : 's'} · {fmtDay(sug.firstSeen)} → {fmtDay(sug.lastSeen)}
                      {' · '}
                      {sug.sourceInstallationCount} installation{sug.sourceInstallationCount === 1 ? '' : 's'}
                    </div>
                  </div>
                  <button
                    onClick={() => merge.mutate({ from: sug.from, to: sug.to })}
                    disabled={!canMergeInOneClick(sug) || merge.isPending}
                    title={blocked ?? 'Merge this identity'}
                    className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-border-brand bg-chip px-2.5 py-1.5 text-[11px] font-semibold text-accent-text disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Merge className="w-3.5 h-3.5" /> Merge
                  </button>
                </div>
                {blocked && (
                  <p className="mt-2 inline-flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                    <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-px" /> {blocked}
                  </p>
                )}
                {sug.confidence === 'conflated' && (
                  <ul className="mt-2 space-y-0.5">
                    {sug.installations.map(id => (
                      <li key={id} className="font-mono text-[11px] text-ink-tertiary">{id}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className={cardCls}>
        <h3 className="text-sm font-semibold text-ink">Merge manually</h3>
        <p className="mt-0.5 text-xs text-ink-tertiary">
          For cases detection cannot infer — a changed employer domain, say. The source must have no
          live API key, or the hub will refuse.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={from}
            onChange={e => setFrom(e.target.value)}
            placeholder="from (old identity)"
            className="flex-1 min-w-[12rem] rounded-lg border border-border-soft bg-surface px-3 py-2 text-sm text-ink font-mono"
          />
          <span className="text-ink-tertiary">→</span>
          <input
            value={to}
            onChange={e => setTo(e.target.value)}
            placeholder="to (kept identity)"
            className="flex-1 min-w-[12rem] rounded-lg border border-border-soft bg-surface px-3 py-2 text-sm text-ink font-mono"
          />
          <button
            onClick={() => merge.mutate({ from: from.trim(), to: to.trim() })}
            disabled={!isValidManualMerge(from, to) || merge.isPending}
            className="rounded-lg border border-border-brand bg-chip px-3 py-2 text-xs font-semibold text-accent-text disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Merge
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </section>

      {misattributed.length > 0 && (
        <section className={cardCls}>
          <h3 className="text-sm font-semibold text-ink inline-flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4" /> Attributed by username
          </h3>
          <p className="mt-0.5 text-xs text-ink-tertiary">
            These installs have no git email, so their work is filed under an OS username. Each one
            becomes a future merge the day its owner sets <code>user.email</code> — fixing it at the
            source is cheaper than repairing it here.
          </p>
          <ul className="mt-3 space-y-1">
            {misattributed.map(i => (
              <li key={i.id} className="text-[11px] text-ink-tertiary">
                <span className="font-mono">{i.id.slice(0, 8)}…</span>
                {' · '}
                <span className="text-ink-secondary">{i.gitName ?? i.osUser ?? 'unknown'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={cardCls}>
        <h3 className="text-sm font-semibold text-ink inline-flex items-center gap-1.5">
          <History className="w-4 h-4" /> Merge history
        </h3>
        <p className="mt-0.5 text-xs text-ink-tertiary">
          Each merge can be reverted, which moves exactly the events it touched back. Revert the
          newest first: a later merge that claimed the same events has to be undone before an
          earlier one can be.
        </p>
        {(mergesQ.data ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-ink-tertiary">Nothing merged yet.</p>
        ) : (
          <div className="mt-3 -mx-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-tertiary font-semibold">
                  <th className="text-left px-5 py-2">Merge</th>
                  <th className="text-right px-2 py-2">Events</th>
                  <th className="text-left px-2 py-2">By</th>
                  <th className="text-right px-2 py-2">When</th>
                  <th className="text-right px-5 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-soft">
                {mergesQ.data!.map(m => (
                  <tr key={m.id}>
                    <td className="px-5 py-2 font-mono text-[11px] text-ink-secondary break-all">
                      {m.from} → {m.to}
                    </td>
                    <td className="px-2 py-2 text-right text-[11px] text-ink-tertiary tabular-nums">{m.eventsMoved}</td>
                    <td className="px-2 py-2 text-[11px] text-ink-tertiary">{m.mergedByEmail ?? '—'}</td>
                    <td className="px-2 py-2 text-right text-[11px] text-ink-tertiary tabular-nums">{fmtDay(m.createdAt)}</td>
                    <td className="px-5 py-2 text-right">
                      {m.revertedAt ? (
                        <span className="text-[11px] text-ink-tertiary">reverted {fmtDay(m.revertedAt)}</span>
                      ) : (
                        <button
                          onClick={() => revert.mutate(m.id)}
                          disabled={revert.isPending}
                          title="Move these events back to their original identity"
                          className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-tertiary hover:text-amber-600 dark:hover:text-amber-400"
                        >
                          <Undo2 className="w-3.5 h-3.5" /> Revert
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** Keeps the empty-state honest: "none detected" is a claim, "loading" is not. */
function suggestionQLoading(q: { isLoading: boolean; isFetching: boolean; data: unknown }): boolean {
  return q.isLoading || (q.isFetching && q.data === undefined);
}
