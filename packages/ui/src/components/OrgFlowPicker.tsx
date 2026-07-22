import React from 'react';
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

export const OrgFlowPicker: React.FC<Props> = ({ open, onClose, projectId, activeFlowId }) => {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['orgAvailableFlows', projectId],
    queryFn: () => api.getOrgAvailableFlows(),
    enabled: open,
  });

  const selectMutation = useMutation({
    mutationFn: (flowId: string) => api.selectOrgFlow(projectId, flowId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projectFlow', projectId] });
      queryClient.invalidateQueries({ queryKey: ['flows'] });
      onClose();
    },
  });

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
        className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100">Org-available flows</h2>
          <button
            data-testid="org-flow-picker-close"
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

          {error && (
            <div className="flex items-center gap-2 text-red-600 text-sm">
              <AlertCircle size={16} /> Failed to load org-available flows.
            </div>
          )}

          {!isLoading && !error && !hubEnabled && (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Hub is not configured; no org-available flows.
            </p>
          )}

          {!isLoading && !error && hubEnabled && flows.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400">No org-available flows.</p>
          )}

          {!isLoading && !error && hubEnabled && flows.length > 0 && (
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
                          className="inline-flex items-center gap-1 text-[10px] font-bold uppercase text-indigo-600 bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-300 rounded-full px-1.5 py-0.5"
                        >
                          <Check size={10} /> Selected
                        </span>
                      )}
                    </div>
                    <button
                      data-testid={`select-org-flow-${flow.id}`}
                      disabled={isSelected || selectMutation.isPending}
                      onClick={() => selectMutation.mutate(flow.id)}
                      className="shrink-0 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold px-3 py-1.5 transition-all"
                    >
                      {isSelected ? 'Current' : 'Select'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};