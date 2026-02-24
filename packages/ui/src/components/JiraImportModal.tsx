import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Loader2, AlertCircle, Search, X, ArrowLeft, Download } from 'lucide-react';
import { clsx } from 'clsx';

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: string;
}

type Step = 'projects' | 'issues' | 'confirm';

const AGENFK_TYPE_MAP: Record<string, string> = {
  Epic: 'EPIC',
  Story: 'STORY',
  Bug: 'BUG',
  Task: 'TASK',
  Subtask: 'TASK',
  'Sub-task': 'TASK',
};

const mapToAgenFKType = (issueType: string): string =>
  AGENFK_TYPE_MAP[issueType] ?? 'TASK';

const TYPE_COLORS: Record<string, string> = {
  EPIC: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  STORY: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  TASK: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  BUG: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

export const JiraImportModal: React.FC<Props> = ({ open, onClose, projectId }) => {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('projects');
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const [selectedProjectName, setSelectedProjectName] = useState<string>('');
  const [selectedIssueKeys, setSelectedIssueKeys] = useState<Set<string>>(new Set());
  const [projectSearch, setProjectSearch] = useState('');
  const [issueSearch, setIssueSearch] = useState('');
  const [statusCategories, setStatusCategories] = useState<Set<string>>(new Set(['To Do', 'In Progress']));
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);

  const { data: projects, isLoading: loadingProjects, error: projectsError, refetch: refetchProjects } = useQuery({
    queryKey: ['jiraProjects'],
    queryFn: api.listJiraProjects,
    enabled: open && step === 'projects',
    staleTime: 60_000,
  });

  const { data: issues, isLoading: loadingIssues, isFetching: fetchingIssues, error: issuesError, refetch: refetchIssues } = useQuery({
    queryKey: ['jiraIssues', selectedProjectKey, issueSearch, Array.from(statusCategories).sort().join(',')],
    queryFn: () => api.listJiraIssues(selectedProjectKey!, { 
      summary: issueSearch || undefined,
      statusCategory: statusCategories.size > 0 ? Array.from(statusCategories).join(',') : undefined
    }),
    enabled: open && step === 'issues' && !!selectedProjectKey,
    staleTime: 30_000,
  });

  const importMutation = useMutation({
    mutationFn: () => api.importJiraIssues(projectId, Array.from(selectedIssueKeys)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      setImportSuccess(true);
      setTimeout(() => {
        handleClose();
      }, 1500);
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Import failed. Please try again.';
      setImportError(msg);
    },
  });

  const handleClose = () => {
    setStep('projects');
    setSelectedProjectKey(null);
    setSelectedProjectName('');
    setSelectedIssueKeys(new Set());
    setProjectSearch('');
    setImportError(null);
    setImportSuccess(false);
    onClose();
  };

  const handleSelectProject = (key: string, name: string) => {
    setSelectedProjectKey(key);
    setSelectedProjectName(name);
    setSelectedIssueKeys(new Set());
    setIssueSearch('');
    setStatusCategories(new Set(['To Do', 'In Progress']));
    setStep('issues');
  };

  const toggleStatusCategory = (cat: string) => {
    setStatusCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const toggleIssue = (key: string) => {
    setSelectedIssueKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (!issues) return;
    if (selectedIssueKeys.size === issues.length) {
      setSelectedIssueKeys(new Set());
    } else {
      setSelectedIssueKeys(new Set(issues.map(i => i.key)));
    }
  };

  const filteredProjects = projects?.filter(p =>
    p.name.toLowerCase().includes(projectSearch.toLowerCase()) ||
    p.key.toLowerCase().includes(projectSearch.toLowerCase())
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" data-testid="jira-import-modal">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            {step !== 'projects' && (
              <button
                onClick={() => setStep(step === 'confirm' ? 'issues' : 'projects')}
                className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400"
                aria-label="Go back"
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <h2 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">
              {step === 'projects' && 'Import from JIRA — Select Project'}
              {step === 'issues' && `Import from JIRA — ${selectedProjectName}`}
              {step === 'confirm' && 'Import from JIRA — Confirm'}
            </h2>
          </div>
          <button onClick={handleClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">

          {/* Step 1: Project Selection */}
          {step === 'projects' && (
            <div className="space-y-3">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search projects..."
                  value={projectSearch}
                  onChange={e => setProjectSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:text-slate-200"
                />
              </div>
              {loadingProjects && (
                <div className="flex justify-center py-8" data-testid="projects-loading">
                  <Loader2 className="animate-spin text-slate-400" size={24} />
                </div>
              )}
              {projectsError && (
                <div className="flex flex-col items-center gap-3 py-6 text-center" data-testid="projects-error">
                  <AlertCircle className="text-red-400" size={24} />
                  <p className="text-sm text-slate-500 dark:text-slate-400">Failed to load JIRA projects.</p>
                  <button onClick={() => refetchProjects()} className="text-xs text-indigo-500 hover:underline">Retry</button>
                </div>
              )}
              {filteredProjects && (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden" data-testid="project-list">
                  {filteredProjects.length === 0 && (
                    <li className="px-4 py-3 text-sm text-slate-400 italic">No projects found.</li>
                  )}
                  {filteredProjects.map(p => (
                    <li key={p.key}>
                      <button
                        onClick={() => handleSelectProject(p.key, p.name)}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors text-left"
                        data-testid={`project-item-${p.key}`}
                      >
                        <span className="font-mono text-xs text-slate-400 w-16 shrink-0">{p.key}</span>
                        <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{p.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Step 2: Issue Selection */}
          {step === 'issues' && (
            <div className="space-y-4">
              <div className="space-y-3">
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search by summary..."
                    value={issueSearch}
                    onChange={e => setIssueSearch(e.target.value)}
                    className="w-full pl-8 pr-3 py-2 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:text-slate-200"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {['To Do', 'In Progress', 'Done'].map(cat => (
                      <button
                        key={cat}
                        onClick={() => toggleStatusCategory(cat)}
                        className={clsx(
                          'text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-full border transition-all',
                          statusCategories.has(cat)
                            ? 'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-300 dark:border-indigo-800'
                            : 'bg-slate-50 text-slate-400 border-slate-200 dark:bg-slate-800 dark:text-slate-500 dark:border-slate-700'
                        )}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                  {fetchingIssues && (
                    <Loader2 className="animate-spin text-indigo-500" size={14} />
                  )}
                </div>
              </div>

              {loadingIssues && (
                <div className="flex justify-center py-8" data-testid="issues-loading">
                  <Loader2 className="animate-spin text-slate-400" size={24} />
                </div>
              )}
              {issuesError && (
                <div className="flex flex-col items-center gap-3 py-6 text-center" data-testid="issues-error">
                  <AlertCircle className="text-red-400" size={24} />
                  <p className="text-sm text-slate-500 dark:text-slate-400">Failed to load issues.</p>
                  <button onClick={() => refetchIssues()} className="text-xs text-indigo-500 hover:underline">Retry</button>
                </div>
              )}
              {issues && (
                <>
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={selectedIssueKeys.size === issues.length && issues.length > 0}
                        onChange={toggleAll}
                        className="rounded"
                        data-testid="select-all-issues"
                      />
                      Select all ({issues.length})
                    </label>
                    {selectedIssueKeys.size > 0 && (
                      <span className="text-xs font-medium text-indigo-600 dark:text-indigo-400">
                        {selectedIssueKeys.size} selected
                      </span>
                    )}
                  </div>
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden" data-testid="issue-list">
                    {issues.length === 0 && (
                      <li className="px-4 py-3 text-sm text-slate-400 italic">No issues found.</li>
                    )}
                    {issues.map(issue => {
                      const afkType = mapToAgenFKType(issue.issueType);
                      return (
                        <li key={issue.key}>
                          <label className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer" data-testid={`issue-item-${issue.key}`}>
                            <input
                              type="checkbox"
                              checked={selectedIssueKeys.has(issue.key)}
                              onChange={() => toggleIssue(issue.key)}
                              className="rounded shrink-0"
                            />
                            <span className="font-mono text-xs text-slate-400 w-20 shrink-0">{issue.key}</span>
                            <span className="flex-1 text-sm text-slate-700 dark:text-slate-200 truncate">{issue.summary}</span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">{issue.statusCategory || issue.status}</span>
                              <span className="text-xs text-slate-300 dark:text-slate-600">→</span>
                              <span className={clsx('text-xs font-medium px-1.5 py-0.5 rounded', TYPE_COLORS[afkType])} data-testid={`type-badge-${issue.key}`}>
                                {afkType}
                              </span>
                            </div>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          )}

          {/* Step 3: Confirm */}
          {step === 'confirm' && (
            <div className="space-y-4">
              <p className="text-sm text-slate-600 dark:text-slate-300" data-testid="confirm-summary">
                You are about to import <strong>{selectedIssueKeys.size}</strong> issue{selectedIssueKeys.size !== 1 ? 's' : ''} from <strong>{selectedProjectName}</strong> into the current AgenFK project.
              </p>
              <ul className="text-xs text-slate-500 dark:text-slate-400 space-y-1 max-h-40 overflow-y-auto">
                {Array.from(selectedIssueKeys).map(key => (
                  <li key={key} className="font-mono">{key}</li>
                ))}
              </ul>
              {importError && (
                <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2" data-testid="import-error">
                  <AlertCircle size={14} />
                  <span>{importError}</span>
                </div>
              )}
              {importSuccess && (
                <div className="text-sm text-emerald-600 dark:text-emerald-400 text-center font-medium py-2" data-testid="import-success">
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
              disabled={selectedIssueKeys.size === 0}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-md font-medium text-sm flex items-center gap-2 transition-colors"
              data-testid="next-to-confirm"
            >
              Next ({selectedIssueKeys.size} selected)
            </button>
          )}
          {step === 'confirm' && (
            <button
              onClick={() => importMutation.mutate()}
              disabled={importMutation.isPending || importSuccess}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-md font-medium text-sm flex items-center gap-2 transition-colors"
              data-testid="confirm-import"
            >
              {importMutation.isPending ? (
                <><Loader2 size={14} className="animate-spin" /> Importing...</>
              ) : (
                <><Download size={14} /> Import {selectedIssueKeys.size} item{selectedIssueKeys.size !== 1 ? 's' : ''}</>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
