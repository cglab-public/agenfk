/**
 * Admin → Flows section. Reuses the shared FlowEditorModal (same UI as the
 * agenfk client) with a hub-flavoured client routing all reads/writes to
 * /v1/admin/flows + /v1/admin/registry. The Community tab works identically
 * because its registry surface is shape-compatible.
 *
 * The page also surfaces multi-scope assignment management (org/project/
 * installation overrides) via an inline Assignments panel that expands when
 * a flow is selected. The panel is hub-ui-only — the shared FlowEditorModal
 * stays focused on flow definition; assignment management would be
 * confusing inside the agenfk client where it has no analogue.
 */
import { useState, useEffect, useMemo, useRef } from 'react';
import clsx from 'clsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, X, ChevronDown, ChevronRight, Send } from 'lucide-react';
import { ChildHubPicker, toggledSet } from './childHubPicker';
import { FlowEditorModal, type FlowClient, type RegistryClient, type Flow } from '@agenfk/flow-editor';
import { api } from '../api';
import { QueryError, InlineError, useConfirm } from '../components/ui';
import { issuedAt } from '../dates';
import { RegistryPullsPanel } from './RegistryPullsPanel';
import { flattenAdminFlow } from './adminFlowShape';
import { repoOverrideOptions } from './repoOverrideOptions';
import { availabilityRowState } from './availabilityRowState';
import { parentFlowLock } from './parentFlowLock';
import {
  canDispatchFlow,
  dispatchFlowDeleted,
  dispatchRefusalMessage,
  flowDispatchBody,
  flowDispatchPollInterval,
  flowDispatchTargetRow,
  liveChildHubs,
  type ChildHubRow,
  type DispatchScopeMode,
  type FlowDispatchRequest,
  type FlowDispatchRow,
} from './flowDispatch';
import { useTheme } from '../ThemeContext';
import {
  PUBLIC_REGISTRY_REPO,
  registryFormError,
  registryConfigSaveLabel,
  EDITOR_LABELS_HUB,
  resolveTabLabels,
  showRegistrySourcePicker,
  registrySourceOptions,
  type RegistrySource,
  MOVE_BACK_TO_PUBLIC_CONFIRM,
} from './adminFlowRegistry';

const HUB_PROJECT_TOKEN = 'org-default'; // pseudo-projectId — hub binds to org-default assignment

interface Assignment {
  scope: 'org' | 'repo' | 'project' | 'installation';
  targetId: string;
  flowId: string;
  updatedAt: string;
  // For repo-scoped rows this IS the remote URL; retained for the legacy
  // project scope so the UI can render the git remote instead of a raw UUID.
  remoteUrl?: string | null;
}

interface ProjectInfo { projectId: string; lastSeen: string; remoteUrl: string | null }
interface ApiKeyRow { tokenHashPreview: string; label: string | null; installationId: string | null; gitName: string | null; gitEmail: string | null; revokedAt: string | null }

/**
 * Which flows the parent hub owns, as of the last list.
 *
 * Disabling the Edit button on the flow row is not the whole explanation:
 * "New / Import" opens the shared FlowEditorModal, whose sidebar lists EVERY
 * flow and offers Save and Delete on whichever is selected. The server refuses
 * both either way — that is the control and it does not depend on this — but
 * without this the admin drafts an edit and collects a raw 409, which is the
 * exact experience parentFlowLock exists to prevent. Refusing here turns it
 * back into the sentence.
 *
 * Repopulated on every listFlows, which is what the editor calls on open, so
 * it cannot go stale behind the modal.
 */
const parentOwnedIds = new Set<string>();

const refuseIfParentOwned = (id: string) => {
  const lock = parentFlowLock(parentOwnedIds.has(id) ? 'parent' : 'hub');
  if (lock.locked) throw new Error(lock.reason!);
};

export const flowClient: FlowClient = {
  listFlows: async () => {
    const rows = (await api.get('/v1/admin/flows')).data as any[];
    parentOwnedIds.clear();
    for (const r of rows) if (r?.source === 'parent' && r.id) parentOwnedIds.add(r.id);
    return rows.map(flattenAdminFlow);
  },
  getDefaultFlow: async () => (await api.get('/v1/admin/flows/default')).data,
  createFlow: async (payload) => {
    const { id: _id, createdAt: _c, updatedAt: _u, ...definition } = payload as any;
    const r = await api.post('/v1/admin/flows', { definition });
    return flattenAdminFlow(r.data);
  },
  updateFlow: async (id, payload) => {
    refuseIfParentOwned(id);
    const { id: _id, createdAt: _c, updatedAt: _u, ...definition } = payload as any;
    const r = await api.put(`/v1/admin/flows/${id}`, { definition });
    return flattenAdminFlow(r.data);
  },
  deleteFlow: async (id) => {
    refuseIfParentOwned(id);
    await api.delete(`/v1/admin/flows/${id}`);
  },
  setProjectFlow: async (_projectId, flowId) => {
    await api.put('/v1/admin/flow-assignments', { flowId });
  },
  getFlowContract: async (steps) => (await api.post('/v1/admin/flows/contract', { steps })).data,
};

