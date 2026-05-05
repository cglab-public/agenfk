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
import { useState, useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, X, ChevronDown, ChevronRight } from 'lucide-react';
import { FlowEditorModal, type FlowClient, type RegistryClient, type Flow } from '@agenfk/flow-editor';
import { api } from '../api';
import { flattenAdminFlow } from './adminFlowShape';

const HUB_PROJECT_TOKEN = 'org-default'; // pseudo-projectId — hub binds to org-default assignment

interface Assignment {
  scope: 'org' | 'project' | 'installation';
  targetId: string;
  flowId: string;
  updatedAt: string;
}

interface ProjectInfo { projectId: string; lastSeen: string }
interface ApiKeyRow { tokenHashPreview: string; label: string | null; installationId: string | null; gitName: string | null; gitEmail: string | null; revokedAt: string | null }

const flowClient: FlowClient = {
  listFlows: async () => ((await api.get('/v1/admin/flows')).data as any[]).map(flattenAdminFlow),
  getDefaultFlow: async () => (await api.get('/v1/admin/flows/default')).data,
  createFlow: async (payload) => {
    const { id: _id, createdAt: _c, updatedAt: _u, ...definition } = payload as any;
    const r = await api.post('/v1/admin/flows', { definition });
    return flattenAdminFlow(r.data);
  },
  updateFlow: async (id, payload) => {
    const { id: _id, createdAt: _c, updatedAt: _u, ...definition } = payload as any;
    const r = await api.put(`/v1/admin/flows/${id}`, { definition });
    return flattenAdminFlow(r.data);
  },
  deleteFlow: async (id) => { await api.delete(`/v1/admin/flows/${id}`); },
  setProjectFlow: async (_projectId, flowId) => {
    await api.put('/v1/admin/flow-assignments', { flowId });
  },
};

const registryClient: RegistryClient = {
  browseRegistry: async () => (await api.get('/v1/admin/registry/flows')).data,
  installFromRegistry: async (filename) => flattenAdminFlow((await api.post('/v1/admin/flows/install', { filename })).data),
  publishToRegistry: async () => {
    throw new Error('Publishing to the community registry is not supported from the Hub admin yet. Use your local agenfk client.');
  },
};

export function AdminFlows() {
  const qc = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [initialFlowId, setInitialFlowId] = useState<string | undefined>(undefined);
  const [expandedFlowId, setExpandedFlowId] = useState<string | null>(null);

  const { data: flows = [] } = useQuery<Flow[]>({
    queryKey: ['admin-flows'],
    queryFn: () => flowClient.listFlows(),
  });
  const { data: assignments = [] } = useQuery<Assignment[]>({
    queryKey: ['admin-flow-assignments'],
    queryFn: async () => (await api.get('/v1/admin/flow-assignments')).data,
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
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Org-managed flows</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Define and assign workflow flows. Connected installations adopt the most specific assignment (installation &gt; project &gt; org).
          </p>
        </div>
        <button
          className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold inline-flex items-center gap-1.5"
          onClick={() => openEditor()}
          data-testid="admin-flows-new-btn"
        >
          <Plus className="w-3.5 h-3.5" /> New / Import
        </button>
      </header>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl divide-y divide-slate-200 dark:divide-slate-800">
        {flows.length === 0 && (
          <div className="p-6 text-sm text-slate-500 dark:text-slate-400">
            No flows yet. Click <span className="font-semibold">New / Import</span> to create one or pull from the community registry.
          </div>
        )}
        {flows.map((f) => {
          const isOrgDefault = orgAssignment?.flowId === f.id;
          const flowAssignments = assignments.filter(a => a.flowId === f.id);
          const projectCount = flowAssignments.filter(a => a.scope === 'project').length;
          const installCount = flowAssignments.filter(a => a.scope === 'installation').length;
          const expanded = expandedFlowId === f.id;
          return (
            <div key={f.id}>
              <button
                onClick={() => setExpandedFlowId(expanded ? null : f.id)}
                data-testid={`admin-flow-row-${f.id}`}
                className="w-full text-left p-4 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors flex items-center gap-3"
              >
                <span className="text-slate-400 shrink-0">
                  {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-slate-800 dark:text-slate-100 truncate">{f.name}</span>
                    <span className={
                      'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full font-bold ' +
                      (f.source === 'community'
                        ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300')
                    }>{f.source ?? 'hub'}</span>
                    {isOrgDefault && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full font-bold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">
                        Org default
                      </span>
                    )}
                    {projectCount > 0 && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full font-bold bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                        {projectCount} project{projectCount === 1 ? '' : 's'}
                      </span>
                    )}
                    {installCount > 0 && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full font-bold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
                        {installCount} install{installCount === 1 ? '' : 's'}
                      </span>
                    )}
                    {typeof f.hubVersion === 'number' && (
                      <span className="text-[10px] text-slate-400">v{f.hubVersion}</span>
                    )}
                  </div>
                  {f.description && (
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 truncate">{f.description}</p>
                  )}
                </div>
                <span className="text-xs text-slate-400 shrink-0">{f.steps?.length ?? 0} steps</span>
              </button>
              {expanded && (
                <AssignmentsPanel
                  flow={f}
                  assignments={flowAssignments}
                  onEdit={() => openEditor(f.id)}
                />
              )}
            </div>
          );
        })}
      </div>

      <FlowEditorModal
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        projectId={HUB_PROJECT_TOKEN}
        activeFlowId={orgAssignment?.flowId ?? undefined}
        initialFlowId={initialFlowId}
        flowClient={flowClient}
        registryClient={registryClient}
        theme="light"
      />
    </div>
  );
}

