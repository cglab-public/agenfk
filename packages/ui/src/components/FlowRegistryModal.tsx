import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { RegistryFlow, Flow } from '../types';
import { X, Download, Upload, Globe, Search, ChevronRight, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = 'browse' | 'my-flows' | 'about';

// ── Browse Tab ────────────────────────────────────────────────────────────────

interface BrowseTabProps {
  onInstalled: () => void;
}

const BrowseTab: React.FC<BrowseTabProps> = ({ onInstalled }) => {
  const [search, setSearch] = useState('');
  const [confirming, setConfirming] = useState<RegistryFlow | null>(null);
  const [installedName, setInstalledName] = useState<string | null>(null);

  const { data: flows = [], isLoading, isError, error, refetch } = useQuery<RegistryFlow[]>({
    queryKey: ['registry-flows'],
    queryFn: () => api.browseRegistry(),
    retry: 1,
  });

  const installMutation = useMutation({
    mutationFn: (filename: string) => api.installFromRegistry(filename),
    onSuccess: (flow: Flow) => {
      setInstalledName(flow.name);
      setConfirming(null);
      onInstalled();
      setTimeout(() => setInstalledName(null), 4000);
    },
  });

  const filtered = flows.filter(f =>
    !search ||
    f.name.toLowerCase().includes(search.toLowerCase()) ||
    (f.author ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (f.description ?? '').toLowerCase().includes(search.toLowerCase())
  );

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-slate-500">
        <Loader2 size={28} className="animate-spin" />
        <span>Loading community flows…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <AlertCircle size={28} className="text-red-500" />
        <p className="text-sm text-red-600 dark:text-red-400 text-center max-w-xs">
          {(error as Error)?.message ?? 'Failed to load registry. Check your internet connection.'}
        </p>
        <button
          onClick={() => refetch()}
          className="px-3 py-1.5 text-sm rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200"
        >
          Retry
        </button>
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="flex flex-col gap-4" data-testid="install-confirm-panel">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setConfirming(null)}
            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700"
            aria-label="Back to browse"
          >
            <ChevronRight size={16} className="rotate-180" />
          </button>
          <h3 className="font-semibold text-slate-800 dark:text-slate-100">Install "{confirming.name}"</h3>
        </div>

        {confirming.description && (
          <p className="text-sm text-slate-600 dark:text-slate-400">{confirming.description}</p>
        )}

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
            Steps ({confirming.stepCount})
          </p>
          <p className="text-xs text-slate-400 italic">
            Step details will be available after installation.
          </p>
        </div>

        {installMutation.isError && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-3" data-testid="install-error">
            {(installMutation.error as Error)?.message ?? 'Installation failed'}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={() => setConfirming(null)}
            className="flex-1 px-4 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700"
          >
            Cancel
          </button>
          <button
            data-testid="confirm-install-btn"
            onClick={() => installMutation.mutate(confirming.filename)}
            disabled={installMutation.isPending}
            className="flex-1 px-4 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold flex items-center justify-center gap-2"
          >
            {installMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            Install
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {installedName && (
        <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-900/20 rounded-lg p-3" data-testid="install-success-banner">
          <CheckCircle size={16} />
          <span>"{installedName}" installed successfully.</span>
        </div>
      )}

      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          data-testid="registry-search-input"
          type="text"
          placeholder="Search community flows…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-slate-500 text-center py-8">
          {search ? 'No flows match your search.' : 'No flows in the registry yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
          <table className="w-full text-sm" data-testid="registry-table">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/50 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2 hidden sm:table-cell">Author</th>
                <th className="px-3 py-2 hidden sm:table-cell">Ver</th>
                <th className="px-3 py-2">Steps</th>
                <th className="px-3 py-2 hidden md:table-cell">Description</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
              {filtered.map((flow, idx) => (
                <tr
                  key={flow.filename}
                  data-testid={`registry-row-${idx}`}
                  className="hover:bg-slate-50 dark:hover:bg-slate-800/40"
                >
                  <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-100 whitespace-nowrap">{flow.name}</td>
                  <td className="px-3 py-2 text-slate-500 hidden sm:table-cell">{flow.author ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-500 hidden sm:table-cell">{flow.version ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-500">{flow.stepCount}</td>
                  <td className="px-3 py-2 text-slate-400 hidden md:table-cell max-w-xs truncate">{flow.description ?? ''}</td>
                  <td className="px-3 py-2">
                    <button
                      data-testid={`install-btn-${idx}`}
                      onClick={() => setConfirming(flow)}
                      className="px-2.5 py-1 text-xs rounded-lg bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 font-semibold flex items-center gap-1 whitespace-nowrap"
                    >
                      <Download size={12} />
                      Install
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ── My Flows Tab ──────────────────────────────────────────────────────────────

const MyFlowsTab: React.FC = () => {
  const queryClient = useQueryClient();
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [publishedUrl, setPublishedUrl] = useState<Record<string, string>>({});
  const [publishError, setPublishError] = useState<Record<string, string>>({});

  const { data: flows = [], isLoading, isError } = useQuery<Flow[]>({
    queryKey: ['flows'],
    queryFn: () => api.listFlows(),
  });

  const publishMutation = useMutation({
    mutationFn: ({ flowId, token }: { flowId: string; token: string }) =>
      api.publishToRegistry(flowId, token),
    onSuccess: (result, { flowId }) => {
      setPublishedUrl(prev => ({ ...prev, [flowId]: result.url }));
      setPublishError(prev => { const n = { ...prev }; delete n[flowId]; return n; });
      setPublishingId(null);
      setToken('');
      queryClient.invalidateQueries({ queryKey: ['registry-flows'] });
    },
    onError: (e: Error, { flowId }) => {
      setPublishError(prev => ({ ...prev, [flowId]: e.message ?? 'Publish failed' }));
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 gap-3 text-slate-500">
        <Loader2 size={24} className="animate-spin" />
        <span>Loading your flows…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center py-16 gap-2 text-red-500">
        <AlertCircle size={20} />
        <span className="text-sm">Failed to load flows.</span>
      </div>
    );
  }

  if (flows.length === 0) {
    return (
      <p className="text-sm text-slate-500 text-center py-12">
        No flows yet. Create one using the Flow button in the board toolbar.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="my-flows-list">
      {flows.map((flow, idx) => (
        <div
          key={flow.id}
          data-testid={`my-flow-row-${idx}`}
          className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 flex flex-col gap-2"
        >
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="font-medium text-slate-800 dark:text-slate-100">{flow.name}</p>
              {flow.description && (
                <p className="text-xs text-slate-400">{flow.description}</p>
              )}
              <p className="text-xs text-slate-400">{flow.steps.length} step{flow.steps.length !== 1 ? 's' : ''}</p>
            </div>
            <button
              data-testid={`publish-btn-${idx}`}
              onClick={() => {
                setPublishingId(publishingId === flow.id ? null : flow.id);
                setToken('');
              }}
              className="px-2.5 py-1 text-xs rounded-lg bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-300 hover:bg-emerald-100 font-semibold flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              <Upload size={12} />
              Publish
            </button>
          </div>

          {publishedUrl[flow.id] && (
            <div className="text-xs text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-900/20 rounded p-2 flex items-center gap-1" data-testid={`publish-success-${idx}`}>
              <CheckCircle size={12} />
              Published!{' '}
              <a href={publishedUrl[flow.id]} target="_blank" rel="noopener noreferrer" className="underline hover:no-underline truncate">
                {publishedUrl[flow.id]}
              </a>
            </div>
          )}

          {publishError[flow.id] && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded p-2" data-testid={`publish-error-${idx}`}>
              {publishError[flow.id]}
            </div>
          )}

          {publishingId === flow.id && (
            <div className="flex flex-col gap-2 pt-1" data-testid={`publish-form-${idx}`}>
              <input
                data-testid={`github-token-input-${idx}`}
                type="password"
                placeholder="GitHub Personal Access Token (repo scope)"
                value={token}
                onChange={e => setToken(e.target.value)}
                className="w-full px-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-400"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => { setPublishingId(null); setToken(''); }}
                  className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700"
                >
                  Cancel
                </button>
                <button
                  data-testid={`submit-publish-btn-${idx}`}
                  onClick={() => publishMutation.mutate({ flowId: flow.id, token })}
                  disabled={!token.trim() || publishMutation.isPending}
                  className="flex-1 px-3 py-1.5 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold flex items-center justify-center gap-1.5"
                >
                  {publishMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                  Submit
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

// ── About Tab ─────────────────────────────────────────────────────────────────

const AboutTab: React.FC = () => (
  <div className="flex flex-col gap-4 text-sm text-slate-600 dark:text-slate-400" data-testid="about-tab">
    <div className="rounded-lg bg-indigo-50 dark:bg-indigo-900/20 p-4">
      <h3 className="font-semibold text-indigo-700 dark:text-indigo-300 mb-2 flex items-center gap-2">
        <Globe size={16} />
        Community Flow Registry
      </h3>
      <p>
        The AgenFK Flow Registry is a GitHub-based repository of community-contributed workflow
        definitions. You can browse and install flows created by other teams, or publish your own
        flows to share best practices.
      </p>
    </div>

    <div>
      <h4 className="font-semibold text-slate-700 dark:text-slate-200 mb-1">Registry repository</h4>
      <a
        href="https://github.com/agenfk-flows/registry"
        target="_blank"
        rel="noopener noreferrer"
        className="text-indigo-600 dark:text-indigo-400 underline hover:no-underline text-sm"
        data-testid="registry-repo-link"
      >
        github.com/agenfk-flows/registry
      </a>
    </div>

    <div>
      <h4 className="font-semibold text-slate-700 dark:text-slate-200 mb-1">Publishing flows</h4>
      <p>
        To publish a flow, you need a GitHub Personal Access Token with <code className="bg-slate-100 dark:bg-slate-700 px-1 rounded">repo</code> scope.
        You can also pre-configure the token via the environment variable:
      </p>
      <pre className="mt-1.5 bg-slate-100 dark:bg-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-700 dark:text-slate-200 overflow-x-auto">
        AGENFK_REGISTRY_TOKEN=ghp_...
      </pre>
    </div>

    <div>
      <h4 className="font-semibold text-slate-700 dark:text-slate-200 mb-1">Installing flows</h4>
      <p>
        Installed flows are added to your local flow library. You can then assign them to a project
        via the Flow editor in the board toolbar.
      </p>
    </div>
  </div>
);

// ── Main Modal ────────────────────────────────────────────────────────────────

export const FlowRegistryModal: React.FC<Props> = ({ open, onClose }) => {
  const [activeTab, setActiveTab] = useState<Tab>('browse');
  const queryClient = useQueryClient();

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (open) window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'browse', label: 'Browse' },
    { id: 'my-flows', label: 'My Flows' },
    { id: 'about', label: 'About' },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      data-testid="flow-registry-modal"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-slate-100 dark:border-slate-700 shrink-0">
          <div className="flex items-center gap-2">
            <Globe size={18} className="text-indigo-500" />
            <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">Community Flows</h2>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 px-5 border-b border-slate-100 dark:border-slate-700 shrink-0">
          {tabs.map(tab => (
            <button
              key={tab.id}
              data-testid={`tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
                activeTab === tab.id
                  ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === 'browse' && (
            <BrowseTab onInstalled={() => queryClient.invalidateQueries({ queryKey: ['flows'] })} />
          )}
          {activeTab === 'my-flows' && <MyFlowsTab />}
          {activeTab === 'about' && <AboutTab />}
        </div>
      </div>
    </div>
  );
};
