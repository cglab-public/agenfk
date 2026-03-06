import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Flow, FlowStep } from '../types';
import { X, Plus, Trash2, GripVertical, Save, GitBranch } from 'lucide-react';
import { clsx } from 'clsx';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Existing flow to edit. Omit (or pass null) for create mode. */
  flow?: Flow | null;
  /** The current project ID — needed for setProjectFlow and createFlow. */
  projectId: string;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function makeBlankStep(order: number): FlowStep {
  return {
    id: generateId(),
    name: '',
    label: '',
    order,
    exitCriteria: '',
    isSpecial: false,
  };
}

export const FlowEditorModal: React.FC<Props> = ({ open, onClose, flow, projectId }) => {
  const queryClient = useQueryClient();

  // ── Form state ─────────────────────────────────────────────────────────────
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<FlowStep[]>([]);

  // Seed form whenever the modal opens or the incoming flow changes
  useEffect(() => {
    if (!open) return;
    if (flow) {
      setName(flow.name);
      setDescription(flow.description ?? '');
      setSteps([...flow.steps].sort((a, b) => a.order - b.order));
    } else {
      setName('');
      setDescription('');
      setSteps([makeBlankStep(0)]);
    }
  }, [open, flow]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (open) window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // ── Drag-to-reorder (native HTML5 DnD) ────────────────────────────────────
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleDragStart = useCallback((index: number) => {
    dragIndexRef.current = index;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    const dragIndex = dragIndexRef.current;
    if (dragIndex === null || dragIndex === dropIndex) {
      setDragOverIndex(null);
      dragIndexRef.current = null;
      return;
    }
    setSteps(prev => {
      const next = [...prev];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(dropIndex, 0, moved);
      return next.map((s, i) => ({ ...s, order: i }));
    });
    setDragOverIndex(null);
    dragIndexRef.current = null;
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragOverIndex(null);
    dragIndexRef.current = null;
  }, []);

  // ── Step field helpers ─────────────────────────────────────────────────────
  const updateStep = useCallback((index: number, patch: Partial<FlowStep>) => {
    setSteps(prev => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }, []);

  const addStep = useCallback(() => {
    setSteps(prev => [...prev, makeBlankStep(prev.length)]);
  }, []);

  const removeStep = useCallback((index: number) => {
    setSteps(prev => {
      const next = prev.filter((_, i) => i !== index);
      return next.map((s, i) => ({ ...s, order: i }));
    });
  }, []);

  // ── Mutations ──────────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload: Partial<Flow> = {
        name,
        description,
        projectId,
        steps: steps.map((s, i) => ({ ...s, order: i })),
      };
      if (flow?.id) {
        return api.updateFlow(flow.id, payload);
      }
      return api.createFlow(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flows'] });
      queryClient.invalidateQueries({ queryKey: ['flow', projectId] });
      onClose();
    },
  });

  const useFlowMutation = useMutation({
    mutationFn: async () => {
      // If we have an existing flow, set it; otherwise save first then set
      if (flow?.id) {
        await api.setProjectFlow(projectId, flow.id);
        return flow;
      }
      // Create flow first
      const payload: Partial<Flow> = {
        name,
        description,
        projectId,
        steps: steps.map((s, i) => ({ ...s, order: i })),
      };
      const created = await api.createFlow(payload);
      await api.setProjectFlow(projectId, created.id);
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flows'] });
      queryClient.invalidateQueries({ queryKey: ['flow', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onClose();
    },
  });

  if (!open) return null;

  const isBusy = saveMutation.isPending || useFlowMutation.isPending;
  const errorMsg =
    (saveMutation.error as Error | null)?.message ??
    (useFlowMutation.error as Error | null)?.message ??
    null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      data-testid="flow-editor-modal"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700 shrink-0">
          <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
            <GitBranch size={20} className="text-indigo-500" />
            {flow ? 'Edit Flow' : 'New Flow'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {/* Name */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1 uppercase tracking-wide">
              Flow Name <span className="text-red-500">*</span>
            </label>
            <input
              data-testid="flow-name-input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Engineering Sprint Flow"
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1 uppercase tracking-wide">
              Description
            </label>
            <textarea
              data-testid="flow-description-input"
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              placeholder="Optional description of this flow"
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            />
          </div>

          {/* Steps */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Steps
              </label>
              <button
                data-testid="add-step-btn"
                type="button"
                onClick={addStep}
                className="flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors"
              >
                <Plus size={14} />
                Add Step
              </button>
            </div>

            <div className="space-y-2" data-testid="steps-list">
              {steps.map((step, index) => (
                <div
                  key={step.id}
                  data-testid={`step-row-${index}`}
                  draggable
                  onDragStart={() => handleDragStart(index)}
                  onDragOver={e => handleDragOver(e, index)}
                  onDrop={e => handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                  className={clsx(
                    'rounded-xl border p-3 bg-slate-50 dark:bg-slate-800/50 transition-all',
                    dragOverIndex === index
                      ? 'border-indigo-400 shadow-md'
                      : 'border-slate-200 dark:border-slate-700'
                  )}
                >
                  <div className="flex items-start gap-2">
                    {/* Drag handle */}
                    <div
                      className="cursor-grab active:cursor-grabbing mt-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 shrink-0"
                      title="Drag to reorder"
                    >
                      <GripVertical size={16} />
                    </div>

                    <div className="flex-1 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        {/* Name */}
                        <div>
                          <label className="block text-xs text-slate-400 dark:text-slate-500 mb-0.5">
                            Name (key)
                          </label>
                          <input
                            data-testid={`step-name-${index}`}
                            type="text"
                            value={step.name}
                            onChange={e => updateStep(index, { name: e.target.value })}
                            placeholder="e.g. in_progress"
                            className="w-full px-2 py-1 rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                        {/* Label */}
                        <div>
                          <label className="block text-xs text-slate-400 dark:text-slate-500 mb-0.5">
                            Label (display)
                          </label>
                          <input
                            data-testid={`step-label-${index}`}
                            type="text"
                            value={step.label}
                            onChange={e => updateStep(index, { label: e.target.value })}
                            placeholder="e.g. In Progress"
                            className="w-full px-2 py-1 rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                      </div>

                      {/* Exit criteria */}
                      <div>
                        <label className="block text-xs text-slate-400 dark:text-slate-500 mb-0.5">
                          Exit Criteria
                        </label>
                        <textarea
                          data-testid={`step-exit-criteria-${index}`}
                          value={step.exitCriteria ?? ''}
                          onChange={e => updateStep(index, { exitCriteria: e.target.value })}
                          rows={2}
                          placeholder="What must be true before leaving this step?"
                          className="w-full px-2 py-1 rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
                        />
                      </div>

                      {/* Is Special */}
                      <label className="flex items-center gap-2 cursor-pointer w-fit">
                        <input
                          data-testid={`step-is-special-${index}`}
                          type="checkbox"
                          checked={!!step.isSpecial}
                          onChange={e => updateStep(index, { isSpecial: e.target.checked })}
                          className="w-3.5 h-3.5 rounded accent-indigo-600"
                        />
                        <span className="text-xs text-slate-600 dark:text-slate-400 select-none">
                          Special (terminal / non-active)
                        </span>
                      </label>
                    </div>

                    {/* Delete step */}
                    <button
                      data-testid={`delete-step-${index}`}
                      type="button"
                      disabled={!!step.isSpecial}
                      onClick={() => removeStep(index)}
                      title={step.isSpecial ? 'Cannot delete special steps' : 'Remove step'}
                      className={clsx(
                        'mt-1 p-1 rounded-lg transition-colors shrink-0',
                        step.isSpecial
                          ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
                          : 'text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                      )}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Error */}
          {errorMsg && (
            <p data-testid="flow-editor-error" className="text-sm text-red-600 dark:text-red-400">
              {errorMsg}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 shrink-0 flex items-center justify-between gap-3">
          <button
            data-testid="use-flow-btn"
            type="button"
            disabled={isBusy || !name.trim()}
            onClick={() => useFlowMutation.mutate()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            <GitBranch size={15} />
            Use this Flow
          </button>

          <div className="flex items-center gap-2">
            <button
              data-testid="cancel-btn"
              type="button"
              onClick={onClose}
              disabled={isBusy}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              data-testid="save-flow-btn"
              type="button"
              disabled={isBusy || !name.trim()}
              onClick={() => saveMutation.mutate()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              <Save size={15} />
              {isBusy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