// ── Assignments panel ──────────────────────────────────────────────────────

function AssignmentsPanel({
  flow, assignments, onEdit,
}: {
  flow: Flow;
  assignments: Assignment[];
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<'project' | 'installation' | null>(null);

  const setOrgDefault = useMutation({
    mutationFn: () => api.put('/v1/admin/flow-assignments', { scope: 'org', flowId: flow.id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-flow-assignments'] }),
  });

  const remove = useMutation({
    mutationFn: ({ scope, targetId }: { scope: string; targetId: string }) =>
      api.put('/v1/admin/flow-assignments', { scope, targetId, flowId: null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-flow-assignments'] }),
  });

  const addOverride = useMutation({
    mutationFn: ({ scope, targetId }: { scope: 'project' | 'installation'; targetId: string }) =>
      api.put('/v1/admin/flow-assignments', { scope, targetId, flowId: flow.id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-flow-assignments'] });
      setAdding(null);
    },
  });

  const orgRow = assignments.find(a => a.scope === 'org');

  return (
    <div className="px-4 pb-4 pt-1 bg-slate-50 dark:bg-slate-900/40 border-t border-slate-200 dark:border-slate-800 space-y-3">
      <div className="flex items-center justify-between pt-2">
        <h3 className="text-xs uppercase tracking-wide font-semibold text-slate-500 dark:text-slate-400">Assignments</h3>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onEdit}
            className="px-2 py-1 rounded-md text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 inline-flex items-center gap-1"
            data-testid="admin-flow-edit-btn"
          >
            <Pencil className="w-3 h-3" /> Edit flow
          </button>
        </div>
      </div>

      {/* Org-default toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full font-bold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">
            Org
          </span>
          <span className="text-xs text-slate-700 dark:text-slate-200">
            {orgRow ? 'This flow is the org default.' : 'Not the org default.'}
          </span>
        </div>
        {orgRow ? (
          <button
            onClick={() => remove.mutate({ scope: 'org', targetId: '' })}
            disabled={remove.isPending}
            className="text-[11px] text-rose-600 dark:text-rose-400 hover:underline"
          >
            Clear
          </button>
        ) : (
          <button
            onClick={() => setOrgDefault.mutate()}
            disabled={setOrgDefault.isPending}
            className="text-[11px] text-emerald-700 dark:text-emerald-400 font-semibold hover:underline"
            data-testid="admin-flow-set-org-default"
          >
            Set as org default
          </button>
        )}
      </div>

      {/* Project overrides */}
      <ScopeSection
        scope="project"
        label="Project overrides"
        chipClass="bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
        rows={assignments.filter(a => a.scope === 'project')}
        onRemove={(targetId) => remove.mutate({ scope: 'project', targetId })}
        onAdd={() => setAdding('project')}
      />

      {/* Installation overrides */}
      <ScopeSection
        scope="installation"
        label="Installation overrides"
        chipClass="bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300"
        rows={assignments.filter(a => a.scope === 'installation')}
        onRemove={(targetId) => remove.mutate({ scope: 'installation', targetId })}
        onAdd={() => setAdding('installation')}
      />

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

function ScopeSection({
  label, chipClass, rows, onRemove, onAdd,
}: {
  scope: 'project' | 'installation';
  label: string;
  chipClass: string;
  rows: Assignment[];
  onRemove: (targetId: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">{label}</span>
        <button
          onClick={onAdd}
          className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>
      {rows.length === 0 && (
        <p className="text-[11px] text-slate-400 dark:text-slate-500">None.</p>
      )}
      {rows.map((r) => (
        <div key={r.targetId} className="flex items-center justify-between bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-md px-2 py-1.5">
          <span className={'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full font-bold ' + chipClass}>
            {r.targetId}
          </span>
          <button
            onClick={() => onRemove(r.targetId)}
            className="text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
            aria-label="Remove"
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
  scope: 'project' | 'installation';
  existingTargetIds: Set<string>;
  onCancel: () => void;
  onPick: (targetId: string) => void;
}) {
  const projectsQ = useQuery<ProjectInfo[]>({
    queryKey: ['admin-projects-discovery'],
    queryFn: async () => (await api.get('/v1/admin/projects')).data,
    enabled: scope === 'project',
  });
  const apiKeysQ = useQuery<ApiKeyRow[]>({
    queryKey: ['admin-api-keys'],
    queryFn: async () => (await api.get('/v1/admin/api-keys')).data,
    enabled: scope === 'installation',
  });

  const options = useMemo(() => {
    if (scope === 'project') {
      return (projectsQ.data ?? []).map(p => ({ id: p.projectId, label: p.projectId, sub: `last seen ${p.lastSeen}` }));
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
    <div className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg p-3 space-y-2 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
          Pick a {scope}
        </span>
        <button onClick={onCancel} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300" aria-label="Cancel">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {options.length === 0 ? (
        <p className="text-[11px] text-slate-400">
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
                  className="w-full text-left px-2 py-1 rounded-md hover:bg-indigo-50 dark:hover:bg-indigo-900/30 disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid={`admin-flow-${scope}-pick-${o.id}`}
                >
                  <div className="text-[12px] font-mono text-slate-800 dark:text-slate-100">{o.label}</div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">{o.sub}{taken ? ' · already pinned' : ''}</div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
