import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { CheckCircle, AlertCircle, Loader2, RefreshCw, ExternalLink } from 'lucide-react';
import { clsx } from 'clsx';

// Inline GitHub icon (Lucide doesn't have a GitHub logo)
const GitHubIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className}>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

interface Props {
  projectId: string | null;
}

export const GitHubSyncButton: React.FC<Props> = ({ projectId }) => {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const { data: ghStatus, isLoading } = useQuery({
    queryKey: ['githubStatus', projectId],
    queryFn: () => api.getGitHubStatus(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const pushResult = await api.githubSyncPush(projectId!);
      const pullResult = await api.githubSyncPull(projectId!);
      return { push: pushResult, pull: pullResult };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['githubStatus'] });
      const msg = `Push: ${data.push.created} created, ${data.push.updated} updated. Pull: ${data.pull.created} created, ${data.pull.updated} updated.`;
      setToast({ type: 'success', message: msg });
    },
    onError: (err: any) => {
      const msg = err.response?.data?.error || err.message || 'Sync failed';
      setToast({ type: 'error', message: msg });
    },
  });

  if (isLoading || !ghStatus?.configured) return null;

  const repoUrl = `https://github.com/${ghStatus.owner}/${ghStatus.repo}`;

  return (
    <>
      {toast && (
        <div
          data-testid="github-toast"
          className={clsx(
            'fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium flex items-center gap-2 max-w-md',
            toast.type === 'success' ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white'
          )}
          role="alert"
        >
          {toast.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
          <span className="truncate">{toast.message}</span>
          <button onClick={() => setToast(null)} className="ml-2 hover:opacity-75 flex-shrink-0" aria-label="Dismiss">x</button>
        </div>
      )}

      <a
        href={`${repoUrl}/issues`}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${ghStatus.owner}/${ghStatus.repo} Issues`}
        className="flex items-center gap-1.5 px-2 py-1 bg-slate-100 dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 border border-slate-200 dark:border-slate-700 hover:border-indigo-300 rounded-md text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-indigo-600 transition-colors"
      >
        <GitHubIcon size={12} />
        <span className="hidden xl:inline">Issues</span>
        <ExternalLink size={10} className="opacity-50" />
      </a>

      <button
        onClick={() => syncMutation.mutate()}
        disabled={syncMutation.isPending}
        title="Sync with GitHub Issues"
        className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-white dark:hover:bg-slate-800 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-300 hover:text-indigo-600 transition-all shadow-sm border border-transparent hover:border-slate-200 dark:hover:border-slate-700 disabled:opacity-50"
      >
        {syncMutation.isPending ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <RefreshCw size={14} />
        )}
        <span className="hidden xl:inline">Sync</span>
      </button>
    </>
  );
};
