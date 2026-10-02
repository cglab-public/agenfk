/**
 * Admin → Upgrades section.
 *
 * Surfaces the Story-2 hub directive API: lets a hub admin push a specific
 * agenfk version to the fleet (or to a single installation) and watch the
 * per-installation rollout live. Auto-refreshes while any directive has
 * pending or in-progress targets.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { LocalTime, useConfirm } from '../components/ui';
import { fmtDateTime, issuedAt } from '../dates';
import { groupUpgradeBody, groupUpgradeRow, groupUpgradesLive, type GroupUpgradeRequest } from './groupUpgradeState';
import { ChildHubPicker, toggledSet } from './childHubPicker';
import { NO_CHILD_HUBS_REASON, dispatchRefusalMessage, liveChildHubs, type ChildHubRow, type DispatchScopeMode } from './flowDispatch';

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
import { upgradeStateLabel, upgradeStateCount } from './adminLabels';
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
  createdAt?: string | null;
  cancelledAt: string | null;
  targets: GroupTarget[];
}

export function AdminUpgrades() {
  const refreshHintId = useId();
  const cancelHintId = useId();
  const clearHintId = useId();
  const { confirm, dialog } = useConfirm();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [targetVersion, setTargetVersion] = useState('');
  const [scopeMode, setScopeMode] = useState<'all' | 'installations'>('all');
  const [selectedInstallationIds, setSelectedInstallationIds] = useState<Set<string>>(new Set());
  const [installationFilter, setInstallationFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Separate from the issue form's error: that banner renders only while the
  // form is open, so a refused cancel written there showed nothing.
  // Keyed to the directive so the message sits on the row the admin clicked.
  const [cancelError, setCancelError] = useState<{ directiveId: string; message: string } | null>(null);
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
    onMutate: () => setCancelError(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-upgrade'] });
    },
    onError: (e: any, { directiveId }) => {
      const data = e?.response?.data;
      setCancelError({ directiveId, message: data?.error ?? e?.message ?? "Couldn't cancel the upgrade" });
    },
  });

  const onCancel = async (d: Directive) => {
    const { pending, in_progress } = d.progress;
    if (pending > 0) {
      if (!(await confirm({
        title: `Cancel ${pending} waiting upgrade${pending === 1 ? '' : 's'} for v${d.targetVersion}?`,
        body: 'Installations already running or finished will not be affected.',
        confirmLabel: 'Cancel waiting',
      }))) return;
    }
    let force = false;
    if (in_progress > 0) {
      // Distinct, explicit opt-in: a running target may be a genuinely live
      // flight — but it may also be a dead agent wedging the installation
      // (new directives are refused while it stays in_progress).
      force = await confirm({
        title: `${in_progress} installation${in_progress === 1 ? ' is' : 's are'} still running this upgrade. `
          + `Mark ${in_progress === 1 ? 'it' : 'them'} as cancelled${pending > 0 ? ' too' : ''}?`,
        body: 'Only do this when the upgrade is stuck (agent died or never reported back). '
          + 'A genuinely running upgrade cannot be recalled — cancelling it just clears its status here.',
        confirmLabel: 'Mark as cancelled',
      });
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
    // `sent` is the body that failed, passed in by react-query: reading
    // issueMut.variables here would read a closure from before the dialog.
    onError: async (e: any, sent) => {
      const status = e?.response?.status;
      const data = e?.response?.data;
      if (status === 409 && Array.isArray(data?.downgrades) && data.downgrades.length > 0) {
        // Story 5: distinct red confirm for downgrades.
        const keys = apiKeysQ.data ?? [];
        const lines = data.downgrades.map((d: any) =>
          `• ${installationDisplayName(keys, d.installationId)}: v${d.currentVersion} → v${d.targetVersion}`
        ).join('\n');
        const ok = await confirm({
          title: 'This is a DOWNGRADE. Proceed anyway?',
          body: `These installations would go back to an older version:\n${lines}`,
          confirmLabel: 'Downgrade',
        });
        // Re-submit with the confirmation flag.
        if (ok) issueMut.mutate({ ...sent, confirmDowngrade: true });
        return;
      }
      if (status === 409 && Array.isArray(data?.conflicts) && data.conflicts.length > 0) {
        const keys = apiKeysQ.data ?? [];
        const lines = data.conflicts.map((c: any) =>
          `  • ${installationDisplayName(keys, c.installationId)} (upgrade ${c.conflictingDirectiveId})`
        ).join('\n');
        setError(`Cannot send: an upgrade is already waiting or running on:\n${lines}`);
        return;
      }
      setError(data?.error ?? e?.message ?? "Couldn't send the upgrade");
    },
  });

  const availableVersions = availableVersionsQ.data?.versions ?? [];
  const fleetFloor = availableVersionsQ.data?.fleetFloor ?? null;
  const versionsLoading = availableVersionsQ.isPending;
  const canIssue = canIssueDirective({ targetVersion, versions: availableVersions, loading: versionsLoading });

  const onSubmit = async () => {
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
    if (!(await confirm({
      title: `Upgrade ${targetCount} installation${targetCount === 1 ? '' : 's'} to v${targetVersion}?`,
      body: 'Each one installs the new version the next time it checks in.',
      confirmLabel: 'Issue upgrade',
      tone: 'default',
    }))) return;
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
      {dialog}
      <div className="flex items-center justify-between">
        <h3 className="text-body font-semibold text-ink">Fleet upgrades</h3>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="text-small inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-brand text-navy hover:opacity-90"
          >
            <Plus className="w-3.5 h-3.5" /> Issue upgrade
          </button>
        )}
      </div>

      {showForm && (
        <div className="rounded-lg border border-border-soft bg-surface p-4 space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="upgrade-target-version" className="block text-caption font-medium text-ink-secondary">Target version</label>
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
                aria-describedby={refreshHintId}
                className="text-caption text-accent-ink hover:opacity-80 disabled:opacity-50"
              >
                ↻ Refresh
              </button>
            </div>
            <select
              id="upgrade-target-version"
              value={targetVersion}
              onChange={(e) => setTargetVersion(e.target.value)}
              disabled={versionsLoading || availableVersions.length === 0}
              className="w-full px-2 py-1.5 text-body border border-border-soft rounded-md bg-surface disabled:opacity-60"
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
            <p id={refreshHintId} className="mt-1 text-caption text-ink-tertiary">
              Refresh bypasses the hub's 10-minute cache and re-fetches the GitHub release list now.
            </p>
            {fleetFloor && (
              <p className="mt-1 text-caption text-ink-tertiary">
                Oldest version reported: <span className="font-mono">v{fleetFloor}</span> — older releases hidden.
              </p>
            )}
          </div>
          <div>
            <span id="upgrade-scope-label" className="block text-caption font-medium text-ink-secondary mb-1">Scope</span>
            <div role="group" aria-labelledby="upgrade-scope-label" className="flex gap-2">
              <button
                type="button"
                aria-pressed={scopeMode === 'all'}
                onClick={() => setScopeMode('all')}
                className={`text-small px-2 py-1 rounded border ${scopeMode === 'all' ? 'border-accent bg-accent-fill text-accent-ink font-semibold' : 'border-border-soft text-ink-secondary'}`}
              >All ({installationOptions.length})</button>
              <button
                type="button"
                aria-pressed={scopeMode === 'installations'}
                onClick={() => setScopeMode('installations')}
                className={`text-small px-2 py-1 rounded border ${scopeMode === 'installations' ? 'border-accent bg-accent-fill text-accent-ink font-semibold' : 'border-border-soft text-ink-secondary'}`}
              >Selected ({selectedInstallationIds.size})</button>
            </div>
            {scopeMode === 'installations' && (
              <div className="mt-2 space-y-2">
                <input
                  type="text"
                  value={installationFilter}
                  onChange={(e) => setInstallationFilter(e.target.value)}
                  placeholder="Filter by user, email, or git name…"
                  aria-label="Filter installations"
                  className="w-full px-2 py-1.5 text-body border border-border-soft rounded-md bg-surface"
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
                          aria-label={`Remove ${label}`}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-caption rounded bg-accent-fill text-accent-ink hover:bg-status-danger-bg hover:text-status-danger-text"
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
                    <div className="px-2 py-1.5 text-caption text-ink-tertiary">No installations match the filter.</div>
                  ) : filteredInstallations.map(o => {
                    const checked = selectedInstallationIds.has(o.id);
                    return (
                      <label
                        key={o.id}
                        className="flex items-center gap-2 px-2 py-1.5 text-small cursor-pointer hover:bg-accent-fill"
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
            <div className="text-small text-status-danger-text inline-flex items-start gap-1 whitespace-pre-line">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => { setShowForm(false); setError(null); }} className="text-small px-2 py-1 text-ink-secondary">Cancel</button>
            <button
              onClick={onSubmit} disabled={issueMut.isPending || !canIssue}
              className="text-small px-2.5 py-1 rounded-md bg-brand text-navy hover:opacity-90 disabled:opacity-50"
            >Issue</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {directives.length === 0 && (
          <p className="text-small text-ink-tertiary">No upgrades sent yet.</p>
        )}
        {/* What the row buttons do, on screen once rather than in each one's title. */}
        {/* Only the sentences for buttons that are on screen. */}
        {directives.some(d => d.progress.pending > 0 || d.progress.in_progress > 0) && (
          <p className="text-caption text-ink-tertiary">
            {directives.some(d => d.progress.pending > 0) && (
              <span id={cancelHintId}>Cancel waiting cancels the upgrade where it hasn't started, and offers to clear stuck running ones too. </span>
            )}
            {directives.some(d => d.progress.pending === 0 && d.progress.in_progress > 0) && (
              <span id={clearHintId}>Clear stuck marks stuck running upgrades as cancelled: a live upgrade keeps running, it just stops blocking the installation.</span>
            )}
          </p>
        )}
        {directives.map(d => {
          const isOpen = expanded.has(d.directiveId);
          return (
            <div key={d.directiveId} className="rounded-md border border-border-soft bg-surface">
              <div className="w-full flex items-center justify-between px-3 py-2">
                <button
                  onClick={() => toggleExpanded(d.directiveId)}
                  aria-expanded={isOpen}
                  className="flex items-center gap-2 min-w-0 text-left flex-1"
                >
                  {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <span className="font-mono text-small text-ink-secondary">v{d.targetVersion}</span>
                  <span className="text-caption text-ink-tertiary truncate">
                    {d.scope.type === 'all'
                      ? 'all installations'
                      : d.scope.type === 'installation'
                        ? `installation ${installationDisplayName(apiKeysQ.data ?? [], d.scope.installationId ?? '')}`
                        : `${d.targets.length} installations`}
                    {' · '}<LocalTime value={d.createdAt} />
                    {d.createdByEmail && ` · by ${d.createdByEmail}`}
                  </span>
                </button>
                <span className="flex items-center gap-1.5 text-caption shrink-0">
                  {d.progress.pending > 0 && <span className="px-1.5 py-0.5 rounded bg-canvas text-ink-secondary">{upgradeStateCount('pending', d.progress.pending)}</span>}
                  {d.progress.in_progress > 0 && <span className="px-1.5 py-0.5 rounded bg-status-warn-bg text-status-warn-text">{upgradeStateCount('in_progress', d.progress.in_progress)}</span>}
                  {d.progress.succeeded > 0 && <span className="px-1.5 py-0.5 rounded bg-status-ok-bg text-status-ok-text">{upgradeStateCount('succeeded', d.progress.succeeded)}</span>}
                  {d.progress.failed > 0 && <span className="px-1.5 py-0.5 rounded bg-status-danger-bg text-status-danger-text">{upgradeStateCount('failed', d.progress.failed)}</span>}
                  {d.progress.cancelled > 0 && <span className="px-1.5 py-0.5 rounded bg-canvas text-ink-secondary">{upgradeStateCount('cancelled', d.progress.cancelled)}</span>}
                  {(d.progress.pending > 0 || d.progress.in_progress > 0) && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onCancel(d); }}
                      disabled={cancelMut.isPending}
                      // Two upgrades to one version differ only by when they were issued.
                      aria-label={`${d.progress.pending > 0 ? 'Cancel waiting' : 'Clear stuck'} upgrade to v${d.targetVersion}${issuedAt(d.createdAt)}`}
                      className="ml-1 px-1.5 py-0.5 rounded border border-status-danger-text/40 text-status-danger-text hover:bg-status-danger-bg disabled:opacity-50"
                      aria-describedby={d.progress.pending > 0 ? cancelHintId : clearHintId}
                    >{d.progress.pending > 0 ? 'Cancel waiting' : 'Clear stuck'}</button>
                  )}
                </span>
              </div>
              {cancelError?.directiveId === d.directiveId && (
                <div role="alert" className="px-3 pb-2 text-small text-status-danger-text flex items-start gap-1 whitespace-pre-line">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {cancelError.message}
                </div>
              )}
              {isOpen && d.targets.length > 0 && (
                <div className="border-t border-border-soft divide-y divide-border-soft">
                  {d.targets.map(t => (
                    <div key={t.installationId} className="px-3 py-1.5 text-caption">
                    <div className="flex items-center justify-between gap-3">
                      <span
                        className="text-ink-secondary truncate"
                        title={t.installationId}
                      >
                        {installationDisplayName(apiKeysQ.data ?? [], t.installationId, {
                          gitName: t.gitName ?? null,
                          gitEmail: t.gitEmail ?? null,
                          osUser: t.osUser ?? null,
                        })}
                        {' '}<span className="sr-only">installation {t.installationId}</span>
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        {t.agenfkVersion && (
                          <span className="font-mono text-ink-tertiary" title={`last seen ${t.agenfkVersionUpdatedAt ?? '?'}`}>
                            v{t.agenfkVersion}
                            {t.agenfkVersionUpdatedAt && <span className="sr-only">{`last seen ${fmtDateTime(t.agenfkVersionUpdatedAt)}`}</span>}
                          </span>
                        )}
                        <StatePill state={t.state} />
                      </span>
                    </div>
                    {/* Its own line, wrapped: the whole error, not a clipped one. */}
                    {t.errorMessage && <p className="mt-0.5 text-status-danger-text break-words">{t.errorMessage}</p>}
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
  const { confirm, dialog } = useConfirm();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  // Owned here rather than passed down: the board is also rendered on its own.
  // Only an explicit `isParent: false` switches the section off; any other
  // resolved shape is treated as a parent so the board keeps fetching.
  const childHubsQ = useQuery<{ isParent?: boolean; childHubs?: ChildHubRow[] }>({
    queryKey: ['admin-child-hubs'],
    queryFn: async () => (await api.get('/v1/admin/child-hubs')).data,
  });
  // Unknown (null) while loading. A failed child-hubs lookup is treated as a
  // parent so the section renders its error line below instead of vanishing.
  const isParent = childHubsQ.isError ? true : childHubsQ.data === undefined ? null : childHubsQ.data?.isParent !== false;
  const childHubRows = childHubsQ.data?.childHubs;
  const childHubs = liveChildHubs(Array.isArray(childHubRows) ? childHubRows : []);
  const [issuing, setIssuing] = useState(false);

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
  // children" — no error, no retry, no sign the section existed. The same
  // holds for the child-hubs lookup the whole section hangs off.
  if (q.isError || childHubsQ.isError) {
    return (
      <div className="mt-8" data-testid="group-upgrades">
        <h2 className="text-body font-semibold text-ink mb-2">Group upgrades (child hubs)</h2>
        <p className="text-small text-status-danger-text" data-testid="group-upgrades-error">
          {childHubsQ.isError
            ? 'Could not load this hub\'s child hubs. Reload to try again.'
            : 'Could not load group upgrades. Reload to try again.'}
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
      {dialog}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-body font-semibold text-ink">Group upgrades (child hubs)</h2>
        {!issuing && (
          <button
            onClick={() => setIssuing(true)}
            disabled={childHubs.length === 0}
            title={childHubs.length === 0 ? NO_CHILD_HUBS_REASON : undefined}
            className={
              'text-small inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-border-soft ' +
              (childHubs.length === 0 ? 'text-ink-tertiary opacity-60 cursor-not-allowed' : 'text-ink-secondary hover:bg-accent-fill')
            }
            data-testid="group-upgrade-issue-btn"
          >
            <Plus className="w-3.5 h-3.5" /> Upgrade child hubs
          </button>
        )}
      </div>
      {childHubs.length === 0 && (
        // History with nobody left to send to: say why the control is off,
        // as the flows page does, instead of removing it silently.
        <p className="text-caption text-ink-tertiary mb-2" data-testid="group-upgrade-issue-reason">{NO_CHILD_HUBS_REASON}</p>
      )}
      {issuing && (
        // Below the header, not beside it: a five-row form as a flex sibling
        // of the heading was squeezed into the space right of the h2.
        <div className="mb-3">
          <GroupUpgradeIssue
            childHubs={childHubs}
            onClose={() => setIssuing(false)}
            onIssued={() => qc.invalidateQueries({ queryKey: ['admin-upgrade-dispatches'] })}
          />
        </div>
      )}
      {error && (
        <p className="text-small text-status-danger-text mb-2" data-testid="group-upgrade-cancel-error">{error}</p>
      )}
      {dispatches.length === 0 && (
        <p className="text-small text-ink-tertiary" data-testid="group-upgrades-empty">
          No group upgrade issued yet. A child hub upgrades its own installations and reports the counts back here.
        </p>
      )}
      {dispatches.length > 0 && (
      <div className="border border-border-soft rounded-lg divide-y divide-border-soft">
        {dispatches.map(d => (
          <div key={d.id} className="p-3" data-testid={`group-dispatch-${d.id}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-ink">{d.targetVersion}</span>
              <span className="eyebrow px-1.5 py-0.5 rounded-full bg-canvas text-ink-secondary">
                {d.scope}
              </span>
              {d.cancelledAt && (
                <span
                  className="eyebrow px-1.5 py-0.5 rounded-full bg-canvas text-ink-tertiary"
                  data-testid={`group-dispatch-cancelled-${d.id}`}
                >
                  cancelled
                </span>
              )}
              <span className="flex-1" />
              {!d.cancelledAt && (
                <button
                  onClick={async () => {
                    if (await confirm({
                      title: `Cancel the group upgrade to v${d.targetVersion}?`,
                      body: 'Child hubs that have not picked it up yet will not. Installations already upgraded stay on the new version.',
                      confirmLabel: 'Cancel group upgrade',
                    })) cancelMut.mutate(d.id);
                  }}
                  // Scoped to THIS dispatch: one shared isPending greyed out
                  // every other Cancel button on the board.
                  disabled={cancelMut.isPending && cancelMut.variables === d.id}
                  className="text-caption text-status-danger-text hover:underline"
                  data-testid={`group-dispatch-cancel-${d.id}`}
                  aria-label={`Cancel group upgrade to v${d.targetVersion}${issuedAt(d.createdAt)}`}
                >
                  Cancel
                </button>
              )}
            </div>
            {d.targets.length === 0 ? (
              // Under scope 'all' a hub appears only once it has polled, so an
              // empty list means nobody has asked yet — not that nobody is
              // targeted. Saying so beats rendering a blank space.
              <p className="mt-1 text-small text-ink-tertiary" data-testid={`group-dispatch-unpolled-${d.id}`}>
                No child hub has picked this up yet.
              </p>
            ) : (
              <div className="mt-2 space-y-1">
                {d.targets.map(t => {
                  const row = groupUpgradeRow(t.state, t.detail?.counts ?? null);
                  return (
                    <div
                      key={t.childHubId}
                      className={'flex items-center gap-2 text-small ' + (row.settled ? 'text-ink-tertiary' : 'text-ink-secondary')}
                      data-testid={`group-target-${d.id}-${t.childHubId}`}
                    >
                      <span className="font-medium text-ink">{t.name}</span>
                      <span className="px-1.5 py-0.5 rounded bg-canvas">{row.label}</span>
                      <span>{row.summary}</span>
                      {row.awaiting && (
                        <span
                          className="text-status-warn-text"
                          data-testid={`group-target-awaiting-${d.id}-${t.childHubId}`}
                        >
                          not confirmed
                        </span>
                      )}
                      {(t.detail?.skipped?.length ?? 0) > 0 && (
                        // A disclosure anyone can open, not "hover for why".
                        <details className="text-ink-tertiary" data-testid={`group-target-skips-${d.id}-${t.childHubId}`}>
                          <summary className="cursor-pointer">{t.detail!.skipped!.length} skipped</summary>
                          <ul className="mt-1 space-y-0.5 font-mono text-caption">
                            {t.detail!.skipped!.map(sk => <li key={sk.installationId} className="break-all">{`${sk.installationId}: ${sk.reason}`}</li>)}
                          </ul>
                        </details>
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
 * The form that creates a group upgrade (CGLAB-360). The parent cannot see a
 * child's installations, so it cannot warn about downgrades the way the fleet
 * form does — the admin says so up front with a checkbox, which travels as
 * `confirmDowngrade`. Each child applies it per installation: unticked, a
 * machine already ahead of the target is skipped with reason 'downgrade' and
 * the rest of that fleet still upgrades (upgradeFanout.ts).
 */
function GroupUpgradeIssue({
  childHubs, onClose, onIssued,
}: {
  childHubs: ChildHubRow[];
  onClose: () => void;
  onIssued: () => void;
}) {
  const { confirm, dialog } = useConfirm();
  const [targetVersion, setTargetVersion] = useState('');
  const [mode, setMode] = useState<DispatchScopeMode>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDowngrade, setConfirmDowngrade] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // NOT the fleet form's list. That one is floored at the oldest version among
  // this hub's own installations, which says nothing about the children's
  // fleets — the parent never sees them. Every release is offered; the server
  // still refuses a release that does not exist (422).
  const versionsQ = useQuery<AvailableVersionsResponse>({
    queryKey: ['admin-available-versions', 'unfiltered'],
    queryFn: async () => (await api.get('/v1/admin/upgrade/available-versions?unfiltered=1')).data,
    staleTime: 5 * 60 * 1000,
  });
  const versions = versionsQ.data?.versions ?? [];
  const canIssue = canIssueDirective({ targetVersion, versions, loading: versionsQ.isPending });

  const reset = () => {
    setTargetVersion(''); setMode('all'); setSelected(new Set()); setConfirmDowngrade(false); setError(null);
    onClose();
  };

  const issue = useMutation({
    mutationFn: (body: GroupUpgradeRequest) => api.post('/v1/admin/upgrade-dispatches', body),
    onMutate: () => setError(null),
    onSuccess: () => { reset(); onIssued(); },
    onError: (e: any) => setError(dispatchRefusalMessage(e?.response?.data, childHubs, 'Could not issue the group upgrade')),
  });

  const toggle = (id: string) => setSelected(prev => toggledSet(prev, id));

  const submit = async () => {
    const r = groupUpgradeBody(targetVersion, mode, selected, confirmDowngrade);
    if (!r.ok) { setError(r.error); return; }
    const n = r.body.childHubIds?.length ?? 0;
    const who = r.body.scope === 'all' ? 'every child hub' : `${n} child hub${n === 1 ? '' : 's'}`;
    if (!(await confirm({
      title: `Upgrade ${who} to v${r.body.targetVersion}?`,
      body: 'Each child hub passes the upgrade on to its own installations.'
        + (r.body.confirmDowngrade ? ' Installations already ahead of this version are skipped and reported.' : ''),
      confirmLabel: 'Send upgrade',
      tone: 'default',
    }))) return;
    issue.mutate(r.body);
  };

  return (
    <div className="w-full rounded-lg border border-border-soft bg-surface p-3 space-y-3" data-testid="group-upgrade-form">
      {dialog}
      <div>
        <label className="block text-caption font-medium text-ink-secondary mb-1" htmlFor="group-upgrade-version">Target version</label>
        <select
          id="group-upgrade-version"
          value={targetVersion}
          onChange={(e) => setTargetVersion(e.target.value)}
          disabled={versionsQ.isPending || versions.length === 0}
          className="w-full px-2 py-1.5 text-body border border-border-soft rounded-md bg-surface disabled:opacity-60"
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
        groupLabel="Upgrade child hubs"
      />
      <label className="flex items-center gap-2 text-small text-ink-secondary">
        <input
          type="checkbox"
          checked={confirmDowngrade}
          onChange={(e) => setConfirmDowngrade(e.target.checked)}
          data-testid="group-upgrade-downgrade"
        />
        Also downgrade installations already ahead of {targetVersion ? `v${targetVersion}` : 'the target'}. Unticked, each child hub skips those machines and reports them as “downgrade” in its counts.
      </label>
      {error && (
        <p className="text-small text-status-danger-text" data-testid="group-upgrade-error">{error}</p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={reset} className="text-caption text-ink-tertiary hover:underline">Cancel</button>
        <button
          type="button"
          onClick={submit}
          disabled={!canIssue || issue.isPending}
          className="px-2.5 py-1 rounded-md bg-brand text-navy text-caption font-bold disabled:opacity-40"
          data-testid="group-upgrade-send"
        >
          {issue.isPending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function StatePill({ state }: { state: UpgradeTarget['state'] }) {
  const cls = state === 'succeeded' ? 'bg-status-ok-bg text-status-ok-text'
    : state === 'failed' ? 'bg-status-danger-bg text-status-danger-text'
    : state === 'in_progress' ? 'bg-status-warn-bg text-status-warn-text'
    : state === 'cancelled' ? 'bg-canvas text-ink-tertiary line-through'
    : 'bg-canvas text-ink-secondary';
  return <span className={`px-1.5 py-0.5 rounded ${cls}`}>{upgradeStateLabel(state)}</span>;
}
