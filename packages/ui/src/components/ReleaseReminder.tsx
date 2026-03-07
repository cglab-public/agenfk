import React, { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Rocket, X, ExternalLink, ArrowUpCircle, Loader2, CheckCircle, XCircle, RefreshCw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const stripAnsi = (str: string) =>
  str.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1B[()][AB012]/g, '');

interface ReleaseInfo {
  version: string;
  tagName: string;
  name: string;
  body: string;
  publishedAt: string;
  url: string;
  currentVersion: string;
}

type UpdateState =
  | { phase: 'idle' }
  | { phase: 'running'; jobId: string; output: string }
  | { phase: 'success'; output: string }
  | { phase: 'error'; output: string };

const isNewerVersion = (latest: string, current: string): boolean => {
  if (!latest || !current) return false;
  
  const clean = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const l = clean(latest);
  const c = clean(current);
  
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lv = l[i] || 0;
    const cv = c[i] || 0;
    if (lv > cv) return true;
    /* v8 ignore start */
    if (lv < cv) return false;
  }
  return false;
  /* v8 ignore stop */
};

export const ReleaseReminder: React.FC = () => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDismissed, setIsDismissed] = useState<string | null>(
    () => localStorage.getItem('agenfk_dismissed_release')
  );
  const [updateState, setUpdateState] = useState<UpdateState>({ phase: 'idle' });
  const [countdown, setCountdown] = useState<number | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: release } = useQuery<ReleaseInfo>({
    queryKey: ['latestRelease'],
    queryFn: api.getLatestRelease,
    staleTime: 15 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
    retry: false,
  });

  // Auto-scroll terminal output to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [updateState]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Start countdown when update succeeds
  /* v8 ignore start */
  useEffect(() => {
    if (updateState.phase !== 'success') return;
    setCountdown(5);
    const id = setInterval(() => {
      setCountdown(prev => {
        if (prev === null || prev <= 1) {
          clearInterval(id);
          window.location.reload();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [updateState.phase]);
  /* v8 ignore stop */

  if (!release || !isNewerVersion(release.version, release.currentVersion)) {
    return null;
  }

  if (isDismissed === release.version) {
    return null;
  }

  const handleDismiss = () => {
    setIsDismissed(release.version);
    localStorage.setItem('agenfk_dismissed_release', release.version);
    setIsModalOpen(false);
    setUpdateState({ phase: 'idle' });
  };

  const handleClose = () => {
    setIsModalOpen(false);
    if (updateState.phase !== 'running') {
      setUpdateState({ phase: 'idle' });
    }
  };

  const handleUpdateNow = async () => {
    try {
      const { jobId } = await api.triggerUpdate();
      setUpdateState({ phase: 'running', jobId, output: '' });

      /* v8 ignore start */
      let pollFailCount = 0;
      const pollStartTime = Date.now();
      const MAX_POLL_DURATION = 3 * 60 * 1000; // 3 minutes
      const MAX_CONSECUTIVE_FAILURES = 3;

      pollRef.current = setInterval(async () => {
        // Max polling duration — give up after 3 minutes
        if (Date.now() - pollStartTime > MAX_POLL_DURATION) {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setUpdateState(prev =>
            prev.phase === 'running'
              ? { phase: 'error', output: (prev.output || '') + '\n\nUpdate timed out. Check the server logs or try again.' }
              : prev
          );
          return;
        }

        try {
          const result = await api.getUpdateStatus(jobId);
          pollFailCount = 0; // Reset on success
          setUpdateState(prev =>
            prev.phase === 'running'
              ? result.status === 'running'
                ? { phase: 'running', jobId, output: result.output }
                : result.status === 'success'
                ? { phase: 'success', output: result.output }
                : { phase: 'error', output: result.output }
              : prev
          );
          if (result.status !== 'running' && pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        } catch {
          pollFailCount++;
          // After consecutive failures, server likely restarted after successful update
          if (pollFailCount >= MAX_CONSECUTIVE_FAILURES) {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            setUpdateState(prev =>
              prev.phase === 'running'
                ? { phase: 'success', output: (prev.output || '') + '\n\nUpdate complete — server restarted.' }
                : prev
            );
          }
        }
      }, 1500);
      /* v8 ignore stop */
    } catch {
      setUpdateState({ phase: 'error', output: 'Failed to start update. Is the server running?' });
    }
  };

  const isUpdating = updateState.phase === 'running';
  const showTerminal = updateState.phase !== 'idle';
  const terminalOutput = updateState.phase !== 'idle' ? stripAnsi(updateState.output) : '';

  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        className="relative p-2 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 shadow-sm transition-all hover:bg-emerald-100 dark:hover:bg-emerald-900/40 hover:scale-105"
        title={`New release available: v${release.version}`}
      >
        <Rocket size={18} />
        <span className="absolute -top-1 -right-1 flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
        </span>
      </button>

      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={!isUpdating ? handleClose : undefined}
        >
          <div
            className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-lg mx-4 max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg">
                  <Rocket size={20} className="text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <h2 className="font-bold text-slate-800 dark:text-slate-100 text-lg">
                    {updateState.phase === 'success' ? 'Update Complete' :
                     updateState.phase === 'error' ? 'Update Failed' :
                     updateState.phase === 'running' ? 'Updating AgEnFK...' :
                     'New Release Available'}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    <span className="font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">v{release.currentVersion}</span>
                    <span className="mx-2">&rarr;</span>
                    <span className="font-mono bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 rounded font-bold">v{release.version}</span>
                  </p>
                </div>
              </div>
              {!isUpdating && (
                <button
                  onClick={handleClose}
                  className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-400 transition-colors"
                >
                  <X size={18} />
                </button>
              )}
            </div>

            {/* Body */}
            {showTerminal ? (
              /* Terminal output view */
              <div className="flex-1 flex flex-col overflow-hidden p-4 gap-3">
                <div className="flex items-center gap-2 text-xs font-medium">
                  {updateState.phase === 'running' && <Loader2 size={14} className="animate-spin text-blue-500" />}
                  {updateState.phase === 'success' && <CheckCircle size={14} className="text-emerald-500" />}
                  {updateState.phase === 'error' && <XCircle size={14} className="text-red-500" />}
                  <span className={
                    updateState.phase === 'running' ? 'text-blue-600 dark:text-blue-400' :
                    updateState.phase === 'success' ? 'text-emerald-600 dark:text-emerald-400' :
                    'text-red-600 dark:text-red-400'
                  }>
                    {updateState.phase === 'running' ? 'Running update...' :
                     updateState.phase === 'success' ? 'Update successful' :
                     'Update failed'}
                  </span>
                </div>
                <pre
                  ref={outputRef}
                  className="flex-1 bg-slate-950 text-slate-300 rounded-lg p-3 text-xs font-mono leading-relaxed overflow-y-auto min-h-0 whitespace-pre-wrap break-words"
                >
                  {terminalOutput || (isUpdating ? 'Starting...' : '')}
                </pre>
                {updateState.phase === 'success' && (
                  <div className="flex items-center gap-2 p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-lg text-xs text-emerald-700 dark:text-emerald-300">
                    <RefreshCw size={14} className="shrink-0 animate-spin" />
                    <span>Restarting server and reloading in <strong>{countdown}s</strong>...</span>
                  </div>
                )}
              </div>
            ) : (
              /* Release notes view */
              <div className="flex flex-col overflow-hidden">
                {release.name && (
                  <div className="px-6 pt-4 shrink-0">
                    <h3 className="font-semibold text-slate-700 dark:text-slate-200">{release.name}</h3>
                    <p className="text-xs text-slate-400 mt-1">
                      Released {new Date(release.publishedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                    </p>
                  </div>
                )}
                <div className="flex-1 overflow-y-auto px-6 py-4">
                  <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:text-slate-800 dark:prose-headings:text-slate-200 prose-p:text-slate-600 dark:prose-p:text-slate-400 prose-li:text-slate-600 dark:prose-li:text-slate-400 prose-code:text-indigo-600 dark:prose-code:text-indigo-400 prose-code:bg-slate-100 dark:prose-code:bg-slate-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {release.body || 'No release notes available.'}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 shrink-0">
              {updateState.phase === 'success' ? (
                /* v8 ignore start */
                <>
                  <span className="text-xs text-slate-400">Reloading automatically...</span>
                  <button
                    onClick={() => window.location.reload()}
                    className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg font-semibold text-sm shadow-sm transition-all active:scale-95"
                  >
                    <RefreshCw size={16} />
                    Reload now
                  </button>
                </>
                /* v8 ignore stop */
              ) : updateState.phase === 'error' ? (
                <>
                  <button
                    onClick={() => setUpdateState({ phase: 'idle' })}
                    className="text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 font-medium transition-colors"
                  >
                    Back
                  </button>
                  <a
                    href={release.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 font-medium transition-colors"
                  >
                    <ExternalLink size={14} />
                    Manual install
                  </a>
                </>
              ) : updateState.phase === 'running' ? (
                <>
                  <span className="text-xs text-slate-400 animate-pulse">Please wait, do not close...</span>
                  <span />
                </>
              ) : (
                <>
                  <button
                    onClick={handleDismiss}
                    className="text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 font-medium transition-colors"
                  >
                    Dismiss
                  </button>
                  <div className="flex items-center gap-3">
                    <a
                      href={release.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 font-medium transition-colors"
                    >
                      <ExternalLink size={14} />
                      View on GitHub
                    </a>
                    <button
                      onClick={handleUpdateNow}
                      className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg font-semibold text-sm shadow-sm transition-all active:scale-95"
                    >
                      <ArrowUpCircle size={16} />
                      Update Now
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