/**
 * The hub's RegistryClient. `source` selects which registry the server reads:
 * the org's own repo, or the public community one. It is a factory rather than
 * a const because the selection lives in component state, and the shared
 * editor's browse/install must follow it.
 *
 * `source` is sent as an opaque enum the server maps to a repo. The UI never
 * names a repo — that is the tenancy boundary, since the server holds the
 * org's contents:write PAT and would otherwise be a proxy for any repo it can
 * reach.
 *
 * There is deliberately **no `publishToRegistry`.** Publishing writes to the
 * registry repo, and the only credential for that is the org's `contents:write`
 * PAT — which lives encrypted on the hub and is never copied to a browser, and
 * the hub exposes no publish route (its `writeRegistryFile` is used solely by
 * the one-time community copy when an admin points the org at a private repo).
 * This client used to carry a method that only threw; the method is optional on
 * `RegistryClient` now, so omitting it hides the editor's Publish button
 * instead of rendering a control that can only fail.
 *
 * Authors who do need to publish a flow to a repo do it from their own
 * machine, where `gh` holds their credentials:
 * `agenfk flow publish <id> [--registry owner/repo]`.
 */
export function makeRegistryClient(getSource: () => RegistrySource): RegistryClient {
  return {
    browseRegistry: async () =>
      (await api.get('/v1/admin/registry/flows', { params: { source: getSource() } })).data,
    installFromRegistry: async (filename) =>
      flattenAdminFlow((await api.post('/v1/admin/flows/install', { filename, source: getSource() })).data),
  };
}

