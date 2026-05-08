import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Link, Unlink, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3000';

export const JiraConnectionButton: React.FC = () => {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Handle OAuth callback params on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const jiraParam = params.get('jira');

    if (jiraParam === 'connected') {
      setToast({ type: 'success', message: 'JIRA connected successfully!' });
      queryClient.invalidateQueries({ queryKey: ['jiraStatus'] });
      params.delete('jira');
      params.delete('reason');
      const newUrl = params.toString()
        ? `${window.location.pathname}?${params}`
        : window.location.pathname;
      window.history.replaceState({}, '', newUrl);
    } else if (jiraParam === 'error') {
      const reason = params.get('reason') || 'unknown_error';
      const messages: Record<string, string> = {
        server_misconfigured: "JIRA not configured. Run 'agenfk jira setup' to get started.",
        no_accessible_resources: 'No JIRA sites found on this account.',
        token_exchange_failed: 'JIRA authentication failed. Please try again.',
        invalid_state: 'OAuth session expired. Please try again.',
        missing_params: 'OAuth callback missing parameters.',
      };
      setToast({ type: 'error', message: messages[reason] || `JIRA error: ${reason}` });
      params.delete('jira');
      params.delete('reason');
      const newUrl = params.toString()
        ? `${window.location.pathname}?${params}`
        : window.location.pathname;
      window.history.replaceState({}, '', newUrl);
    }
  }, []);

  // Auto-dismiss toast after 5 seconds
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const { data: jiraStatus, isLoading, isError } = useQuery({
    queryKey: ['jiraStatus'],
    queryFn: api.getJiraStatus,
    staleTime: 30_000,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
  });

  const disconnectMutation = useMutation({
    mutationFn: api.disconnectJira,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jiraStatus'] });
      setToast({ type: 'success', message: 'JIRA disconnected.' });
    },
  });

  /* v8 ignore start */
  const handleConnect = () => {
    window.location.href = `${API_URL}/jira/oauth/authorize`;
  };
  /* v8 ignore stop */

  return (
    <>
      {/* Toast notification */}
      {toast && (
        <div
          data-testid="jira-toast"
          className={clsx(
            'fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium flex items-center gap-2',
            toast.type === 'success' ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white'
          )}
          role="alert"
        >
          {toast.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} className="ml-2 hover:opacity-75" aria-label="Dismiss">×</button>
        </div>
      )}

      {/* Connection control — show spinner while loading or retrying (prevents false "disconnected" flash) */}
      {(isLoading || (isError && !jiraStatus)) ? (
        <div className="p-2 text-slate-400" data-testid="jira-loading">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : jiraStatus?.connected ? (
        <div className="flex items-center gap-1.5" data-testid="jira-connected">
          <div className="flex items-center gap-1.5 px-2 py-1 bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-700 rounded-md text-xs font-medium text-emerald-700 dark:text-emerald-400">
            <CheckCircle size={12} />
            <span>JIRA</span>
          </div>
          <button
            onClick={() => disconnectMutation.mutate()}
            disabled={disconnectMutation.isPending}
            title="Disconnect JIRA"
            aria-label="Disconnect JIRA"
            className="p-1 text-slate-400 hover:text-red-500 transition-colors disabled:opacity-50"
          >
            <Unlink size={14} />
          </button>
        </div>
      ) : jiraStatus?.configured === false ? (
        <button
          disabled
          title="Run 'agenfk jira setup' to configure JIRA integration"
          aria-label="JIRA not configured"
          data-testid="jira-unconfigured"
          className="flex items-center gap-1.5 px-2 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-xs font-medium text-slate-400 cursor-not-allowed"
        >
          <Link size={12} />
          <span>JIRA</span>
        </button>
      ) : (
        <button
          onClick={handleConnect}
          data-testid="jira-connect"
          title="Connect JIRA"
          aria-label="Connect JIRA"
          className="flex items-center gap-1.5 px-2 py-1 bg-slate-100 dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 border border-slate-200 dark:border-slate-700 hover:border-indigo-300 rounded-md text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-indigo-600 transition-colors"
        >
          <Link size={12} />
          <span>Connect JIRA</span>
        </button>
      )}
    </>
  );
};
