import React, { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Loader2, AlertCircle, X, Check, Star } from 'lucide-react';
import type { Flow } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: string;
  activeFlowId?: string;
}

const getErrorMessage = (error: unknown): string => {
  if (
    error &&
    typeof error === 'object' &&
    'response' in error &&
    error.response &&
    typeof error.response === 'object' &&
    'data' in error.response &&
    error.response.data &&
    typeof error.response.data === 'object' &&
    'error' in error.response.data &&
    typeof error.response.data.error === 'string'
  ) {
    return error.response.data.error;
  }
  return 'Failed to select flow.';
};

export const OrgFlowPicker: React.FC<Props> = ({ open, onClose, projectId, activeFlowId }) => {
  const queryClient = useQueryClient();

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['orgAvailableFlows', projectId],
    queryFn: () => api.getOrgAvailableFlows(),
    enabled: open,
  });

  const selectMutation = useMutation({
    mutationFn: (flowId: string) => api.selectOrgFlow(projectId, flowId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flow', projectId] });
      onClose();
    },
    onError: () => {
      // Keep modal open; error banner is rendered from mutation state below.
    },
  });

  // FIX 4 — Escape-key handler (mirrors JiraImportModal pattern)
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (open) {
      window.addEventListener('keydown', handleEsc);
    }
    return () => {
      window.removeEventListener('keydown', handleEsc);
    };
  }, [open, onClose]);

  if (!open) return null;

  const flows: Flow[] = data?.flows ?? [];
  const hubEnabled = data?.hubEnabled !== false;
  const defaultFlowId = data?.defaultFlowId ?? null;

  return (
    <div
      data-testid="org-flow-picker"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Org-available flows"
        className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100">Org-available flows</h2>
          <button
            data-testid="org-flow-picker-close"
            aria-label="Close"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto">
          {isLoading && (
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          )}

          {loadError && (
            <div
              data-testid="org-flow-load-error"
              className="flex items-center gap-2 text-red-600 text-sm"
            >
              <AlertCircle size={16} />
              {(() => {
                const err = loadError as any;
                return err?.response?.data?.error || 'Failed to load org-available flows.';
              })()}
            </div>
          )}

          {!isLoading && !loadError && !hubEnabled && (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Hub is not configured; no org-available flows.
            </p>
          )}

          {!isLoading && !loadError && hubEnabled && flows.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400">No org-available flows.</p>
          )}

          {!isLoading && !loadError && hubEnabled && flows.length > 0 && (
            <>
              {selectMutation.error && (
                <div
                  data-testid="org-flow-select-error"
                  className="flex items-center gap-2 text-red-600 text-sm mb-3 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2"
                >
                  <AlertCircle size={16} />
                  {getErrorMessage(selectMutation.error)}
                </div>
              )}
              <ul className="flex flex-col gap-2">
                {flows.map((flow) => {
                  const isDefault = flow.id === defaultFlowId;
                  const isSelected = flow.id === activeFlowId;
                  return (
                    <li
                      key={flow.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
                          {flow.name}
                        </span>
                        {isDefault && (
                          <span
                            data-testid={`org-flow-default-${flow.id}`}
                            className="inline-flex items-center gap-1 text-[10px] font-bold uppercase text-amber-600 bg-amber-100 dark:bg-amber-900/30 dark:text-amber-300 rounded-full px-1.5 py-0.5"
                          >
                            <Star size={10} /> Default
                          </span>
                        )}
                        {isSelected && (
                          <span
                            data-testid={`org-flow-selected-${flow.id}`}
                            className="inline-flex items-center gap-1 text-[10px] font-bold uppercase text-accent-text bg-chip border border-border-brand rounded-full px-1.5 py-0.5"
                          >
                            <Check size={10} /> Selected
                          </span>
                        )}
                      </div>
                      <button
                        data-testid={`select-org-flow-${flow.id}`}
                        disabled={isSelected || selectMutation.isPending}
                        onClick={() => selectMutation.mutate(flow.id)}
                        className="shrink-0 rounded-lg bg-[image:var(--gradient-accent)] text-navy hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold px-3 py-1.5 transition-all shadow-glow"
                      >
                        {isSelected ? 'Current' : 'Select'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
};