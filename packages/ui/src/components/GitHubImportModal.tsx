import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Loader2, AlertCircle, Search, X, Download } from 'lucide-react';
import { clsx } from 'clsx';

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: string;
}

type Step = 'issues' | 'confirm';

const TYPE_OPTIONS = ['EPIC', 'STORY', 'TASK', 'BUG'] as const;

const TYPE_COLORS: Record<string, string> = {
  EPIC: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  STORY: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  TASK: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  BUG: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

export const GitHubImportModal: React.FC<Props> = ({ open, onClose, projectId }) => {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('issues');
  const [selectedIssues, setSelectedIssues] = useState<Map<number, string>>(new Map());
  const [issueSearch, setIssueSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<string>('open');
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    if (open) window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [open]);

  const { data: issues, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['githubIssues', projectId, stateFilter, issueSearch],
    queryFn: () => api.listGitHubIssues(projectId, {
      state: stateFilter,
      search: issueSearch || undefined,
    }),
    enabled: open && step === 'issues',
    staleTime: 30_000,
  });

  const importMutation = useMutation({
    mutationFn: () => {
      const items = Array.from(selectedIssues.entries()).map(([issueNumber, type]) => ({
        issueNumber,
        type,
      }));
      return api.importGitHubIssues(projectId, items);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      setImportSuccess(true);
      setTimeout(() => handleClose(), 1500);
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Import failed. Please try again.';
      setImportError(msg);
    },
  });

  const handleClose = () => {
    setStep('issues');
    setSelectedIssues(new Map());
    setIssueSearch('');
    setImportError(null);
    setImportSuccess(false);
    onClose();
  };

  const toggleIssue = (number: number) => {
    setSelectedIssues(prev => {
      const next = new Map(prev);
      if (next.has(number)) next.delete(number);
      else next.set(number, 'TASK');
      return next;
    });
  };

  const updateIssueType = (number: number, type: string) => {
    setSelectedIssues(prev => {
      const next = new Map(prev);
      if (next.has(number)) next.set(number, type);
      return next;
    });
  };

  const toggleAll = () => {
    if (!issues) return;
    if (selectedIssues.size === issues.length) {
      setSelectedIssues(new Map());
    } else {
      const next = new Map<number, string>();
      issues.forEach(i => next.set(i.number, selectedIssues.get(i.number) || 'TASK'));
      setSelectedIssues(next);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" data-testid="github-import-modal">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor" className="text-slate-700 dark:text-slate-300">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <h2 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">
              {step === 'issues' ? 'Import from GitHub' : 'Confirm Import'}
            </h2>
          </div>
          <button onClick={handleClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {/* Step 1: Issue Selection */}
          {step === 'issues' && (
            <div className="space-y-4">
              <div className="space-y-3">
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search issues..."
                    value={issueSearch}
                    onChange={e => setIssueSearch(e.target.value)}
                    className="w-full pl-8 pr-3 py-2 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:text-slate-200"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {['open', 'closed', 'all'].map(s => (
                      <button
                        key={s}
                        onClick={() => setStateFilter(s)}
                        className={clsx(
                          'text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-full border transition-all',
                          stateFilter === s
                            ? 'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-300 dark:border-indigo-800'
                            : 'bg-slate-50 text-slate-400 border-slate-200 dark:bg-slate-800 dark:text-slate-500 dark:border-slate-700'
                        )}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  {isFetching && <Loader2 className="animate-spin text-indigo-500" size={14} />}
                </div>
              </div>

              {isLoading && (
                <div className="flex justify-center py-8">
                  <Loader2 className="animate-spin text-slate-400" size={24} />
                </div>
              )}
              {error && (
                <div className="flex flex-col items-center gap-3 py-6 text-center">
                  <AlertCircle className="text-red-400" size={24} />
                  <p className="text-sm text-slate-500 dark:text-slate-400">Failed to load GitHub issues.</p>
                  <button onClick={() => refetch()} className="text-xs text-indigo-500 hover:underline">Retry</button>
                </div>
              )}
              {issues && (
                <>
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={selectedIssues.size === issues.length && issues.length > 0}
                        onChange={toggleAll}
                        className="rounded"
                      />
                      Select all ({issues.length})
                    </label>
                    {selectedIssues.size > 0 && (
                      <span className="text-xs font-medium text-indigo-600 dark:text-indigo-400">
                        {selectedIssues.size} selected
                      </span>
                    )}
                  </div>
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
                    {issues.length === 0 && (
                      <li className="px-4 py-3 text-sm text-slate-400 italic">No issues found.</li>
                    )}
                    {issues.map(issue => {
                      const currentType = selectedIssues.get(issue.number) || 'TASK';
                      return (
                        <li key={issue.number}>
                          <div className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800">
                            <input
                              type="checkbox"
                              checked={selectedIssues.has(issue.number)}
                              onChange={() => toggleIssue(issue.number)}
                              className="rounded shrink-0"
                            />
                            <span className="font-mono text-xs text-slate-400 w-12 shrink-0">#{issue.number}</span>
                            <span className="flex-1 text-sm text-slate-700 dark:text-slate-200 truncate">{issue.title}</span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">{issue.state}</span>
                              <span className="text-xs text-slate-300 dark:text-slate-600">&rarr;</span>
                              <select
                                value={currentType}
                                onChange={(e) => updateIssueType(issue.number, e.target.value)}
                                className={clsx(
                                  'text-[10px] font-bold px-1.5 py-0.5 rounded border border-transparent focus:border-indigo-500 focus:ring-0 bg-transparent cursor-pointer appearance-none text-center min-w-[60px]',
                                  TYPE_COLORS[currentType]
                                )}
                              >
                                {TYPE_OPTIONS.map(t => (
                                  <option key={t} value={t} className="bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 font-sans text-xs">
                                    {t}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          )}

          {/* Step 2: Confirm */}
          {step === 'confirm' && (
            <div className="space-y-4">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                You are about to import <strong>{selectedIssues.size}</strong> issue{selectedIssues.size !== 1 ? 's' : ''} from GitHub into the current AgEnFK project.
              </p>
              <ul className="text-xs text-slate-500 dark:text-slate-400 space-y-2 max-h-40 overflow-y-auto pr-2">
                {Array.from(selectedIssues.entries()).map(([num, type]) => {
                  const issue = issues?.find(i => i.number === num);
                  return (
                    <li key={num} className="flex items-center justify-between font-mono bg-slate-50 dark:bg-slate-800/50 px-2 py-1 rounded">
                      <span>#{num} {issue?.title ? `— ${issue.title}` : ''}</span>
                      <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded', TYPE_COLORS[type])}>
                        {type}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {importError && (
                <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
                  <AlertCircle size={14} />
                  <span>{importError}</span>
                </div>
              )}
              {importSuccess && (
                <div className="text-sm text-emerald-600 dark:text-emerald-400 text-center font-medium py-2">
                  Import complete!
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <button onClick={handleClose} className="text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
            Cancel
          </button>
          {step === 'issues' && (
            <button
              onClick={() => setStep('confirm')}
              disabled={selectedIssues.size === 0}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-md font-medium text-sm flex items-center gap-2 transition-colors"
            >
              Next ({selectedIssues.size} selected)
            </button>
          )}
          {step === 'confirm' && (
            <button
              onClick={() => importMutation.mutate()}
              disabled={importMutation.isPending || importSuccess}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-md font-medium text-sm flex items-center gap-2 transition-colors"
            >
              {importMutation.isPending ? (
                <><Loader2 size={14} className="animate-spin" /> Importing...</>
              ) : (
                <><Download size={14} /> Import {selectedIssues.size} item{selectedIssues.size !== 1 ? 's' : ''}</>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
