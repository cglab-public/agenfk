/**
 * Admin → Upgrades section.
 *
 * Surfaces the Story-2 hub directive API: lets a hub admin push a specific
 * agenfk version to the fleet (or to a single installation) and watch the
 * per-installation rollout live. Auto-refreshes while any directive has
 * pending or in-progress targets.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { api } from '../api';

interface UpgradeTarget {
  installationId: string;
  state: 'pending' | 'in_progress' | 'succeeded' | 'failed';
  attemptedAt: string | null;
  finishedAt: string | null;
  resultVersion: string | null;
  errorMessage: string | null;
  agenfkVersion: string | null;
  agenfkVersionUpdatedAt: string | null;
}

interface Directive {
  directiveId: string;
  targetVersion: string;
  scope: { type: 'all' | 'installation'; installationId?: string | null };
  createdAt: string;
  createdByUserId: string | null;
  expiresAt: string | null;
  progress: { pending: number; in_progress: number; succeeded: number; failed: number };
  targets: UpgradeTarget[];
}

interface ApiKeyRow { tokenHashPreview: string; label: string | null; installationId: string | null; gitName: string | null; gitEmail: string | null; revokedAt: string | null }

const SEMVER_HINT_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function AdminUpgrades() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [targetVersion, setTargetVersion] = useState('');
  const [scopeMode, setScopeMode] = useState<'all' | 'installation'>('all');
  const [scopeInstallationId, setScopeInstallationId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const directivesQ = useQuery<{ directives: Directive[] }>({
    queryKey: ['admin-upgrade'],
    queryFn: async () => (await api.get('/v1/admin/upgrade')).data,
    refetchInterval: (q) => {
      const data = (q.state.data as { directives: Directive[] } | undefined)?.directives ?? [];
      const live = data.some(d => d.progress.pending > 0 || d.progress.in_progress > 0);
      return live ? 5_000 : false;
    },
  });

  const apiKeysQ = useQuery<ApiKeyRow[]>({
    queryKey: ['admin-api-keys'],
    queryFn: async () => (await api.get('/v1/admin/api-keys')).data,
  });

  const installationOptions = useMemo(() =>
    (apiKeysQ.data ?? [])
      .filter(k => k.installationId && !k.revokedAt)
      .map(k => ({
        id: k.installationId!,
        label: [k.label, k.gitName ?? k.gitEmail].filter(Boolean).join(' — ') || k.installationId!,
      })),
    [apiKeysQ.data],
  );

  const issueMut = useMutation({
    mutationFn: async (body: { targetVersion: string; scope: { type: 'all' | 'installation'; installationId?: string } }) => {
      const r = await api.post('/v1/admin/upgrade', body);
      return r.data;
    },
    onSuccess: () => {
      setShowForm(false);
      setTargetVersion('');
      setScopeMode('all');
      setScopeInstallationId('');
      setError(null);
      qc.invalidateQueries({ queryKey: ['admin-upgrade'] });
    },
    onError: (e: any) => {
      setError(e?.response?.data?.error ?? e?.message ?? 'Failed to issue directive');
    },
  });

  const onSubmit = () => {
    setError(null);
    if (!SEMVER_HINT_RE.test(targetVersion)) {
      setError('targetVersion must look like 0.3.1 or 0.3.0-beta.22');
      return;
    }
    const scope = scopeMode === 'all'
      ? { type: 'all' as const }
      : { type: 'installation' as const, installationId: scopeInstallationId };
    if (scope.type === 'installation' && !scope.installationId) {
      setError('Pick an installation when scoping to one');
      return;
    }
    const targetCount = scope.type === 'all' ? installationOptions.length : 1;
    if (!confirm(`This will upgrade ${targetCount} installation${targetCount === 1 ? '' : 's'} to v${targetVersion}. Continue?`)) return;
    issueMut.mutate({ targetVersion, scope });
  };

  const toggleExpanded = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpanded(next);
  };

  const directives = directivesQ.data?.directives ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Fleet upgrades</h3>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="text-[12px] inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-500"
          >
            <Plus className="w-3.5 h-3.5" /> Issue upgrade
          </button>
        )}
      </div>

      {showForm && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 space-y-3">
          <div>
            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Target version</label>
            <input
              type="text" value={targetVersion} onChange={(e) => setTargetVersion(e.target.value)}
              placeholder="e.g. 0.3.1 or 0.3.0-beta.22"
              className="w-full px-2 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-800"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Scope</label>
            <div className="flex gap-2">
              <button
                onClick={() => setScopeMode('all')}
                className={`text-[12px] px-2 py-1 rounded ${scopeMode === 'all' ? 'bg-indigo-600 text-white' : 'border border-slate-300 dark:border-slate-600'}`}
              >All ({installationOptions.length})</button>
              <button
                onClick={() => setScopeMode('installation')}
                className={`text-[12px] px-2 py-1 rounded ${scopeMode === 'installation' ? 'bg-indigo-600 text-white' : 'border border-slate-300 dark:border-slate-600'}`}
              >Single installation</button>
            </div>
            {scopeMode === 'installation' && (
              <select
                value={scopeInstallationId}
                onChange={(e) => setScopeInstallationId(e.target.value)}
                className="mt-2 w-full px-2 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-800"
              >
                <option value="">Pick an installation…</option>
                {installationOptions.map(o => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            )}
          </div>
          {error && (
            <div className="text-[12px] text-rose-600 dark:text-rose-400 inline-flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" /> {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => { setShowForm(false); setError(null); }} className="text-[12px] px-2 py-1 text-slate-600 dark:text-slate-300">Cancel</button>
            <button
              onClick={onSubmit} disabled={issueMut.isPending}
              className="text-[12px] px-2.5 py-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50"
            >Issue</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {directives.length === 0 && (
          <p className="text-[12px] text-slate-400 dark:text-slate-500">No directives issued yet.</p>
        )}
        {directives.map(d => {
          const isOpen = expanded.has(d.directiveId);
          return (
            <div key={d.directiveId} className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
              <button
                onClick={() => toggleExpanded(d.directiveId)}
                className="w-full flex items-center justify-between px-3 py-2 text-left"
              >
                <span className="flex items-center gap-2 min-w-0">
                  {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <span className="font-mono text-[12px] text-slate-700 dark:text-slate-200">v{d.targetVersion}</span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                    {d.scope.type === 'all' ? 'all installations' : `installation ${d.scope.installationId}`}
                    {' · '}{new Date(d.createdAt).toLocaleString()}
                  </span>
                </span>
                <span className="flex items-center gap-1.5 text-[11px]">
                  {d.progress.pending > 0 && <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">{d.progress.pending} pending</span>}
                  {d.progress.in_progress > 0 && <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">{d.progress.in_progress} running</span>}
                  {d.progress.succeeded > 0 && <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">{d.progress.succeeded} ok</span>}
                  {d.progress.failed > 0 && <span className="px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300">{d.progress.failed} failed</span>}
                </span>
              </button>
              {isOpen && d.targets.length > 0 && (
                <div className="border-t border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800">
                  {d.targets.map(t => (
                    <div key={t.installationId} className="flex items-center justify-between gap-3 px-3 py-1.5 text-[11px]">
                      <span className="font-mono text-slate-600 dark:text-slate-300 truncate">{t.installationId}</span>
                      <span className="flex items-center gap-2 shrink-0">
                        {t.agenfkVersion && (
                          <span className="font-mono text-slate-500 dark:text-slate-400" title={`last seen ${t.agenfkVersionUpdatedAt ?? '?'}`}>
                            v{t.agenfkVersion}
                          </span>
                        )}
                        <StatePill state={t.state} />
                        {t.errorMessage && <span className="text-rose-500 dark:text-rose-400 truncate max-w-[18ch]" title={t.errorMessage}>{t.errorMessage}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatePill({ state }: { state: UpgradeTarget['state'] }) {
  const cls = state === 'succeeded' ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
    : state === 'failed' ? 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300'
    : state === 'in_progress' ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300';
  return <span className={`px-1.5 py-0.5 rounded ${cls}`}>{state}</span>;
}
