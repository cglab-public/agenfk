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
import { groupUpgradeBody, groupUpgradeRow, groupUpgradesLive, type GroupUpgradeRequest } from './groupUpgradeState';
import { ChildHubPicker, toggledSet } from './childHubPicker';
import { dispatchRefusalMessage, liveChildHubs, type ChildHubRow, type DispatchScopeMode } from './flowDispatch';

interface UpgradeTarget {
  installationId: string;
  state: 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'cancelled';
  attemptedAt: string | null;
  finishedAt: string | null;
  resultVersion: string | null;
  errorMessage: string | null;
  // Live identity from the installations row. Preferred over the api_key label,
  // which is a snapshot from issue time and goes stale.
  gitName?: string | null;
  gitEmail?: string | null;
  osUser?: string | null;
  agenfkVersion: string | null;
  agenfkVersionUpdatedAt: string | null;
}

interface Directive {
  directiveId: string;
  targetVersion: string;
  scope: { type: 'all' | 'installation' | 'installations'; installationId?: string | null };
  createdAt: string;
  createdByUserId: string | null;
  createdByEmail: string | null;
  requestIp: string | null;
  expiresAt: string | null;
  progress: { pending: number; in_progress: number; succeeded: number; failed: number; cancelled: number };
  targets: UpgradeTarget[];
}

interface ApiKeyRow { tokenHashPreview: string; label: string | null; installationId: string | null; gitName: string | null; gitEmail: string | null; revokedAt: string | null }

interface AvailableVersionsResponse { versions: string[]; fleetFloor: string | null }

import { canIssueDirective } from './adminUpgradesGate';
import { installationDisplayName } from './installationDisplayName';
import { buildInstallationOptions, type InstallationRow } from './installationOptions';
import { filterInstallationOptions } from './filterInstallationOptions';

interface GroupTarget {
  childHubId: string;
  name: string;
  state: string;
  detail: {
    counts?: { pending: number; updated: number; failed: number; skipped: number };
    skipped?: Array<{ installationId: string; reason: string }>;
  } | null;
}

interface GroupDispatch {
  id: string;
  targetVersion: string;
  scope: string;
  cancelledAt: string | null;
  targets: GroupTarget[];
}

