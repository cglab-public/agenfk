import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Flow, FlowStep } from '../types';
import { X, Plus, Trash2, GripVertical, Save, GitBranch, Check } from 'lucide-react';
import { clsx } from 'clsx';

const BUILTIN_ID = '__builtin__';

interface FlowEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  activeFlowId?: string;   // currently active flow id (undefined = default/builtin flow)
  initialFlowId?: string;  // pre-select this flow on open
}

// Keep legacy Props alias so KanbanBoard can pass open= until it's updated
interface LegacyProps {
  open: boolean;
  onClose: () => void;
  flow?: Flow | null;
  projectId: string;
}

type Props = FlowEditorModalProps | LegacyProps;

function isLegacyProps(p: Props): p is LegacyProps {
  return 'open' in p;
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

// ── Inner editor component (right panel) ──────────────────────────────────────

interface EditorPanelProps {
  flow: Flow | null;             // null = new flow
  isReadOnly: boolean;
  projectId: string;
  activeFlowId: string | undefined;
  onSaved: (flow: Flow) => void;
  onClose: () => void;
}

const EditorPanel: React.FC<EditorPanelProps> = ({
  flow,
  isReadOnly,
  projectId,
  activeFlowId,
  onSaved,
  onClose,
}) => {
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<FlowStep[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (flow) {
      setName(flow.name);
      setDescription(flow.description ?? '');
      setSteps([...flow.steps].sort((a, b) => a.order - b.order));
    } else {
      setName('');
      setDescription('');
      setSteps([makeBlankStep(0)]);
    }
    setSaved(false);
  }, [flow]);

  // ── Drag-to-reorder (native HTML5 DnD) ──────────────────────────────────────
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

  // ── Step helpers ─────────────────────────────────────────────────────────────
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

  // ── Mutations ────────────────────────────────────────────────────────────────
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
    onSuccess: (savedFlow) => {
      queryClient.invalidateQueries({ queryKey: ['flows'] });
      queryClient.invalidateQueries({ queryKey: ['flow', projectId] });
      setSaved(true);
      onSaved(savedFlow);
    },
  });

  const useFlowMutation = useMutation({
    mutationFn: async () => {
      if (flow?.id) {
        await api.setProjectFlow(projectId, flow.id);
        return flow;
      }
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
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['flows'] });
      queryClient.invalidateQueries({ queryKey: ['flow', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setSaved(true);
      onSaved(result);
    },
  });

  const isBusy = saveMutation.isPending || useFlowMutation.isPending;
  const errorMsg =
    (saveMutation.error as Error | null)?.message ??
    (useFlowMutation.error as Error | null)?.message ??
    null;

  const isActive = flow?.id !== undefined && flow.id === activeFlowId;

  return (
    <div className="flex flex-col h-full" data-testid="editor-panel">
      {/* Right panel header */}
      <div className="px-6 pt-6 pb-4 shrink-0">
        <div className="flex items-center gap-2 mb-1">
          {isReadOnly ? (
            <span className="text-xs font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400">
              Default (read-only)
            </span>
          ) : flow ? (
            <>
              {isActive && (
                <span
                  data-testid="active-badge"
                  className="text-xs font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300"
                >
                  Active
                </span>
              )}
            </>
          ) : null}
        </div>
        <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">
          {isReadOnly ? 'Default Flow' : flow ? flow.name || 'Untitled Flow' : 'New Flow'}
        </h3>
      </div>

      {/* Scrollable form body */}
      <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-5">
        {/* Name */}
        <div>
          <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1 uppercase tracking-wide">
            Flow Name <span className="text-red-500">*</span>
          </label>
          <input
            data-testid="flow-name-input"
            type="text"
            value={name}
            onChange={e => { setName(e.target.value); setSaved(false); }}
            placeholder="e.g. Engineering Sprint Flow"
            disabled={isReadOnly}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed"
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
            onChange={e => { setDescription(e.target.value); setSaved(false); }}
            rows={2}
            placeholder="Optional description of this flow"
            disabled={isReadOnly}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none disabled:opacity-60 disabled:cursor-not-allowed"
          />
        </div>

        {/* Steps */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Steps
            </label>
            {!isReadOnly && (
              <button
                data-testid="add-step-btn"
                type="button"
                onClick={addStep}
                className="flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors"
              >
                <Plus size={14} />
                Add Step
              </button>
            )}
          </div>

          <div className="space-y-2" data-testid="steps-list">
            {steps.map((step, index) => (
              <div
                key={step.id}
                data-testid={`step-row-${index}`}
                draggable={!isReadOnly}
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
                          disabled={isReadOnly}
                          className="w-full px-2 py-1 rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60"
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
                          disabled={isReadOnly}
                          className="w-full px-2 py-1 rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60"
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
                        disabled={isReadOnly}
                        className="w-full px-2 py-1 rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none disabled:opacity-60"
                      />
                    </div>

                    {/* Is Special */}
                    <label className="flex items-center gap-2 cursor-pointer w-fit">
                      <input
                        data-testid={`step-is-special-${index}`}
                        type="checkbox"
                        checked={!!step.isSpecial}
                        onChange={e => updateStep(index, { isSpecial: e.target.checked })}
                        disabled={isReadOnly}
                        className="w-3.5 h-3.5 rounded accent-indigo-600 disabled:opacity-60"
                      />
                      <span className="text-xs text-slate-600 dark:text-slate-400 select-none">
                        Special (terminal / non-active)
                      </span>
                    </label>
                  </div>

                  {/* Delete step */}
                  {!isReadOnly && (
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
                  )}
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

      {/* Footer — sticky bottom */}
      {!isReadOnly && (
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 shrink-0 flex items-center justify-between gap-3">
          <button
            data-testid="save-flow-btn"
            type="button"
            disabled={isBusy || !name.trim()}
            onClick={() => saveMutation.mutate()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            {saved ? <Check size={15} /> : <Save size={15} />}
            {isBusy ? 'Saving…' : saved ? 'Saved' : 'Save'}
          </button>

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
        </div>
      )}
    </div>
  );
};

// ── Delete confirm inline ─────────────────────────────────────────────────────

interface DeleteConfirmProps {
  onConfirm: () => void;
  onCancel: () => void;
}

const DeleteConfirm: React.FC<DeleteConfirmProps> = ({ onConfirm, onCancel }) => (
  <span className="inline-flex items-center gap-1 text-xs" data-testid="delete-confirm">
    <span className="text-slate-600 dark:text-slate-300">Delete?</span>
    <button
      data-testid="delete-confirm-yes"
      onClick={e => { e.stopPropagation(); onConfirm(); }}
      className="px-1.5 py-0.5 rounded bg-red-600 text-white hover:bg-red-700 font-semibold"
    >
      Yes
    </button>
    <button
      data-testid="delete-confirm-no"
      onClick={e => { e.stopPropagation(); onCancel(); }}
      className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 font-semibold"
    >
      No
    </button>
  </span>
);

// ── Main modal ────────────────────────────────────────────────────────────────

export const FlowEditorModal: React.FC<Props> = (props) => {
  // Normalise legacy vs new props
  const isLegacy = isLegacyProps(props);
  const isOpen = isLegacy ? props.open : props.isOpen;
  const onClose = props.onClose;
  const projectId = props.projectId;
  const activeFlowId = isLegacy ? undefined : (props as FlowEditorModalProps).activeFlowId;
  const initialFlowId = isLegacy
    ? (props as LegacyProps).flow?.id ?? undefined
    : (props as FlowEditorModalProps).initialFlowId;

  const queryClient = useQueryClient();

  // ── Sidebar state ──────────────────────────────────────────────────────────
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(
    initialFlowId ?? null
  );
  const [isNewFlow, setIsNewFlow] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // ── Query: list all flows ──────────────────────────────────────────────────
  const { data: flows = [] } = useQuery<Flow[]>({
    queryKey: ['flows'],
    queryFn: () => api.listFlows(),
    enabled: isOpen,
  });

  // Derive selected flow object
  const selectedFlow = isNewFlow
    ? null
    : flows.find(f => f.id === selectedFlowId) ?? null;

  // If this is a legacy-props invocation the passed `flow` wins as initial selection
  useEffect(() => {
    if (!isOpen) return;
    if (isLegacy && (props as LegacyProps).flow?.id) {
      setSelectedFlowId((props as LegacyProps).flow!.id);
      setIsNewFlow(false);
    } else if (initialFlowId) {
      setSelectedFlowId(initialFlowId);
      setIsNewFlow(false);
    }
  }, [isOpen]);

  // ── Delete mutation ────────────────────────────────────────────────────────
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteFlow(id),
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['flows'] });
      queryClient.invalidateQueries({ queryKey: ['flow', projectId] });
      if (selectedFlowId === deletedId) {
        setSelectedFlowId(null);
        setIsNewFlow(true);
      }
      setConfirmDeleteId(null);
    },
  });

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleFlowSaved = (flow: Flow) => {
    setSelectedFlowId(flow.id);
    setIsNewFlow(false);
  };

  const effectiveActiveFlowId = activeFlowId;

  const isReadOnly = selectedFlowId === BUILTIN_ID;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      data-testid="flow-editor-modal"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[calc(100vw-2rem)] h-[90vh] flex flex-row overflow-hidden">

        {/* ── LEFT SIDEBAR ──────────────────────────────────────────────────── */}
        <div
          data-testid="flow-sidebar"
          className="w-64 shrink-0 border-r border-slate-200 dark:border-slate-700 flex flex-col overflow-hidden"
        >
          {/* Sidebar header */}
          <div className="px-4 pt-5 pb-3 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <GitBranch size={16} className="text-indigo-500" />
              <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                Flows
              </span>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          {/* Flow list */}
          <div className="flex-1 overflow-y-auto px-2 pb-2" data-testid="flow-list">
            {/* Built-in default flow row */}
            <button
              data-testid="flow-item-__builtin__"
              onClick={() => { setSelectedFlowId(BUILTIN_ID); setIsNewFlow(false); }}
              className={clsx(
                'w-full text-left px-3 py-2 rounded-lg mb-1 transition-colors group',
                selectedFlowId === BUILTIN_ID && !isNewFlow
                  ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-sm font-medium truncate flex-1">Default Flow</span>
                <span className="text-xs font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 shrink-0">
                  DEFAULT
                </span>
              </div>
            </button>

            {flows.map(flow => {
              const isActive = flow.id === effectiveActiveFlowId;
              const isSelected = selectedFlowId === flow.id && !isNewFlow;
              const isPendingDelete = confirmDeleteId === flow.id;

              return (
                <div
                  key={flow.id}
                  data-testid={`flow-item-${flow.id}`}
                  className={clsx(
                    'w-full text-left px-3 py-2 rounded-lg mb-1 transition-colors cursor-pointer',
                    isSelected
                      ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  )}
                  onClick={() => {
                    if (!isPendingDelete) {
                      setSelectedFlowId(flow.id);
                      setIsNewFlow(false);
                    }
                  }}
                >
                  <div className="flex items-center gap-1">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-medium truncate">{flow.name}</span>
                        {isActive && (
                          <span
                            data-testid={`flow-active-badge-${flow.id}`}
                            className="text-xs font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 shrink-0"
                          >
                            Active
                          </span>
                        )}
                      </div>
                      {isPendingDelete ? (
                        <DeleteConfirm
                          onConfirm={() => deleteMutation.mutate(flow.id)}
                          onCancel={() => setConfirmDeleteId(null)}
                        />
                      ) : (
                        <span className="text-xs text-slate-400 dark:text-slate-500">
                          {flow.steps.length} step{flow.steps.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    {/* Delete button */}
                    <button
                      data-testid={`delete-flow-btn-${flow.id}`}
                      disabled={isActive}
                      onClick={e => {
                        e.stopPropagation();
                        if (!isActive) setConfirmDeleteId(flow.id);
                      }}
                      title={isActive ? 'Cannot delete active flow' : 'Delete flow'}
                      className={clsx(
                        'shrink-0 p-1 rounded transition-colors',
                        isActive
                          ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
                          : 'text-slate-300 hover:text-red-500 dark:text-slate-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                      )}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* + New Flow button at bottom */}
          <div className="p-3 border-t border-slate-200 dark:border-slate-700 shrink-0">
            <button
              data-testid="new-flow-btn"
              onClick={() => {
                setIsNewFlow(true);
                setSelectedFlowId(null);
              }}
              className={clsx(
                'w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold transition-colors',
                isNewFlow
                  ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                  : 'text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20'
              )}
            >
              <Plus size={15} />
              New Flow
            </button>
          </div>
        </div>

        {/* ── RIGHT PANEL ───────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedFlowId !== null || isNewFlow ? (
            <EditorPanel
              key={isNewFlow ? '__new__' : selectedFlowId}
              flow={selectedFlow}
              isReadOnly={isReadOnly}
              projectId={projectId}
              activeFlowId={effectiveActiveFlowId}
              onSaved={handleFlowSaved}
              onClose={onClose}
            />
          ) : (
            <div className="flex flex-col items-center justify-center flex-1 text-slate-400 dark:text-slate-600 gap-3 p-8">
              <GitBranch size={40} className="opacity-30" />
              <p className="text-sm">Select a flow from the sidebar or create a new one.</p>
              <button
                onClick={() => setIsNewFlow(true)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white transition-colors shadow-sm"
              >
                <Plus size={14} />
                New Flow
              </button>
            </div>
          )}
        </div>

        {/* Legacy cancel button (only shown in test / backwards compat context) — hidden, keeps test-id accessible */}
        <button
          data-testid="cancel-btn"
          type="button"
          onClick={onClose}
          className="sr-only"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};
