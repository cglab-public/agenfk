/**
 * Admin → Flows section. Reuses the shared FlowEditorModal (same UI as the
 * agenfk client) with a hub-flavoured client routing all reads/writes to
 * /v1/admin/flows + /v1/admin/registry. The Community tab works identically
 * because its registry surface is shape-compatible.
 */
import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { FlowEditorModal, type FlowClient, type RegistryClient, type Flow } from '@agenfk/flow-editor';
import { api } from '../api';
import { flattenAdminFlow } from './adminFlowShape';

const HUB_PROJECT_TOKEN = 'org-default'; // pseudo-projectId — hub binds to org-default assignment

const flowClient: FlowClient = {
  listFlows: async () => ((await api.get('/v1/admin/flows')).data as any[]).map(flattenAdminFlow),
  getDefaultFlow: async () => (await api.get('/v1/admin/flows/default')).data,
  createFlow: async (payload) => {
    // The hub admin endpoint expects { definition: <Flow JSON minus id/createdAt/updatedAt> }.
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
    // In hub admin context, "set project flow" means "set org-default flow".
    await api.put('/v1/admin/flow-assignments', { flowId });
  },
};

const registryClient: RegistryClient = {
  browseRegistry: async () => (await api.get('/v1/admin/registry/flows')).data,
  installFromRegistry: async (filename) => flattenAdminFlow((await api.post('/v1/admin/flows/install', { filename })).data),
  publishToRegistry: async () => {
    // Publishing back to the GitHub community registry is reserved to the
    // local agenfk client (which has gh CLI auth). Surface a clean error here.
    throw new Error('Publishing to the community registry is not supported from the Hub admin yet. Use your local agenfk client.');
  },
};

export function AdminFlows() {
  const qc = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [initialFlowId, setInitialFlowId] = useState<string | undefined>(undefined);

  const { data: flows = [] } = useQuery<Flow[]>({
    queryKey: ['admin-flows'],
    queryFn: () => flowClient.listFlows(),
  });
  const { data: assignment } = useQuery<{ flowId: string | null }>({
    queryKey: ['admin-flow-assignment'],
    queryFn: async () => (await api.get('/v1/admin/flow-assignments')).data,
  });

  // Refresh local queries whenever the editor closes — the modal manages its
  // own react-query invalidations under different keys, so we mirror them.
  useEffect(() => {
    if (!editorOpen) {
      qc.invalidateQueries({ queryKey: ['admin-flows'] });
      qc.invalidateQueries({ queryKey: ['admin-flow-assignment'] });
    }
  }, [editorOpen, qc]);

  const open = (flowId?: string) => { setInitialFlowId(flowId); setEditorOpen(true); };

  return (
    <div className="space-y-4 max-w-3xl">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Org-managed flows</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Define and assign workflow flows that all installations connected to this Hub adopt automatically.
          </p>
        </div>
        <button
          className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold inline-flex items-center gap-1.5"
          onClick={() => open()}
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
          const isDefault = assignment?.flowId === f.id;
          return (
            <button
              key={f.id}
              onClick={() => open(f.id)}
              data-testid={`admin-flow-row-${f.id}`}
              className="w-full text-left p-4 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors flex items-center gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-800 dark:text-slate-100 truncate">{f.name}</span>
                  <span className={
                    'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full font-bold ' +
                    (f.source === 'community'
                      ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300')
                  }>{f.source ?? 'hub'}</span>
                  {isDefault && (
                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full font-bold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">
                      Org default
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
              <span className="text-xs text-slate-400">{f.steps?.length ?? 0} steps</span>
            </button>
          );
        })}
      </div>

      <FlowEditorModal
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        projectId={HUB_PROJECT_TOKEN}
        activeFlowId={assignment?.flowId ?? undefined}
        initialFlowId={initialFlowId}
        flowClient={flowClient}
        registryClient={registryClient}
        theme="light"
      />
    </div>
  );
}