export function AdminUpgrades() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [targetVersion, setTargetVersion] = useState('');
  const [scopeMode, setScopeMode] = useState<'all' | 'installations'>('all');
  const [selectedInstallationIds, setSelectedInstallationIds] = useState<Set<string>>(new Set());
  const [installationFilter, setInstallationFilter] = useState('');
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

  const availableVersionsQ = useQuery<AvailableVersionsResponse>({
    queryKey: ['admin-available-versions'],
    queryFn: async () => (await api.get('/v1/admin/upgrade/available-versions')).data,
    staleTime: 5 * 60 * 1000,
  });

  // The picker's actual source of truth: one row per MACHINE. Deriving it from
  // api_keys repeated any machine holding several keys and dropped machines
  // whose live key had no installation binding (BUG bb27c0aa).
  const installationsQ = useQuery<InstallationRow[]>({
    queryKey: ['admin-installations'],
    queryFn: async () => (await api.get('/v1/admin/installations')).data,
  });

  const installationOptions = useMemo(
    () => buildInstallationOptions(installationsQ.data ?? [], apiKeysQ.data ?? []),
    [installationsQ.data, apiKeysQ.data],
  );

  const cancelMut = useMutation({
    mutationFn: async ({ directiveId, force }: { directiveId: string; force?: boolean }) => {
      const r = await api.post(`/v1/admin/upgrade/${directiveId}/cancel`, force ? { force: true } : {});
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-upgrade'] });
    },
    onError: (e: any) => {
      const data = e?.response?.data;
      setError(data?.error ?? e?.message ?? 'Failed to cancel directive');
    },
  });

  const onCancel = (d: Directive) => {
    const { pending, in_progress } = d.progress;
    if (pending > 0) {
      if (!confirm(`Cancel ${pending} pending upgrade${pending === 1 ? '' : 's'} for v${d.targetVersion}? Installations already running or finished will not be affected.`)) return;
    }
    let force = false;
    if (in_progress > 0) {
      // Distinct, explicit opt-in: a running target may be a genuinely live
      // flight — but it may also be a dead agent wedging the installation
      // (new directives are refused while it stays in_progress).
      force = confirm(
        `⚠️ ${in_progress} target${in_progress === 1 ? ' is' : 's are'} in_progress. ` +
        `Force-cancel ${in_progress === 1 ? 'it' : 'them'} too?\n\n` +
        `Only do this when the upgrade is stuck (agent died or never reported back). ` +
        `A genuinely running upgrade cannot be recalled — force-cancelling just clears its status here.`
      );
      if (pending === 0 && !force) return; // nothing else to do
    }
    cancelMut.mutate({ directiveId: d.directiveId, force });
  };

  const issueMut = useMutation({
    mutationFn: async (body: { targetVersion: string; scope: { type: 'all' | 'installation' | 'installations'; installationId?: string; installationIds?: string[] }; confirmDowngrade?: boolean }) => {
      const r = await api.post('/v1/admin/upgrade', body);
      return r.data;
    },
    onSuccess: () => {
      setShowForm(false);
      setTargetVersion('');
      setScopeMode('all');
      setSelectedInstallationIds(new Set());
      setInstallationFilter('');
      setError(null);
      qc.invalidateQueries({ queryKey: ['admin-upgrade'] });
    },
    onError: (e: any) => {
      const status = e?.response?.status;
      const data = e?.response?.data;
      if (status === 409 && Array.isArray(data?.downgrades) && data.downgrades.length > 0) {
        // Story 5: distinct red confirm for downgrades.
        const keys = apiKeysQ.data ?? [];
        const lines = data.downgrades.map((d: any) =>
          `  • ${installationDisplayName(keys, d.installationId)}: v${d.currentVersion} → v${d.targetVersion}`
        ).join('\n');
        const ok = confirm(
          `⚠️ This is a DOWNGRADE for the following installations:\n\n${lines}\n\nProceed anyway?`
        );
        if (ok) {
          // Re-submit with the confirmation flag.
          const lastBody = (issueMut.variables as any) ?? null;
          if (lastBody) issueMut.mutate({ ...lastBody, confirmDowngrade: true });
        }
        return;
      }
      if (status === 409 && Array.isArray(data?.conflicts) && data.conflicts.length > 0) {
        const keys = apiKeysQ.data ?? [];
        const lines = data.conflicts.map((c: any) =>
          `  • ${installationDisplayName(keys, c.installationId)} (directive ${c.conflictingDirectiveId})`
        ).join('\n');
        setError(`Cannot issue: an upgrade is already pending or running on:\n${lines}`);
        return;
      }
      setError(data?.error ?? e?.message ?? 'Failed to issue directive');
    },
  });

  const availableVersions = availableVersionsQ.data?.versions ?? [];
  const fleetFloor = availableVersionsQ.data?.fleetFloor ?? null;
  const versionsLoading = availableVersionsQ.isPending;
  const canIssue = canIssueDirective({ targetVersion, versions: availableVersions, loading: versionsLoading });

  const onSubmit = () => {
    setError(null);
    const ids = Array.from(selectedInstallationIds);
    let scope: { type: 'all' | 'installation' | 'installations'; installationId?: string; installationIds?: string[] };
    if (scopeMode === 'all') {
      scope = { type: 'all' };
    } else {
      if (ids.length === 0) {
        setError('Pick at least one installation');
        return;
      }
      // Single-pick optimisation: send the legacy single-installation shape so
      // the directive's audit label reads "installation" instead of "installations".
      scope = ids.length === 1
        ? { type: 'installation', installationId: ids[0] }
        : { type: 'installations', installationIds: ids };
    }
    const targetCount = scope.type === 'all' ? installationOptions.length : ids.length || 1;
    if (!confirm(`This will upgrade ${targetCount} installation${targetCount === 1 ? '' : 's'} to v${targetVersion}. Continue?`)) return;
    issueMut.mutate({ targetVersion, scope });
  };

  const filteredInstallations = useMemo(
    () => filterInstallationOptions(installationOptions, installationFilter),
    [installationOptions, installationFilter],
  );

  const toggleInstallation = (id: string) => {
    const next = new Set(selectedInstallationIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedInstallationIds(next);
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
        <h3 className="text-sm font-semibold text-ink">Fleet upgrades</h3>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="text-[12px] inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-[image:var(--gradient-accent)] text-navy hover:opacity-90"
          >
            <Plus className="w-3.5 h-3.5" /> Issue upgrade
          </button>
        )}
      </div>

      {showForm && (
        <div className="rounded-lg border border-border-soft bg-surface p-4 space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-[11px] font-medium text-ink-secondary">Target version</label>
              <button
                type="button"
                onClick={async () => {
                  // Force-fetch the GitHub release list, bypassing the hub's
                  // 10-minute in-memory cache. Useful right after cutting a
                  // new release so the dropdown picks it up immediately.
                  await qc.fetchQuery({
                    queryKey: ['admin-available-versions'],
                    queryFn: async () => (await api.get('/v1/admin/upgrade/available-versions?refresh=1')).data,
                  });
                }}
                disabled={versionsLoading}
                title="Bypass the hub's 10-minute cache and re-fetch the GitHub release list now"
                className="text-[10px] text-accent-text hover:opacity-80 disabled:opacity-50"
              >
                ↻ Refresh
              </button>
            </div>
            <select
              value={targetVersion}
              onChange={(e) => setTargetVersion(e.target.value)}
              disabled={versionsLoading || availableVersions.length === 0}
              className="w-full px-2 py-1.5 text-sm border border-border-soft rounded-md bg-surface disabled:opacity-60"
            >
              <option value="">
                {versionsLoading
                  ? 'Loading versions…'
                  : availableVersions.length === 0
                    ? 'No versions available'
                    : 'Pick a version…'}
              </option>
              {availableVersions.map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
            {fleetFloor && (
              <p className="mt-1 text-[10px] text-ink-tertiary">
                Fleet floor: <span className="font-mono">v{fleetFloor}</span> — older releases hidden.
              </p>
            )}
          </div>
          <div>
            <label className="block text-[11px] font-medium text-ink-secondary mb-1">Scope</label>
            <div className="flex gap-2">
              <button
                onClick={() => setScopeMode('all')}
                className={`text-[12px] px-2 py-1 rounded ${scopeMode === 'all' ? 'bg-[image:var(--gradient-accent)] text-navy' : 'border border-border-soft'}`}
              >All ({installationOptions.length})</button>
              <button
                onClick={() => setScopeMode('installations')}
                className={`text-[12px] px-2 py-1 rounded ${scopeMode === 'installations' ? 'bg-[image:var(--gradient-accent)] text-navy' : 'border border-border-soft'}`}
              >Selected ({selectedInstallationIds.size})</button>
            </div>
            {scopeMode === 'installations' && (
              <div className="mt-2 space-y-2">
                <input
                  type="text"
                  value={installationFilter}
                  onChange={(e) => setInstallationFilter(e.target.value)}
                  placeholder="Filter by user, email, or git name…"
                  className="w-full px-2 py-1.5 text-sm border border-border-soft rounded-md bg-surface"
                />
                {selectedInstallationIds.size > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {Array.from(selectedInstallationIds).map(id => {
                      const opt = installationOptions.find(o => o.id === id);
                      const label = opt?.label ?? id;
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => toggleInstallation(id)}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded bg-chip text-accent-text hover:bg-chip"
                          title="Remove"
                        >
                          {label} <span aria-hidden>×</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="max-h-48 overflow-y-auto rounded border border-border-soft divide-y divide-border-soft">
                  {filteredInstallations.length === 0 ? (
                    <div className="px-2 py-1.5 text-[11px] text-ink-tertiary">No installations match the filter.</div>
                  ) : filteredInstallations.map(o => {
                    const checked = selectedInstallationIds.has(o.id);
                    return (
                      <label
                        key={o.id}
                        className="flex items-center gap-2 px-2 py-1.5 text-[12px] cursor-pointer hover:bg-chip"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleInstallation(o.id)}
                          className="rounded"
                        />
                        <span className="truncate">{o.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          {error && (
            <div className="text-[12px] text-rose-600 dark:text-rose-400 inline-flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" /> {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => { setShowForm(false); setError(null); }} className="text-[12px] px-2 py-1 text-ink-secondary">Cancel</button>
            <button
              onClick={onSubmit} disabled={issueMut.isPending || !canIssue}
              className="text-[12px] px-2.5 py-1 rounded-md bg-[image:var(--gradient-accent)] text-navy hover:opacity-90 disabled:opacity-50"
            >Issue</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {directives.length === 0 && (
          <p className="text-[12px] text-ink-tertiary">No directives issued yet.</p>
        )}
        {directives.map(d => {
          const isOpen = expanded.has(d.directiveId);
          return (
            <div key={d.directiveId} className="rounded-md border border-border-soft bg-surface">
              <div className="w-full flex items-center justify-between px-3 py-2">
                <button
                  onClick={() => toggleExpanded(d.directiveId)}
                  className="flex items-center gap-2 min-w-0 text-left flex-1"
                >
                  {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <span className="font-mono text-[12px] text-ink-secondary">v{d.targetVersion}</span>
                  <span className="text-[11px] text-ink-tertiary truncate">
                    {d.scope.type === 'all'
                      ? 'all installations'
                      : d.scope.type === 'installation'
                        ? `installation ${installationDisplayName(apiKeysQ.data ?? [], d.scope.installationId ?? '')}`
                        : `${d.targets.length} installations`}
                    {' · '}{new Date(d.createdAt).toLocaleString()}
                    {d.createdByEmail && ` · by ${d.createdByEmail}`}
                  </span>
                </button>
                <span className="flex items-center gap-1.5 text-[11px] shrink-0">
                  {d.progress.pending > 0 && <span className="px-1.5 py-0.5 rounded bg-chip text-ink-secondary">{d.progress.pending} pending</span>}
                  {d.progress.in_progress > 0 && <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">{d.progress.in_progress} running</span>}
                  {d.progress.succeeded > 0 && <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">{d.progress.succeeded} ok</span>}
                  {d.progress.failed > 0 && <span className="px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300">{d.progress.failed} failed</span>}
                  {d.progress.cancelled > 0 && <span className="px-1.5 py-0.5 rounded bg-chip text-ink-secondary">{d.progress.cancelled} cancelled</span>}
                  {(d.progress.pending > 0 || d.progress.in_progress > 0) && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onCancel(d); }}
                      disabled={cancelMut.isPending}
                      className="ml-1 px-1.5 py-0.5 rounded border border-rose-300 dark:border-rose-700 text-rose-600 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-900/30 disabled:opacity-50"
                      title="Cancel pending targets on this directive; offers to force-cancel stuck in_progress ones"
                    >{d.progress.pending > 0 ? 'Cancel pending' : 'Force-cancel'}</button>
                  )}
                </span>
              </div>
              {isOpen && d.targets.length > 0 && (
                <div className="border-t border-border-soft divide-y divide-border-soft">
                  {d.targets.map(t => (
                    <div key={t.installationId} className="flex items-center justify-between gap-3 px-3 py-1.5 text-[11px]">
                      <span
                        className="text-ink-secondary truncate"
                        title={t.installationId}
                      >
                        {installationDisplayName(apiKeysQ.data ?? [], t.installationId, {
                          gitName: t.gitName ?? null,
                          gitEmail: t.gitEmail ?? null,
                          osUser: t.osUser ?? null,
                        })}
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        {t.agenfkVersion && (
                          <span className="font-mono text-ink-tertiary" title={`last seen ${t.agenfkVersionUpdatedAt ?? '?'}`}>
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
      <GroupUpgrades />
    </div>
  );
}

/**
 * Group upgrades dispatched to CHILD hubs (CGLAB-183).
 *
 * Deliberately a section of this page rather than its own: an admin asking
 * "what version is my estate on" should not have to know whether a machine is
 * reached directly or through a child hub.
 *
 * It renders nothing at all when this hub has no children, so a standalone hub
 * is not shown a control it can never use.
 */
export function GroupUpgrades() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  // Owned here rather than passed down: the board is also rendered on its own.
  // A malformed shape (or a mock that returns something else) reads as
  // "unknown", which keeps the board fetching — only an explicit
  // `isParent: false` switches the whole section off.
  const childHubsQ = useQuery<{ isParent?: boolean; childHubs?: ChildHubRow[] }>({
    queryKey: ['admin-child-hubs'],
    queryFn: async () => (await api.get('/v1/admin/child-hubs')).data,
  });
  // Unknown while loading; a failed child-hubs lookup is treated as "maybe a
  // parent" so the board's own error line can still show — hiding the whole
  // section on one failed request is the blank this code exists to avoid.
  const isParent = childHubsQ.isError ? true : childHubsQ.data === undefined ? null : childHubsQ.data?.isParent !== false;
  const childHubs = liveChildHubs(Array.isArray(childHubsQ.data?.childHubs) ? childHubsQ.data!.childHubs! : []);

  const q = useQuery<{ dispatches: GroupDispatch[] }>({
    queryKey: ['admin-upgrade-dispatches'],
    queryFn: async () => (await api.get('/v1/admin/upgrade-dispatches')).data,
    // A standalone hub has nothing here; do not ask until we know.
    enabled: isParent === true,
    refetchInterval: (query) => {
      const rows = (query.state.data as { dispatches: GroupDispatch[] } | undefined)?.dispatches ?? [];
      // Poll only while something is genuinely unresolved, the same rule the
      // local directive list uses. See groupUpgradesLive for why an empty
      // target list counts as unresolved.
      return groupUpgradesLive(rows) ? 5_000 : false;
    },
  });

  const cancelMut = useMutation({
    mutationFn: async (id: string) => (await api.post(`/v1/admin/upgrade-dispatches/${id}/cancel`, {})).data,
    // Clearing on success matters: without it one failed cancel left a red
    // line under the heading for the life of the page, including after a
    // later cancel worked.
    onMutate: () => setError(null),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['admin-upgrade-dispatches'] });
    },
    onError: (e: any) => setError(e?.response?.data?.error ?? 'Could not cancel the group upgrade'),
  });

  const dispatches = q.data?.dispatches ?? [];
  if (isParent !== true) return null;
  // A failed load must not look like an empty group. Rendering null on error
  // made a 500 or an expired session indistinguishable from "this hub has no
  // children" — no error, no retry, no sign the section existed.
  if (q.isError) {
    return (
      <div className="mt-8" data-testid="group-upgrades">
        <h2 className="text-sm font-semibold text-ink mb-2">Group upgrades (child hubs)</h2>
        <p className="text-xs text-rose-600 dark:text-rose-400" data-testid="group-upgrades-error">
          Could not load group upgrades. Reload to try again.
        </p>
      </div>
    );
  }
  if (q.isLoading) return null;
  // A parent whose children have all detached still sees its history, but
  // has nobody to issue to; a parent with children and no history sees the
  // control and one line saying the board is empty — it used to see nothing.
  if (dispatches.length === 0 && childHubs.length === 0) return null;

  return (
    <div className="mt-8" data-testid="group-upgrades">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-ink">Group upgrades (child hubs)</h2>
        {childHubs.length > 0 && (
          <GroupUpgradeIssue
            childHubs={childHubs}
            onIssued={() => qc.invalidateQueries({ queryKey: ['admin-upgrade-dispatches'] })}
          />
        )}
      </div>
      {error && (
        <p className="text-xs text-rose-600 dark:text-rose-400 mb-2" data-testid="group-upgrade-cancel-error">{error}</p>
      )}
      {dispatches.length === 0 && (
        <p className="text-xs text-ink-tertiary" data-testid="group-upgrades-empty">
          No group upgrade issued yet. A child hub upgrades its own installations and reports the counts back here.
        </p>
      )}
      {dispatches.length > 0 && (
      <div className="border border-border-soft rounded-lg divide-y divide-border-soft">
        {dispatches.map(d => (
          <div key={d.id} className="p-3" data-testid={`group-dispatch-${d.id}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-ink">{d.targetVersion}</span>
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-chip text-ink-secondary">
                {d.scope}
              </span>
              {d.cancelledAt && (
                <span
                  className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-chip text-ink-tertiary"
                  data-testid={`group-dispatch-cancelled-${d.id}`}
                >
                  cancelled
                </span>
              )}
              <span className="flex-1" />
              {!d.cancelledAt && (
                <button
                  onClick={() => cancelMut.mutate(d.id)}
                  // Scoped to THIS dispatch: one shared isPending greyed out
                  // every other Cancel button on the board.
                  disabled={cancelMut.isPending && cancelMut.variables === d.id}
                  className="text-[11px] text-rose-600 dark:text-rose-400 hover:underline"
                  data-testid={`group-dispatch-cancel-${d.id}`}
                >
                  Cancel
                </button>
              )}
            </div>
            {d.targets.length === 0 ? (
              // Under scope 'all' a hub appears only once it has polled, so an
              // empty list means nobody has asked yet — not that nobody is
              // targeted. Saying so beats rendering a blank space.
              <p className="mt-1 text-xs text-ink-tertiary" data-testid={`group-dispatch-unpolled-${d.id}`}>
                No child hub has picked this up yet.
              </p>
            ) : (
              <div className="mt-2 space-y-1">
                {d.targets.map(t => {
                  const row = groupUpgradeRow(t.state, t.detail?.counts ?? null);
                  return (
                    <div
                      key={t.childHubId}
                      className={'flex items-center gap-2 text-xs ' + (row.settled ? 'text-ink-tertiary' : 'text-ink-secondary')}
                      data-testid={`group-target-${d.id}-${t.childHubId}`}
                    >
                      <span className="font-medium text-ink">{t.name}</span>
                      <span className="px-1.5 py-0.5 rounded bg-chip">{row.label}</span>
                      <span>{row.summary}</span>
                      {row.awaiting && (
                        <span
                          className="text-amber-700 dark:text-amber-300"
                          data-testid={`group-target-awaiting-${d.id}-${t.childHubId}`}
                        >
                          not confirmed
                        </span>
                      )}
                      {(t.detail?.skipped?.length ?? 0) > 0 && (
                        <span
                          className="text-ink-tertiary"
                          title={t.detail!.skipped!.map(sk => `${sk.installationId}: ${sk.reason}`).join('\n')}
                          data-testid={`group-target-skips-${d.id}-${t.childHubId}`}
                        >
                          ({t.detail!.skipped!.length} skipped — hover for why)
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      )}
    </div>
  );
}

/**
 * The form that creates a group upgrade (CGLAB-360). The version list is the
 * same one the fleet form reads (same query key, one request). The parent
 * cannot see a child's installations, so it cannot warn about downgrades the
 * way the fleet form does — the admin says so up front with a checkbox, which
 * travels as `confirmDowngrade` and each child re-validates.
 */
function GroupUpgradeIssue({ childHubs, onIssued }: { childHubs: ChildHubRow[]; onIssued: () => void }) {
  const [open, setOpen] = useState(false);
  const [targetVersion, setTargetVersion] = useState('');
  const [mode, setMode] = useState<DispatchScopeMode>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDowngrade, setConfirmDowngrade] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const versionsQ = useQuery<AvailableVersionsResponse>({
    queryKey: ['admin-available-versions'],
    queryFn: async () => (await api.get('/v1/admin/upgrade/available-versions')).data,
    staleTime: 5 * 60 * 1000,
  });
  const versions = versionsQ.data?.versions ?? [];
  const canIssue = canIssueDirective({ targetVersion, versions, loading: versionsQ.isPending });

  const reset = () => {
    setOpen(false); setTargetVersion(''); setMode('all'); setSelected(new Set()); setConfirmDowngrade(false); setError(null);
  };

  const issue = useMutation({
    mutationFn: (body: GroupUpgradeRequest) => api.post('/v1/admin/upgrade-dispatches', body),
    onMutate: () => setError(null),
    onSuccess: () => { reset(); onIssued(); },
    onError: (e: any) => setError(dispatchRefusalMessage(e?.response?.data, childHubs, 'Could not issue the group upgrade')),
  });

  const toggle = (id: string) => setSelected(prev => toggledSet(prev, id));

  const submit = () => {
    const r = groupUpgradeBody(targetVersion, mode, selected, confirmDowngrade);
    if (!r.ok) { setError(r.error); return; }
    issue.mutate(r.body);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-[12px] inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-border-soft text-ink-secondary hover:bg-chip"
        data-testid="group-upgrade-issue-btn"
      >
        <Plus className="w-3.5 h-3.5" /> Upgrade child hubs
      </button>
    );
  }

  return (
    <div className="w-full rounded-lg border border-border-soft bg-surface p-3 space-y-3" data-testid="group-upgrade-form">
      <div>
        <label className="block text-[11px] font-medium text-ink-secondary mb-1" htmlFor="group-upgrade-version">Target version</label>
        <select
          id="group-upgrade-version"
          value={targetVersion}
          onChange={(e) => setTargetVersion(e.target.value)}
          disabled={versionsQ.isPending || versions.length === 0}
          className="w-full px-2 py-1.5 text-sm border border-border-soft rounded-md bg-surface disabled:opacity-60"
          data-testid="group-upgrade-version"
        >
          <option value="">
            {versionsQ.isPending ? 'Loading versions…' : versions.length === 0 ? 'No versions available' : 'Pick a version…'}
          </option>
          {versions.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      <ChildHubPicker
        childHubs={childHubs}
        mode={mode}
        selected={selected}
        onMode={setMode}
        onToggle={toggle}
        onClose={reset}
        testIdPrefix="group-upgrade"
      />
      <label className="flex items-center gap-2 text-xs text-ink-secondary">
        <input
          type="checkbox"
          checked={confirmDowngrade}
          onChange={(e) => setConfirmDowngrade(e.target.checked)}
          data-testid="group-upgrade-downgrade"
        />
        Allow this to be a downgrade on child hubs that are ahead of {targetVersion ? `v${targetVersion}` : 'the target'}
      </label>
      {error && (
        <p className="text-xs text-rose-600 dark:text-rose-400" data-testid="group-upgrade-error">{error}</p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={reset} className="text-[11px] text-ink-tertiary hover:underline">Cancel</button>
        <button
          type="button"
          onClick={submit}
          disabled={!canIssue || issue.isPending}
          className="px-2.5 py-1 rounded-md bg-[image:var(--gradient-accent)] text-navy text-[11px] font-bold disabled:opacity-40"
          data-testid="group-upgrade-send"
        >
          {issue.isPending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function StatePill({ state }: { state: UpgradeTarget['state'] }) {
  const cls = state === 'succeeded' ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
    : state === 'failed' ? 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300'
    : state === 'in_progress' ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
    : state === 'cancelled' ? 'bg-chip text-ink-tertiary line-through'
    : 'bg-chip text-ink-secondary';
  return <span className={`px-1.5 py-0.5 rounded ${cls}`}>{state}</span>;
}