export function AdminFlows() {
  const qc = useQueryClient();
  // The shared flow editor styles itself and initialises mermaid from this
  // prop, so it must follow the hub's live theme rather than a constant.
  const { theme } = useTheme();
  const [editorOpen, setEditorOpen] = useState(false);
  const [initialFlowId, setInitialFlowId] = useState<string | undefined>(undefined);
  const [expandedFlowId, setExpandedFlowId] = useState<string | null>(null);
  // Flows / Registry. Kept in the URL hash, not router state: the page also
  // renders outside a router (its tests, the editor harness).
  const [tab, setTabState] = useState<'flows' | 'registry'>(() =>
    typeof window !== 'undefined' && window.location.hash === '#registry' ? 'registry' : 'flows');
  const setTab = (t: 'flows' | 'registry') => {
    setTabState(t);
    const url = `${window.location.pathname}${window.location.search}${t === 'registry' ? '#registry' : ''}`;
    window.history.replaceState(window.history.state, '', url);
  };
  // Which registry the editor's second tab reads. Held in a ref-like getter so
  // the module-level client factory below can read the current value without
  // being rebuilt on every render (a new client object each render would
  // retrigger the editor's registry query indefinitely).
  const [registrySource, setRegistrySource] = useState<RegistrySource>('org');
  const sourceRef = useRef<RegistrySource>('org');
  sourceRef.current = registrySource;

  const flowsQ = useQuery<Flow[]>({
    queryKey: ['admin-flows'],
    queryFn: () => flowClient.listFlows(),
  });
  const flows = flowsQ.data ?? [];
  const { data: assignments = [] } = useQuery<Assignment[]>({
    queryKey: ['admin-flow-assignments'],
    queryFn: async () => (await api.get('/v1/admin/flow-assignments')).data,
  });

  // Who this hub could dispatch a flow to (CGLAB-358). A standalone hub gets
  // an empty list and is shown none of the dispatch controls — a button it
  // can never use is noise, and the board has nothing to report.
  const { data: childHubsResp } = useQuery<{ isParent: boolean; childHubs: ChildHubRow[] }>({
    queryKey: ['admin-child-hubs'],
    queryFn: async () => (await api.get('/v1/admin/child-hubs')).data,
  });
  const childHubs = liveChildHubs(childHubsResp?.childHubs ?? []);
  const isParent = childHubsResp?.isParent === true;

  // Read here as well as in RegistryRepoPanel: the editor's tab captions depend
  // on which repo the registry currently resolves to. Same queryKey, so react-
  // query shares the one request — this is not a second fetch.
  const { data: registryCfg } = useQuery<RegistryConfig>({
    queryKey: ['admin-registry-config'],
    queryFn: async () => (await api.get('/v1/admin/registry-config')).data,
  });
  const tabLabels = resolveTabLabels({
    isPublic: registryCfg?.isPublic ?? null,
    repo: registryCfg?.repo ?? null,
  });

  // Built once; reads the live source through the ref so switching registries
  // does not hand the editor a new client object (which would remount its
  // query). The query key below is what actually drives a refetch.
  const [registryClient] = useState(() => makeRegistryClient(() => sourceRef.current));
  const showSourcePicker = showRegistrySourcePicker({
    isPublic: registryCfg?.isPublic ?? null,
    repo: registryCfg?.repo ?? null,
  });

  const orgAssignment = assignments.find(a => a.scope === 'org');

  // Refresh on editor close — the modal mutates flows under its own keys.
  useEffect(() => {
    if (!editorOpen) {
      qc.invalidateQueries({ queryKey: ['admin-flows'] });
      qc.invalidateQueries({ queryKey: ['admin-flow-assignments'] });
    }
  }, [editorOpen, qc]);

  const openEditor = (flowId?: string) => { setInitialFlowId(flowId); setEditorOpen(true); };

  return (
    <div className="space-y-4 max-w-3xl">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-ink">Org-managed flows</h2>
          <p className="mt-0.5 text-xs text-ink-tertiary">
            Define and assign workflow flows. An installation runs the most specific assignment: an installation override, then a repo override, then the org default.
          </p>
        </div>
        <button
          className="px-3 py-1.5 rounded-lg bg-brand text-navy text-xs font-bold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          onClick={() => openEditor()}
          data-testid="admin-flows-new-btn"
        >
          <Plus className="w-3.5 h-3.5" /> New flow
        </button>
      </header>

      <div role="tablist" aria-label="Flows sections" className="inline-flex gap-0.5 p-1 rounded-xl border border-border-soft bg-surface">
        {(['flows', 'registry'] as const).map(t => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`flows-tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`flows-panel-${t}`}
            onClick={() => setTab(t)}
            className={'px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors ' + (tab === t
              ? 'bg-accent-fill text-accent-ink'
              : 'text-ink-secondary hover:bg-accent-fill/50 hover:text-ink')}
          >
            {t === 'flows' ? 'Flows' : 'Registry'}
          </button>
        ))}
      </div>

      {tab === 'flows' && (
      <div role="tabpanel" id="flows-panel-flows" aria-labelledby="flows-tab-flows" className="space-y-4">
      <div className="bg-surface border border-border-soft rounded-2xl divide-y divide-border-soft">
        {flowsQ.isError && (
          <div className="p-4"><QueryError error={flowsQ.error} onRetry={() => flowsQ.refetch()} /></div>
        )}
        {flowsQ.isPending && (
          <div className="p-6 text-sm text-ink-tertiary" role="status">Loading…</div>
        )}
        {flowsQ.isSuccess && flows.length === 0 && (
          <div className="p-6 text-sm text-ink-tertiary">
            No flows yet. Click <span className="font-semibold">New flow</span> to create one or import one from the community registry.
          </div>
        )}
        {flows.map((f) => {
          const isOrgDefault = orgAssignment?.flowId === f.id;
          const flowAssignments = assignments.filter(a => a.flowId === f.id);
          const repoCount = flowAssignments.filter(a => a.scope === 'repo').length;
          const installCount = flowAssignments.filter(a => a.scope === 'installation').length;
          const expanded = expandedFlowId === f.id;
          return (
            <div key={f.id}>
              <button
                onClick={() => setExpandedFlowId(expanded ? null : f.id)}
                data-testid={`admin-flow-row-${f.id}`}
                aria-expanded={expanded}
                className="w-full text-left p-4 hover:bg-accent-fill transition-colors flex items-center gap-3"
              >
                <span className="text-ink-tertiary shrink-0">
                  {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-ink truncate">{f.name}</span>
                    <span className={
                      'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full font-bold ' +
                      (f.source === 'community'
                        ? 'bg-accent-fill text-accent-ink'
                        : 'bg-canvas text-ink-secondary')
                    }>{f.source ?? 'hub'}</span>
                    {isOrgDefault && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full font-bold bg-status-ok-bg text-status-ok-text">
                        Org default
                      </span>
                    )}
                    {f.orgAvailable && !isOrgDefault && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full font-bold bg-accent-fill text-accent-ink">
                        Available
                      </span>
                    )}
                    {repoCount > 0 && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full font-bold bg-canvas text-ink-secondary border border-border-soft">
                        {repoCount} repo{repoCount === 1 ? '' : 's'}
                      </span>
                    )}
                    {installCount > 0 && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full font-bold bg-canvas text-ink-secondary border border-border-soft">
                        {installCount} install{installCount === 1 ? '' : 's'}
                      </span>
                    )}
                    {typeof f.hubVersion === 'number' && (
                      <span className="text-[10px] text-ink-tertiary">v{f.hubVersion}</span>
                    )}
                  </div>
                  {f.description && (
                    <p className="mt-0.5 text-xs text-ink-tertiary truncate">{f.description}</p>
                  )}
                </div>
                <span className="text-xs text-ink-tertiary shrink-0">{f.steps?.length ?? 0} steps</span>
              </button>
              {expanded && (
                <AssignmentsPanel
                  flow={f}
                  assignments={flowAssignments}
                  childHubs={childHubs}
                  onEdit={() => openEditor(f.id)}
                />
              )}
            </div>
          );
        })}
      </div>

      <FlowDispatches flows={flows} isParent={isParent} hasLiveChildren={childHubs.length > 0} />
      </div>
      )}

      {tab === 'registry' && (
        <div role="tabpanel" id="flows-panel-registry" aria-labelledby="flows-tab-registry" className="space-y-4">
          <RegistryRepoPanel />
          <RegistryPullsPanel />
        </div>
      )}

      <FlowEditorModal
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        projectId={HUB_PROJECT_TOKEN}
        activeFlowId={orgAssignment?.flowId ?? undefined}
        initialFlowId={initialFlowId}
        flowClient={flowClient}
        registryClient={registryClient}
        // Footer captions. In the hub admin, saving the row IS the fleet-wide
        // publish — the bumped `version` is the ETag every installation polls
        // at `GET /v1/flows/active` — and the selection button writes an
        // org-default assignment rather than "using" anything. Left as the
        // editor's own wording, both read as a pipeline that does not exist.
        labels={EDITOR_LABELS_HUB}
        // CGLAB-428: the org's hub is the one place a step's checks may be switched off.
        canDisableChecks
        tabLabels={{
          myFlows: tabLabels.myFlows,
          // While the picker is showing, the tab names the repo it is CURRENTLY
          // reading — not the org's default — otherwise switching source would
          // relist the panel under a caption describing the other repo.
          registry: registrySource === 'community'
            ? 'Community'
            : tabLabels.registry,
        }}
        registryToolbar={showSourcePicker ? (
          <RegistrySourcePicker
            options={registrySourceOptions({
              isPublic: registryCfg?.isPublic ?? null,
              repo: registryCfg?.repo ?? null,
            })}
            value={registrySource}
            onChange={(v) => {
              setRegistrySource(v);
              sourceRef.current = v;
            }}
          />
        ) : undefined}
        theme={theme}
      />
    </div>
  );
}

// ── Assignments panel ──────────────────────────────────────────────────────

function AssignmentsPanel({
  flow, assignments, childHubs, onEdit,
}: {
  flow: Flow;
  assignments: Assignment[];
  childHubs: ChildHubRow[];
  onEdit: () => void;
}) {
  const { confirm, dialog } = useConfirm();
  const qc = useQueryClient();
  const [adding, setAdding] = useState<'repo' | 'installation' | null>(null);

  // Assignment changes can move org_available server-side (setting the org
  // default forces the flow available), so refresh the flows list too — that's
  // where orgAvailable lives and what the picker-availability row reads.
  const invalidateFlowState = () => {
    qc.invalidateQueries({ queryKey: ['admin-flow-assignments'] });
    qc.invalidateQueries({ queryKey: ['admin-flows'] });
  };
  // A success in the panel clears the other changes' leftover errors, which
  // would otherwise read as current.
  const clearPanelErrors = () => { for (const m of [setOrgDefault, remove, addOverride, setAvailability]) if (m.isError) m.reset(); };

  const setOrgDefault = useMutation({
    mutationFn: () => api.put('/v1/admin/flow-assignments', { scope: 'org', flowId: flow.id }),
    onSuccess: () => { clearPanelErrors(); invalidateFlowState(); },
  });

  const remove = useMutation({
    mutationFn: ({ scope, targetId }: { scope: string; targetId: string }) =>
      api.put('/v1/admin/flow-assignments', { scope, targetId, flowId: null }),
    onSuccess: () => { clearPanelErrors(); invalidateFlowState(); },
  });

  const addOverride = useMutation({
    mutationFn: ({ scope, targetId }: { scope: 'repo' | 'installation'; targetId: string }) =>
      api.put('/v1/admin/flow-assignments', { scope, targetId, flowId: flow.id }),
    onSuccess: () => {
      clearPanelErrors();
      qc.invalidateQueries({ queryKey: ['admin-flow-assignments'] });
      setAdding(null);
    },
  });

  const setAvailability = useMutation({
    mutationFn: (available: boolean) =>
      api.put(`/v1/admin/flows/${flow.id}/availability`, { available }),
    // The org-available flag lives on the flows list, not the assignments list.
    onSuccess: () => { clearPanelErrors(); qc.invalidateQueries({ queryKey: ['admin-flows'] }); },
  });

  const orgRow = assignments.find(a => a.scope === 'org');
  const availability = availabilityRowState(flow.orgAvailable === true, !!orgRow);
  // The definition belongs to the parent hub; the availability does not, so
  // this deliberately gates Edit alone. See parentFlowLock.
  const lock = parentFlowLock(flow.source);

  /** Take an override off after the admin has seen who it moves. */
  const confirmRemove = async (scope: 'repo' | 'installation', row: Assignment | undefined, targetId: string) => {
    const what = scope === 'repo' ? `the repo ${row?.remoteUrl ?? targetId}` : `the installation ${targetId}`;
    if (await confirm({
      title: `Remove the override for ${what}?`,
      body: `It stops being assigned "${flow.name}" by this override. From its next sync it follows the next assignment in line (installation, repo, project), else the org default; with none at all, its installations keep the flow they already have.`,
      confirmLabel: 'Remove override',
    })) remove.mutate({ scope, targetId });
  };

  return (
    <div className="px-4 pb-4 pt-1 bg-canvas border-t border-border-soft space-y-3">
      {dialog}
      {/* One slot per change; react-query clears each on its next attempt. */}
      <InlineError error={setOrgDefault.error} />
      <InlineError error={remove.error} />
      <InlineError error={addOverride.error} />
      <InlineError error={setAvailability.error} />
      {lock.locked && (
        <p className="pt-2 text-xs text-ink-tertiary" data-testid="admin-flow-parent-lock">
          {lock.reason}
        </p>
      )}
      <div className="flex items-center justify-between pt-2">
        <h3 className="text-xs uppercase tracking-wide font-semibold text-ink-tertiary">Assignments</h3>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onEdit}
            disabled={lock.locked}
            title={lock.reason ?? undefined}
            className={
              'px-2 py-1 rounded-md text-[11px] font-semibold inline-flex items-center gap-1 ' +
              (lock.locked
                ? 'text-ink-tertiary opacity-60 cursor-not-allowed'
                : 'text-ink-secondary hover:bg-accent-fill')
            }
            data-testid="admin-flow-edit-btn"
          >
            <Pencil className="w-3 h-3" /> Edit flow
          </button>
        </div>
      </div>

      {/* Org-default toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full font-bold bg-status-ok-bg text-status-ok-text">
            Org
          </span>
          <span className="text-xs text-ink-secondary">
            {orgRow ? 'This flow is the org default.' : 'Not the org default.'}
          </span>
        </div>
        {orgRow ? (
          <button
            onClick={async () => {
              if (await confirm({
                title: `Stop using "${flow.name}" as the org default?`,
                body: 'Installations and repos without an override of their own stop being assigned a flow by the hub: they keep the flow they already have until another one is assigned.',
                confirmLabel: 'Clear org default',
              })) remove.mutate({ scope: 'org', targetId: '' });
            }}
            disabled={remove.isPending}
            aria-label={`Clear org default (${flow.name})`}
            className="text-[11px] text-status-danger-text hover:underline"
          >
            Clear
          </button>
        ) : (
          <button
            onClick={async () => {
              if (await confirm({
                title: `Make "${flow.name}" the org default?`,
                body: `Every installation without an assignment of its own (installation, repo or project) will use "${flow.name}" from its next sync, replacing the current org default.`,
                confirmLabel: 'Set as org default',
                tone: 'default',
              })) setOrgDefault.mutate();
            }}
            disabled={setOrgDefault.isPending}
            className="text-[11px] text-accent-ink font-semibold hover:underline"
            data-testid="admin-flow-set-org-default"
          >
            Set as org default
          </button>
        )}
      </div>

      {/* Org-availability toggle — controls whether the flow appears in the
          org-wide flow picker (flows.org_available). Separate from the org
          default, but the default is always available and locked on here. */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-accent-fill text-accent-ink">
            Shown in flow picker
          </span>
          <span className="text-xs text-ink-secondary">{availability.hint}</span>
        </div>
        {availability.locked ? (
          <span className="text-[11px] text-ink-tertiary">Locked on</span>
        ) : (
          <button
            onClick={() => setAvailability.mutate(availability.nextAvailable)}
            disabled={setAvailability.isPending}
            className={
              'text-[11px] font-semibold hover:underline ' +
              (availability.nextAvailable
                ? 'text-accent-ink'
                : 'text-status-danger-text')
            }
            data-testid="admin-flow-toggle-availability"
          >
            {availability.actionLabel}
          </button>
        )}
      </div>

      {/* Repo overrides (keyed on the git remote URL — shared across all
          installations of a repo). Legacy per-project rows are migrated to
          repo scope on the hub; the project axis is no longer surfaced here. */}
      <ScopeSection
        scope="repo"
        label="Repo overrides"
        addLabel="Add repo override"
        chipClass="text-ink-secondary"
        rows={assignments.filter(a => a.scope === 'repo')}
        onRemove={(targetId) => confirmRemove('repo', assignments.find(a => a.scope === 'repo' && a.targetId === targetId), targetId)}
        onAdd={() => setAdding('repo')}
      />

      {/* Installation overrides */}
      <ScopeSection
        scope="installation"
        label="Installation overrides"
        addLabel="Add installation override"
        chipClass="text-ink-secondary"
        rows={assignments.filter(a => a.scope === 'installation')}
        onRemove={(targetId) => confirmRemove('installation', undefined, targetId)}
        onAdd={() => setAdding('installation')}
      />

      {/* Child hubs (CGLAB-358). Only a parent sees this: the list is empty
          on a standalone hub and the row is not rendered at all. */}
      {childHubs.length > 0 && <ChildHubsRow flow={flow} childHubs={childHubs} />}

      {adding && (
        <AddOverridePicker
          scope={adding}
          existingTargetIds={new Set(assignments.filter(a => a.scope === adding).map(a => a.targetId))}
          onCancel={() => setAdding(null)}
          onPick={(targetId) => addOverride.mutate({ scope: adding, targetId })}
        />
      )}
    </div>
  );
}

// ── Dispatch to child hubs (CGLAB-358) ─────────────────────────────────────

/**
 * The 'Child hubs' row of a flow's panel: the Dispatch control and, once
 * pressed, the picker beneath it. Gated by canDispatchFlow, so a flow the
 * parent sent shows the control disabled with the reason, not hidden.
 */
function ChildHubsRow({ flow, childHubs }: { flow: Flow; childHubs: ChildHubRow[] }) {
  const [open, setOpen] = useState(false);
  const gate = canDispatchFlow(flow, childHubs);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-ink-secondary">Child hubs</span>
        <button
          onClick={() => setOpen(v => !v)}
          disabled={!gate.allowed}
          title={gate.reason ?? undefined}
          className={
            'text-[11px] inline-flex items-center gap-1 ' +
            (gate.allowed ? 'text-accent-ink hover:underline' : 'text-ink-tertiary opacity-60 cursor-not-allowed')
          }
          data-testid="admin-flow-dispatch-btn"
        >
          <Send className="w-3 h-3" /> Dispatch to child hubs
        </button>
      </div>
      {!gate.allowed && gate.reason && (
        <p className="text-[11px] text-ink-tertiary" data-testid="admin-flow-dispatch-reason">{gate.reason}</p>
      )}
      {open && gate.allowed && (
        <DispatchPicker flowId={flow.id} childHubs={childHubs} onDone={() => setOpen(false)} />
      )}
    </div>
  );
}

/**
 * Picks the children a flow goes to and sends the dispatch. 'all' posts no ids
 * on purpose: the server resolves it against current AND future children, so
 * a hub that enrols tomorrow still gets the flow. See flowDispatch.ts.
 */
function DispatchPicker({
  flowId, childHubs, onDone,
}: {
  flowId: string;
  childHubs: ChildHubRow[];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<DispatchScopeMode>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: (body: FlowDispatchRequest) => api.post('/v1/admin/flow-dispatches', body),
    onMutate: () => setError(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-flow-dispatches'] });
      onDone();
    },
    onError: (e: any) => setError(dispatchRefusalMessage(e?.response?.data, childHubs, 'Could not dispatch the flow')),
  });

  const toggle = (id: string) => setSelected(prev => toggledSet(prev, id));

  const submit = () => {
    const r = flowDispatchBody(flowId, mode, selected);
    if (!r.ok) { setError(r.error); return; }
    send.mutate(r.body);
  };

  return (
    <div className="bg-surface border border-border-soft rounded-md p-2 space-y-2" data-testid="flow-dispatch-picker">
      <ChildHubPicker
        childHubs={childHubs}
        mode={mode}
        selected={selected}
        onMode={setMode}
        onToggle={toggle}
        onClose={onDone}
        testIdPrefix="flow-dispatch"
        groupLabel="Dispatch to"
      />
      {error && (
        <p className="text-xs text-status-danger-text" data-testid="flow-dispatch-error">{error}</p>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={submit}
          disabled={send.isPending}
          className="px-2.5 py-1 rounded-md bg-brand text-navy text-[11px] font-bold disabled:opacity-40"
          data-testid="flow-dispatch-send"
        >
          {send.isPending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

/**
 * What happened after Send. A section of the flows page rather than its own,
 * and absent entirely when there is nothing to report: a hub that has never
 * dispatched has no board. Rendering null on a failed load would make a 500
 * indistinguishable from that, so the error is shown instead.
 */
function FlowDispatches({
  flows, isParent, hasLiveChildren,
}: {
  flows: Flow[];
  isParent: boolean;
  hasLiveChildren: boolean;
}) {
  const { confirm, dialog } = useConfirm();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const knownFlowIds = useMemo(() => new Set(flows.map(f => f.id)), [flows]);

  const q = useQuery<{ dispatches: FlowDispatchRow[] }>({
    queryKey: ['admin-flow-dispatches'],
    queryFn: async () => (await api.get('/v1/admin/flow-dispatches')).data,
    // A standalone hub has nothing here; do not even ask. `isParent` counts
    // detached children too, so a parent whose last child left still sees
    // the history of what it sent.
    enabled: isParent,
    refetchInterval: (query) => {
      const rows = (query.state.data as { dispatches: FlowDispatchRow[] } | undefined)?.dispatches ?? [];
      return flowDispatchPollInterval(rows, knownFlowIds);
    },
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/v1/admin/flow-dispatches/${id}/cancel`, {}),
    onMutate: () => setError(null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-flow-dispatches'] }),
    onError: (e: any) => setError(e?.response?.data?.error ?? 'Could not cancel the dispatch'),
  });

  const nameOf = (flowId: string) => flows.find(f => f.id === flowId)?.name ?? flowId;
  const dispatches = q.data?.dispatches ?? [];

  if (q.isError) {
    return (
      <section className="space-y-2" data-testid="flow-dispatches">
        <h2 className="text-sm font-semibold text-ink">Dispatched to child hubs</h2>
        <p className="text-xs text-status-danger-text" data-testid="flow-dispatches-error">
          Could not load flow dispatches. Reload to try again.
        </p>
      </section>
    );
  }
  if (!isParent || q.isLoading) return null;
  // A parent that has never dispatched gets one line, so the control above is
  // discoverable; a standalone hub returned before this point.
  if (dispatches.length === 0) {
    if (!hasLiveChildren) return null;
    return (
      <section className="space-y-2" data-testid="flow-dispatches">
        <h2 className="text-sm font-semibold text-ink">Dispatched to child hubs</h2>
        <p className="text-xs text-ink-tertiary" data-testid="flow-dispatches-empty">
          Nothing dispatched yet. Expand a flow and choose Dispatch to child hubs.
        </p>
      </section>
    );
  }

  const toneClass = (tone: string) =>
    tone === 'ok' ? 'bg-status-ok-bg text-status-ok-text'
    : tone === 'error' ? 'bg-status-danger-bg text-status-danger-text'
    : tone === 'waiting' ? 'bg-status-warn-bg text-status-warn-text'
    : 'bg-canvas text-ink-secondary';

  return (
    <section className="space-y-2" data-testid="flow-dispatches">
      {dialog}
      <h2 className="text-sm font-semibold text-ink">Dispatched to child hubs</h2>
      {error && (
        <p className="text-xs text-status-danger-text" data-testid="flow-dispatches-action-error">{error}</p>
      )}
      <div className="bg-surface border border-border-soft rounded-2xl divide-y divide-border-soft">
        {dispatches.map(d => {
          const deleted = dispatchFlowDeleted(d, knownFlowIds);
          return (
          <div key={d.id} className="p-3" data-testid={`flow-dispatch-${d.id}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-ink">{nameOf(d.flowId)}</span>
              <span className="text-[10px] text-ink-tertiary">v{d.flowVersion}</span>
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-canvas text-ink-secondary">
                {d.scope}
              </span>
              {d.cancelledAt && (
                <span
                  className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-canvas text-ink-tertiary"
                  data-testid={`flow-dispatch-cancelled-${d.id}`}
                >
                  cancelled
                </span>
              )}
              {d.createdByEmail && (
                <span className="text-[11px] text-ink-tertiary">by {d.createdByEmail}</span>
              )}
              <span className="flex-1" />
              {!d.cancelledAt && (
                <button
                  onClick={async () => {
                    if (await confirm({
                      title: `Cancel the dispatch of ${nameOf(d.flowId)} v${d.flowVersion}?`,
                      body: 'Child hubs that have not installed it yet will not. Child hubs that already installed it keep it.',
                      confirmLabel: 'Cancel dispatch',
                    })) cancel.mutate(d.id);
                  }}
                  disabled={cancel.isPending && cancel.variables === d.id}
                  className="text-[11px] text-status-danger-text hover:underline"
                  data-testid={`flow-dispatch-cancel-${d.id}`}
                  aria-label={`Cancel dispatch of ${nameOf(d.flowId)} v${d.flowVersion}${issuedAt(d.createdAt)}`}
                >
                  Cancel
                </button>
              )}
            </div>
            {deleted && !d.cancelledAt ? (
              <p className="mt-1 text-xs text-status-danger-text" data-testid={`flow-dispatch-deleted-${d.id}`}>
                This flow has been deleted, so the dispatch can never land. Cancel it.
              </p>
            ) : d.targets.length === 0 ? (
              <p className="mt-1 text-xs text-ink-tertiary" data-testid={`flow-dispatch-unpolled-${d.id}`}>
                No child hub has picked this up yet.
              </p>
            ) : (
              <div className="mt-2 space-y-1">
                {d.targets.map(t => {
                  const row = flowDispatchTargetRow(t.state, t.detail);
                  return (
                    <div
                      key={t.childHubId}
                      className={'flex items-center gap-2 text-xs ' + (row.settled ? 'text-ink-tertiary' : 'text-ink-secondary')}
                      data-testid={`flow-dispatch-target-${d.id}-${t.childHubId}`}
                    >
                      <span className="font-medium text-ink">{t.name}</span>
                      <span className={'px-1.5 py-0.5 rounded text-[10px] font-bold ' + toneClass(row.tone)}>{row.label}</span>
                      {row.detail && <span className="truncate min-w-0" title={row.detail}>{row.detail}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          );
        })}
      </div>
    </section>
  );
}

function ScopeSection({
  label, addLabel, chipClass, rows, onRemove, onAdd,
}: {
  scope: 'repo' | 'installation';
  label: string;
  /** The Add button's name: both sections have one, so a bare "Add" is ambiguous. */
  addLabel: string;
  chipClass: string;
  rows: Assignment[];
  onRemove: (targetId: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-ink-secondary">{label}</span>
        <button
          onClick={onAdd}
          aria-label={addLabel}
          className="text-[11px] text-accent-ink hover:underline inline-flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>
      {rows.length === 0 && (
        <p className="text-[11px] text-ink-tertiary">None.</p>
      )}
      {rows.map((r) => (
        <div key={r.targetId} className="flex items-center justify-between bg-surface border border-border-soft rounded-md px-2 py-1.5">
          <span className={'min-w-0 truncate font-mono text-[11px] ' + chipClass} title={r.remoteUrl ?? r.targetId}>
            {r.remoteUrl ?? r.targetId}
          </span>
          <button
            onClick={() => onRemove(r.targetId)}
            className="text-ink-tertiary hover:text-status-danger-text"
            aria-label={`Remove override for ${r.remoteUrl ?? r.targetId}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

function AddOverridePicker({
  scope, existingTargetIds, onCancel, onPick,
}: {
  scope: 'repo' | 'installation';
  existingTargetIds: Set<string>;
  onCancel: () => void;
  onPick: (targetId: string) => void;
}) {
  const projectsQ = useQuery<ProjectInfo[]>({
    queryKey: ['admin-projects-discovery'],
    queryFn: async () => (await api.get('/v1/admin/projects')).data,
    enabled: scope === 'repo',
  });
  const apiKeysQ = useQuery<ApiKeyRow[]>({
    queryKey: ['admin-api-keys'],
    queryFn: async () => (await api.get('/v1/admin/api-keys')).data,
    enabled: scope === 'installation',
  });

  const options = useMemo(() => {
    if (scope === 'repo') {
      // Discovery returns distinct repos (remote URLs). The pick id IS the repo.
      return repoOverrideOptions(projectsQ.data ?? []);
    }
    return (apiKeysQ.data ?? [])
      .filter(k => k.installationId && !k.revokedAt)
      .map(k => ({
        id: k.installationId!,
        label: k.installationId!,
        sub: [k.label, k.gitName ?? k.gitEmail].filter(Boolean).join(' — ') || 'unlabeled',
      }));
  }, [scope, projectsQ.data, apiKeysQ.data]);

  return (
    <div className="bg-surface border border-border-soft rounded-lg p-3 space-y-2 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-ink-secondary">
          Pick a {scope}
        </span>
        <button onClick={onCancel} className="text-ink-tertiary hover:text-ink" aria-label="Cancel">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {options.length === 0 ? (
        <p className="text-[11px] text-ink-tertiary">
          No {scope}s seen yet. Connect an installation and run agenfk to populate this list.
        </p>
      ) : (
        <ul className="max-h-48 overflow-y-auto space-y-1">
          {options.map(o => {
            const taken = existingTargetIds.has(o.id);
            return (
              <li key={o.id}>
                <button
                  disabled={taken}
                  onClick={() => onPick(o.id)}
                  className="w-full text-left px-2 py-1 rounded-md hover:bg-accent-fill disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid={`admin-flow-${scope}-pick-${o.id}`}
                >
                  <div className="text-[12px] font-mono text-ink">{o.label}</div>
                  <div className="text-[10px] text-ink-tertiary">{o.sub}{taken ? ' · already pinned' : ''}</div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Registry repo panel (CGLAB-138) ────────────────────────────────────────
//
// Where the admin points this org's flow registry. Defaults to the public
// community registry; pointing it at a private repo copies the community flows
// across once. The token is write-only from here — the server never returns it,
// so the form shows "a token is stored" and leaves the field blank.

interface RegistryConfig {
  repo: string;
  branch: string;
  isPublic: boolean;
  hasToken: boolean;
  copiedAt: string | null;
}

function RegistryRepoPanel() {
  const { confirm, dialog } = useConfirm();
  const qc = useQueryClient();
  const { data: cfg } = useQuery<RegistryConfig>({
    queryKey: ['admin-registry-config'],
    queryFn: async () => (await api.get('/v1/admin/registry-config')).data,
  });
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  // Seed the repo field once the config arrives; keep it untouched afterwards
  // so a half-typed edit is never wiped by a background refetch.
  useEffect(() => {
    if (cfg && !repo) setRepo(cfg.repo);
  }, [cfg, repo]);

  const hasStoredToken = Boolean(cfg?.hasToken);
  // The token field only matters for a private target. Deriving it from the
  // repo rather than from `cfg.isPublic` keeps the field correct while the
  // admin is mid-edit, before the save has changed the stored config.
  const showToken = repo.trim() !== '' && repo.trim() !== PUBLIC_REGISTRY_REPO;
  const error = registryFormError({ repo, token, hasStoredToken });
  const movingToPublic = repo.trim() === PUBLIC_REGISTRY_REPO && !cfg?.isPublic;

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, string> = { repo: repo.trim() };
      if (token.trim()) body.token = token.trim();
      return (await api.put('/v1/admin/registry-config', body)).data;
    },
    onSuccess: () => {
      setToken('');
      qc.invalidateQueries({ queryKey: ['admin-registry-config'] });
      qc.invalidateQueries({ queryKey: ['admin-registry-flows'] });
      // A different repo has different pull requests.
      qc.invalidateQueries({ queryKey: ['admin-registry-pulls'] });
    },
  });

  const sync = useMutation({
    mutationFn: async () => (await api.post('/v1/admin/registry-config/sync', {})).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-registry-config'] }),
  });

  // `copied`/`failed`/`truncated` are optional on this type because `save.data`
  // is `unknown` until the mutation resolves — the optionality is about the
  // response existing at all, not about `truncated` being absent from a
  // response. The server always sends it (CopyResult.truncated is non-optional),
  // and the route test pins it on both the truncated and the normal path.
  const result = save.data as { copied?: number; failed?: string[]; truncated?: boolean } | undefined;

  return (
    <section
      className="bg-surface border border-border-soft rounded-2xl p-4 space-y-3"
      data-testid="admin-registry-panel"
    >
      {dialog}
      <div>
        <h3 className="text-xs font-semibold text-ink uppercase tracking-wide">Flow registry</h3>
        <p className="mt-0.5 text-xs text-ink-tertiary">
          Where this org&apos;s installations browse and install flows. Pointing it at your own
          repository copies the community flows into it once; you can move back at any time.
        </p>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="text-ink-tertiary">Current:</span>
        <code className="px-1.5 py-0.5 rounded bg-canvas text-ink">{cfg?.repo ?? '…'}</code>
        {cfg?.isPublic ? (
          <span className="text-ink-tertiary">(public community registry)</span>
        ) : (
          <span className="text-status-ok-text">
            (org registry{cfg?.copiedAt ? ' · community flows copied' : ' · copy pending'})
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          data-testid="admin-registry-repo"
          aria-label="Registry repository"
          className="flex-1 px-2.5 py-1.5 rounded-lg bg-canvas border border-border-soft text-xs text-ink"
          placeholder="owner/agenfk-flows"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
        />
        {showToken && (
          <input
            data-testid="admin-registry-token"
            aria-label="GitHub token"
            type="password"
            className="flex-1 px-2.5 py-1.5 rounded-lg bg-canvas border border-border-soft text-xs text-ink"
            placeholder={hasStoredToken ? 'token stored — blank keeps it' : 'GitHub token (contents:write)'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        )}
      </div>

      {error && (
        <p className="text-xs text-status-danger-text" data-testid="admin-registry-error">
          {error}
        </p>
      )}

      {movingToPublic && (
        <p className="text-xs text-status-warn-text" data-testid="admin-registry-confirm">
          {MOVE_BACK_TO_PUBLIC_CONFIRM}
        </p>
      )}

      {result && typeof result.copied === 'number' && (
        <p className="text-xs text-ink-tertiary" data-testid="admin-registry-result">
          {result.copied > 0
            ? `${result.copied} community flow(s) copied into ${repo.trim()}.`
            : 'Registry updated.'}
          {Array.isArray(result.failed) && result.failed.length > 0 && (
            <span className="text-status-danger-text">
              {' '}Failed: {result.failed.join(', ')} — use Retry copy.
            </span>
          )}
          {result.truncated && (
            <span className="text-status-warn-text">
              {' '}The source registry has more flows than one run copies — use Retry copy to continue.
            </span>
          )}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          data-testid="admin-registry-save"
          disabled={!!error || save.isPending}
          onClick={async () => {
            // Moving back to public is reversible but changes what every
            // installation reads, so it earns an explicit click.
            if (movingToPublic && !(await confirm({
              title: 'Move back to the public registry?',
              body: MOVE_BACK_TO_PUBLIC_CONFIRM,
              confirmLabel: 'Move to public',
              tone: 'default',
            }))) return;
            save.mutate();
          }}
          className="px-3 py-1.5 rounded-lg bg-brand text-navy text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {save.isPending ? 'Saving…' : registryConfigSaveLabel({ repo, token, hasStoredToken })}
        </button>
        {!cfg?.isPublic && (
          <button
            data-testid="admin-registry-sync"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
            className="px-3 py-1.5 rounded-lg border border-border-soft text-xs text-ink-tertiary disabled:opacity-40"
          >
            {sync.isPending ? 'Copying…' : 'Retry copy'}
          </button>
        )}
      </div>

      <InlineError error={save.error} />
      <InlineError error={sync.error} />
    </section>
  );
}

/** Which registry the flow editor browses: the org's own repo or the community one. */
export function RegistrySourcePicker({ options, value, onChange }: {
  options: Array<{ value: RegistrySource; label: string }>;
  value: RegistrySource;
  onChange: (v: RegistrySource) => void;
}) {
  return (
    <div role="group" aria-label="Registry source" className="flex items-center gap-1.5" data-testid="registry-source-picker">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          data-testid={`registry-source-${opt.value}`}
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={clsx(
            'px-2 py-0.5 rounded-full text-[11px] border transition-colors',
            value === opt.value
              ? 'border-accent text-accent-ink bg-accent-fill font-semibold'
              : 'border-border-soft text-ink-tertiary hover:text-ink',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
