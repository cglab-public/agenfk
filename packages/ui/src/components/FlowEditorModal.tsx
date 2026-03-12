import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import mermaid from 'mermaid';
import { api } from '../api';
import { Flow, FlowStep, RegistryFlow } from '../types';
import { useTheme } from '../ThemeContext';
import { X, Plus, Trash2, GripVertical, Save, GitBranch, Check, CopyPlus, Lock, Search, Globe, Loader2, AlertCircle, Download, Upload, ExternalLink, Zap, FlaskConical, ShieldCheck, Clock, BookOpen, Briefcase, Eye, Code, Bug, Star, Lightbulb, Pause, Archive } from 'lucide-react';

// Available icons for flow steps — key stored in FlowStep.icon, value rendered in UI
const STEP_ICON_OPTIONS: { key: string; label: string; node: React.ReactNode }[] = [
  { key: 'zap',       label: 'Zap',         node: <Zap size={14} /> },
  { key: 'plus',      label: 'Plus',        node: <Plus size={14} /> },
  { key: 'check',     label: 'Check',       node: <Check size={14} /> },
  { key: 'search',    label: 'Search',      node: <Search size={14} /> },
  { key: 'flask',     label: 'Test',        node: <FlaskConical size={14} /> },
  { key: 'shield',    label: 'Review',      node: <ShieldCheck size={14} /> },
  { key: 'eye',       label: 'Eye',         node: <Eye size={14} /> },
  { key: 'code',      label: 'Code',        node: <Code size={14} /> },
  { key: 'clock',     label: 'Clock',       node: <Clock size={14} /> },
  { key: 'book',      label: 'Book',        node: <BookOpen size={14} /> },
  { key: 'briefcase', label: 'Briefcase',   node: <Briefcase size={14} /> },
  { key: 'star',      label: 'Star',        node: <Star size={14} /> },
  { key: 'lightbulb', label: 'Lightbulb',   node: <Lightbulb size={14} /> },
  { key: 'bug',       label: 'Bug',         node: <Bug size={14} /> },
  { key: 'git',       label: 'Git Branch',  node: <GitBranch size={14} /> },
  { key: 'pause',     label: 'Pause',       node: <Pause size={14} /> },
  { key: 'archive',   label: 'Archive',     node: <Archive size={14} /> },
];

export function renderStepIcon(iconKey: string | undefined, fallback: React.ReactNode = <Zap size={14} />): React.ReactNode {
  if (!iconKey) return fallback;
  return STEP_ICON_OPTIONS.find(o => o.key === iconKey)?.node ?? fallback;
}
import { clsx } from 'clsx';

/**
 * Names that are reserved and cannot be used as custom step names.
 * TODO and DONE are anchor steps (always first/last in every flow).
 * The rest are platform-level statuses that exist outside flow definitions.
 */
const RESERVED_NAMES = new Set([
  'TODO', 'DONE', 'BLOCKED', 'PAUSED', 'IDEAS', 'ARCHIVED', 'TRASHED',
]);

const BUILTIN_ID = '__builtin__';

function generateUUID(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

function makeFreshAnchors(): [FlowStep, FlowStep] {
  return [
    { id: generateUUID(), name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
    { id: generateUUID(), name: 'DONE', label: 'Done', order: 0, exitCriteria: '', isAnchor: true },
  ];
}

function cloneFlow(source: Flow, newName: string): Omit<Flow, 'id' | 'createdAt' | 'updatedAt'> & { id?: undefined } {
  const [todo, done] = makeFreshAnchors();
  const middle = source.steps
    .filter(s => !s.isAnchor)
    .map((s, i) => ({ ...s, id: generateUUID(), order: i + 1 }));
  done.order = middle.length + 1;
  return {
    name: newName,
    description: source.description,
    steps: [todo, ...middle, done],
  };
}

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
  onClone?: () => void;
  onUseDefault?: () => void;    // only provided for the builtin default flow row
}

const EditorPanel: React.FC<EditorPanelProps> = ({
  flow,
  isReadOnly,
  projectId,
  activeFlowId,
  onSaved,
  onClose,
  onClone,
  onUseDefault,
}) => {
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<FlowStep[]>([]);
  const [saved, setSaved] = useState(false);
  const [openIconPickerIndex, setOpenIconPickerIndex] = useState<number | null>(null);

  useEffect(() => {
    if (flow) {
      setName(flow.name);
      setDescription(flow.description ?? '');
      // Filter out platform statuses — they are never part of flow definitions
      const flowSteps = [...flow.steps]
        .filter(s => {
          const upper = s.name.toUpperCase();
          return upper === 'TODO' || upper === 'DONE' || !RESERVED_NAMES.has(upper);
        })
        .sort((a, b) => a.order - b.order);
      setSteps(flowSteps);
    } else {
      setName('');
      setDescription('');
      const [todo, done] = makeFreshAnchors();
      const blank = makeBlankStep(1);
      done.order = 2;
      setSteps([todo, blank, done]);
    }
    setSaved(false);
  }, [flow]);

  // Validate: any non-anchor step name that matches a reserved name is invalid
  const reservedNameError = steps.some(s => {
    if (s.isAnchor) return false;
    const upper = s.name.toUpperCase();
    return RESERVED_NAMES.has(upper);
  });

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
  const isSaveDisabled = isBusy || !name.trim() || reservedNameError;

  const isActive = flow?.id !== undefined && flow.id === activeFlowId;

  // ── Publish to Community ─────────────────────────────────────────────────
  const [publishResult, setPublishResult] = useState<{ url: string; kind: 'pr' | 'existing' } | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  const publishMutation = useMutation({
    mutationFn: async () => {
      if (!flow?.id) throw new Error('Flow must be saved before publishing.');
      return api.publishToRegistry(flow.id);
    },
    onSuccess: (data) => {
      setPublishResult({ url: data.url, kind: data.kind ?? 'pr' });
      setPublishError(null);
    },
    onError: (e: Error) => {
      setPublishError(e.message || 'Failed to publish.');
    },
  });

  return (
    <div className="flex flex-col h-full" data-testid="editor-panel">
      {/* Right panel header — inline-editable flow name */}
      <div className="px-6 pt-5 pb-3 shrink-0">
        <div className="flex items-center gap-2 mb-1.5">
          {isReadOnly ? (
            <span className="text-xs font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400">
              Default (read-only)
            </span>
          ) : (
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
          )}
        </div>
        {isReadOnly ? (
          <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">Default Flow</h3>
        ) : (
          <input
            data-testid="flow-name-input"
            type="text"
            value={name}
            onChange={e => { setName(e.target.value); setSaved(false); }}
            placeholder="Flow name…"
            className="w-full text-xl font-bold text-slate-800 dark:text-slate-100 bg-transparent border-b-2 border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-indigo-500 dark:focus:border-indigo-400 focus:outline-none placeholder-slate-400 dark:placeholder-slate-600 transition-colors pb-0.5"
          />
        )}
      </div>

      {/* Scrollable form body */}
      <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-5 [&::-webkit-scrollbar]:hidden" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' } as React.CSSProperties}>

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

        {/* Version — read-only, auto-managed */}
        {flow?.version && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Version</span>
            <span
              data-testid="flow-version-badge"
              className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
            >
              v{flow.version}
            </span>
          </div>
        )}

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

          {/* Kanban-style: one column per step, horizontally scrollable */}
          <div className="flex flex-row gap-3 overflow-x-auto pb-2 [&::-webkit-scrollbar]:hidden" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' } as React.CSSProperties} data-testid="steps-columns">
            {steps.map((step, index) => {
              const isAnchor = !!step.isAnchor;
              const isTodoAnchor = isAnchor && step.name.toUpperCase() === 'TODO';
              const isDoneAnchor = isAnchor && step.name.toUpperCase() === 'DONE';
              const isStepLocked = isReadOnly || isAnchor;
              const stepNameUpper = step.name.toUpperCase();
              const hasReservedName = !isAnchor && RESERVED_NAMES.has(stepNameUpper);
              const stepColor = step.color ?? '#6366f1';
              const anchorColor = isDoneAnchor ? '#10b981' : '#94a3b8';

              return (
                <div
                  key={step.id}
                  data-testid={`step-row-${index}`}
                  draggable={!isStepLocked}
                  onDragStart={() => !isStepLocked && handleDragStart(index)}
                  onDragOver={e => !isStepLocked && handleDragOver(e, index)}
                  onDrop={e => !isStepLocked && handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                  style={isAnchor ? { borderTopColor: anchorColor, borderTopWidth: 3 } : { borderTopColor: stepColor, borderTopWidth: 3 }}
                  className={clsx(
                    'rounded-xl border flex flex-col shrink-0 w-52 transition-all',
                    isAnchor
                      ? 'bg-slate-100 dark:bg-slate-700/60 border-slate-300 dark:border-slate-600 opacity-80'
                      : dragOverIndex === index
                      ? 'bg-slate-50 dark:bg-slate-800/50 border-indigo-400 shadow-md'
                      : 'bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700'
                  )}
                >
                  {/* Column header */}
                  <div className="flex items-center gap-1.5 px-3 pt-3 pb-2">
                    {isAnchor ? (
                      <>
                        <div
                          data-testid={`step-anchor-lock-${index}`}
                          className="text-slate-400 dark:text-slate-500 shrink-0"
                          title="Anchor step — cannot be moved or deleted"
                        >
                          <Lock size={14} />
                        </div>
                        <div
                          data-testid={`step-color-swatch-${index}`}
                          className="w-4 h-4 rounded shrink-0 border border-white/30"
                          style={{ backgroundColor: anchorColor }}
                          title="Step color (fixed for anchor steps)"
                        />
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 truncate flex-1">
                          {step.label}
                        </span>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-600 text-slate-500 dark:text-slate-400 font-medium shrink-0">
                          anchor
                        </span>
                      </>
                    ) : (
                      <>
                        {/* Color picker */}
                        <input
                          data-testid={`step-color-${index}`}
                          type="color"
                          value={stepColor}
                          onChange={e => updateStep(index, { color: e.target.value })}
                          disabled={isReadOnly}
                          title="Pick step color"
                          className="w-5 h-5 rounded cursor-pointer border border-slate-300 dark:border-slate-600 p-0 bg-transparent shrink-0 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                        {/* Icon picker */}
                        <div className="relative shrink-0">
                          <button
                            data-testid={`step-icon-btn-${index}`}
                            type="button"
                            disabled={isReadOnly}
                            onClick={() => setOpenIconPickerIndex(openIconPickerIndex === index ? null : index)}
                            title="Pick step icon"
                            className="w-6 h-6 flex items-center justify-center rounded border border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {renderStepIcon(step.icon, <Zap size={12} />)}
                          </button>
                          {openIconPickerIndex === index && !isReadOnly && (
                            <div className="absolute top-7 left-0 z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg p-2 grid grid-cols-6 gap-1 w-44">
                              {STEP_ICON_OPTIONS.map(opt => (
                                <button
                                  key={opt.key}
                                  type="button"
                                  title={opt.label}
                                  onClick={() => { updateStep(index, { icon: opt.key }); setOpenIconPickerIndex(null); }}
                                  className={clsx(
                                    'w-6 h-6 flex items-center justify-center rounded transition-colors text-slate-600 dark:text-slate-300',
                                    step.icon === opt.key
                                      ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400'
                                      : 'hover:bg-slate-100 dark:hover:bg-slate-700'
                                  )}
                                >
                                  {opt.node}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        {/* Drag handle */}
                        <div
                          className={clsx(
                            'shrink-0',
                            isReadOnly
                              ? 'text-slate-300 dark:text-slate-600'
                              : 'cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
                          )}
                          title={isReadOnly ? undefined : 'Drag to reorder'}
                        >
                          <GripVertical size={16} />
                        </div>
                        {/* Delete button */}
                        {!isReadOnly && (
                          <button
                            data-testid={`delete-step-${index}`}
                            type="button"
                            onClick={() => removeStep(index)}
                            title="Remove step"
                            className="ml-auto p-1 rounded-lg transition-colors shrink-0 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </>
                    )}
                  </div>

                  {/* Column body */}
                  <div className="flex-1 space-y-2 px-3 pb-3">
                    {isAnchor && isTodoAnchor && (
                      <div>
                        <label className="block text-xs text-slate-400 dark:text-slate-500 mb-0.5">
                          Exit Criteria
                        </label>
                        <textarea
                          data-testid={`step-exit-criteria-${index}`}
                          value={step.exitCriteria ?? ''}
                          onChange={e => updateStep(index, { exitCriteria: e.target.value })}
                          rows={5}
                          placeholder="What must be true before leaving this step?"
                          disabled={isReadOnly}
                          className="w-full px-2 py-1 rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none disabled:opacity-60 min-h-[80px]"
                        />
                      </div>
                    )}
                    {!isAnchor && (
                      <>
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
                            disabled={isStepLocked}
                            className={clsx(
                              'w-full px-2 py-1 rounded-md border text-xs focus:outline-none focus:ring-1 disabled:opacity-60',
                              hasReservedName
                                ? 'border-red-400 focus:ring-red-400 bg-red-50 dark:bg-red-900/20 text-slate-800 dark:text-slate-100'
                                : 'border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 focus:ring-indigo-500'
                            )}
                          />
                          {hasReservedName && (
                            <p data-testid={`step-reserved-error-${index}`} className="text-xs text-red-600 dark:text-red-400 mt-0.5">
                              Reserved name
                            </p>
                          )}
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
                            disabled={isStepLocked}
                            className="w-full px-2 py-1 rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60"
                          />
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
                            rows={5}
                            placeholder="What must be true before leaving this step?"
                            disabled={isStepLocked}
                            className="w-full px-2 py-1 rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none disabled:opacity-60 min-h-[80px]"
                          />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {/* Reserved name global error */}
          {reservedNameError && (
            <p data-testid="reserved-name-error" className="text-sm text-red-600 dark:text-red-400 mt-1">
              One or more step names use a reserved name (TODO, DONE, BLOCKED, PAUSED, IDEAS, ARCHIVED, TRASHED).
            </p>
          )}
        </div>

        {/* Error */}
        {errorMsg && (
          <p data-testid="flow-editor-error" className="text-sm text-red-600 dark:text-red-400">
            {errorMsg}
          </p>
        )}
      </div>

      {/* Footer — sticky bottom */}
      {isReadOnly ? (
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 shrink-0 flex items-center gap-3 flex-wrap">
          {onUseDefault && (
            <button
              data-testid="use-default-flow-btn"
              type="button"
              onClick={onUseDefault}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors shadow-sm"
            >
              <GitBranch size={15} />
              Use this Flow
            </button>
          )}
          {onClone && (
            <button
              data-testid="clone-to-edit-btn"
              type="button"
              onClick={onClone}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white transition-colors shadow-sm"
            >
              <CopyPlus size={15} />
              Clone to Edit
            </button>
          )}
          <button
            data-testid="cancel-panel-btn"
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          >
            Close
          </button>
        </div>
      ) : (
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 shrink-0 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <button
              data-testid="save-flow-btn"
              type="button"
              disabled={isSaveDisabled}
              onClick={() => saveMutation.mutate()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              {saved ? <Check size={15} /> : <Save size={15} />}
              {isBusy ? 'Saving…' : saved ? 'Saved' : 'Save'}
            </button>

            <div className="flex items-center gap-2">
              {flow?.id && (
                <button
                  data-testid="publish-flow-btn"
                  type="button"
                  disabled={publishMutation.isPending}
                  onClick={() => { setPublishResult(null); setPublishError(null); publishMutation.mutate(); }}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold border border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {publishMutation.isPending ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
                  {publishMutation.isPending ? 'Publishing…' : 'Publish'}
                </button>
              )}
              <button
                data-testid="use-flow-btn"
                type="button"
                disabled={isSaveDisabled}
                onClick={() => useFlowMutation.mutate()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                <GitBranch size={15} />
                Use this Flow
              </button>
            </div>
          </div>

          {publishResult && (
            <a
              data-testid="publish-success-link"
              href={publishResult.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400 font-semibold hover:underline"
            >
              <ExternalLink size={12} />
              {publishResult.kind === 'pr' ? 'PR opened — view on GitHub' : 'Already published — view on registry'}
            </a>
          )}
          {publishError && (
            <p data-testid="publish-error" className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
              <AlertCircle size={11} />
              {publishError}
            </p>
          )}
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

// ── Mermaid diagram for flow steps ───────────────────────────────────────────

/* v8 ignore start */
const FlowMermaid: React.FC<{ steps: { name: string; label: string }[] }> = ({ steps }) => {
  const ref = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();

  useEffect(() => {
    if (!ref.current || steps.length === 0) return;
    const id = `mermaid-flow-${Math.random().toString(36).substring(2, 9)}`;
    const nodes = steps.map((s, i) => `  ${i}["${s.label || s.name}"]`).join('\n');
    const edges = steps.slice(1).map((_, i) => `  ${i} --> ${i + 1}`).join('\n');
    const chart = `flowchart LR\n${nodes}\n${edges}`;
    mermaid.initialize({ startOnLoad: false, theme: theme === 'dark' ? 'dark' : 'default', securityLevel: 'loose' });
    mermaid.render(id, chart).then(({ svg }) => {
      if (ref.current) ref.current.innerHTML = svg;
    }).catch(() => {});
  }, [steps, theme]);

  return <div ref={ref} data-testid="community-flow-diagram" className="overflow-x-auto py-2" />;
};
/* v8 ignore stop */

// ── Community preview panel (right panel for community flows) ─────────────────

interface CommunityPreviewPanelProps {
  flow: RegistryFlow;
  onInstalled: (flow: Flow) => void;
  onCloneToEdit: (flow: Flow) => void;
}

const CommunityPreviewPanel: React.FC<CommunityPreviewPanelProps> = ({
  flow,
  onInstalled,
  onCloneToEdit,
}) => {
  const actionRef = useRef<'install' | 'clone'>('install');

  const installMutation = useMutation({
    mutationFn: (filename: string) => api.installFromRegistry(filename),
    onSuccess: (installed: Flow) => {
      if (actionRef.current === 'install') {
        onInstalled(installed);
      } else {
        onCloneToEdit(installed);
      }
    },
  });

  return (
    <div className="flex flex-col h-full" data-testid="community-preview-panel">
      <div className="px-6 pt-6 pb-4 shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300">
            Community
          </span>
        </div>
        <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">{flow.name}</h3>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          {flow.author && (
            <div>
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">Author</p>
              <p className="text-sm text-slate-700 dark:text-slate-200">{flow.author}</p>
            </div>
          )}
          {flow.version && (
            <div>
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">Version</p>
              <p className="text-sm text-slate-700 dark:text-slate-200">{flow.version}</p>
            </div>
          )}
          <div>
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">Steps</p>
            <p className="text-sm text-slate-700 dark:text-slate-200">{flow.stepCount}</p>
          </div>
        </div>

        {flow.description && (
          <div>
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">Description</p>
            <p className="text-sm text-slate-600 dark:text-slate-400">{flow.description}</p>
          </div>
        )}

        {flow.steps && flow.steps.length > 0 ? (
          <div className="rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 p-3">
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">Flow</p>
            <FlowMermaid steps={flow.steps} />
          </div>
        ) : (
          <div className="rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 p-3">
            <p className="text-xs text-slate-500 italic">
              Step details will be available after installation.
            </p>
          </div>
        )}

        {installMutation.isError && (
          <p data-testid="community-install-error" className="text-sm text-red-600 dark:text-red-400">
            {(installMutation.error as Error)?.message ?? 'Installation failed'}
          </p>
        )}
      </div>

      <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 shrink-0 flex items-center gap-3">
        <button
          data-testid="community-install-btn"
          type="button"
          disabled={installMutation.isPending}
          onClick={() => { actionRef.current = 'install'; installMutation.mutate(flow.filename); }}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
        >
          {installMutation.isPending ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          Install
        </button>
        <button
          data-testid="community-clone-btn"
          type="button"
          disabled={installMutation.isPending}
          onClick={() => { actionRef.current = 'clone'; installMutation.mutate(flow.filename); }}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
        >
          <CopyPlus size={15} />
          Clone to Edit
        </button>
      </div>
    </div>
  );
};

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
  const [activeTab, setActiveTab] = useState<'my-flows' | 'community'>('my-flows');
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(
    initialFlowId ?? null
  );
  const [isNewFlow, setIsNewFlow] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // clonedFlow holds a not-yet-saved clone being edited
  const [clonedFlow, setClonedFlow] = useState<(Omit<Flow, 'id' | 'createdAt' | 'updatedAt'> & { id?: undefined }) | null>(null);
  // Community tab state
  const [selectedRegistryFlow, setSelectedRegistryFlow] = useState<RegistryFlow | null>(null);
  const [communitySearch, setCommunitySearch] = useState('');

  // ── Query: list all flows ──────────────────────────────────────────────────
  const { data: flows = [] } = useQuery<Flow[]>({
    queryKey: ['flows'],
    queryFn: () => api.listFlows(),
    enabled: isOpen,
  });

  // ── Query: builtin DEFAULT_FLOW (always the hardcoded default, never the project's active flow) ──
  const { data: builtinFlow } = useQuery<Flow>({
    queryKey: ['flow-default'],
    queryFn: () => api.getDefaultFlow(),
    enabled: isOpen,
    staleTime: Infinity, // never changes
  });

  // ── Mutation: switch project back to default (builtin) flow ────────────────
  const useDefaultFlowMutation = useMutation({
    mutationFn: () => api.setProjectFlow(projectId, null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flows'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  // ── Query: community registry flows ───────────────────────────────────────
  const { data: registryFlows = [], isLoading: isRegistryLoading, isError: isRegistryError } = useQuery<RegistryFlow[]>({
    queryKey: ['registry-flows'],
    queryFn: () => api.browseRegistry(),
    enabled: isOpen && activeTab === 'community',
    retry: 1,
  });

  const filteredRegistryFlows = registryFlows.filter(f =>
    !communitySearch ||
    f.name.toLowerCase().includes(communitySearch.toLowerCase()) ||
    (f.author ?? '').toLowerCase().includes(communitySearch.toLowerCase())
  );

  // Derive selected flow object
  const selectedFlow = isNewFlow
    ? null
    : clonedFlow
    ? (clonedFlow as unknown as Flow)
    : selectedFlowId === BUILTIN_ID
    ? (builtinFlow ?? null)
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
    } else if (activeFlowId) {
      setSelectedFlowId(activeFlowId);
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
    setClonedFlow(null);
  };

  const handleCommunityInstall = (installed: Flow) => {
    queryClient.invalidateQueries({ queryKey: ['flows'] });
    setActiveTab('my-flows');
    setSelectedFlowId(installed.id);
    setIsNewFlow(false);
    setClonedFlow(null);
  };

  const handleCommunityClone = (installed: Flow) => {
    queryClient.invalidateQueries({ queryKey: ['flows'] });
    const copy = cloneFlow(installed, installed.name);
    setActiveTab('my-flows');
    setClonedFlow(copy);
    setIsNewFlow(false);
    setSelectedFlowId(null);
  };

  const effectiveActiveFlowId = activeFlowId;

  const isReadOnly = selectedFlowId === BUILTIN_ID && !clonedFlow;
  const isEditingClone = clonedFlow !== null;

  const handleClone = (source: Flow, sourceName: string) => {
    const copy = cloneFlow(source, `Copy of ${sourceName}`);
    setClonedFlow(copy);
    setIsNewFlow(false);
    setSelectedFlowId(null);
  };

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

          {/* Tab bar */}
          <div className="flex border-b border-slate-200 dark:border-slate-700 shrink-0">
            <button
              data-testid="tab-my-flows"
              onClick={() => setActiveTab('my-flows')}
              className={clsx(
                'flex-1 py-2 text-xs font-semibold transition-colors border-b-2 -mb-px',
                activeTab === 'my-flows'
                  ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
              )}
            >
              My Flows
            </button>
            <button
              data-testid="tab-community"
              onClick={() => setActiveTab('community')}
              className={clsx(
                'flex-1 py-2 text-xs font-semibold transition-colors border-b-2 -mb-px',
                activeTab === 'community'
                  ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
              )}
            >
              Community
            </button>
          </div>

          {/* Community tab content */}
          {activeTab === 'community' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="px-3 py-2 shrink-0">
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    data-testid="community-search-input"
                    type="text"
                    placeholder="Search by name or author…"
                    value={communitySearch}
                    onChange={e => setCommunitySearch(e.target.value)}
                    className="w-full pl-7 pr-2 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto px-2 pb-2" data-testid="community-flow-list">
                {isRegistryLoading ? (
                  <div className="flex flex-col items-center justify-center py-8 gap-2 text-slate-500">
                    <Loader2 size={20} className="animate-spin" />
                    <span className="text-xs">Loading…</span>
                  </div>
                ) : isRegistryError ? (
                  <div className="flex flex-col items-center justify-center py-8 gap-2 px-3 text-center">
                    <AlertCircle size={20} className="text-red-500" />
                    <p className="text-xs text-red-600 dark:text-red-400">Failed to load registry.</p>
                  </div>
                ) : filteredRegistryFlows.length === 0 ? (
                  <p className="text-xs text-slate-500 text-center py-8">
                    {communitySearch ? 'No flows match.' : 'No community flows found.'}
                  </p>
                ) : (
                  filteredRegistryFlows.map((rf, idx) => (
                    <div
                      key={rf.filename}
                      data-testid={`community-flow-item-${idx}`}
                      onClick={() => setSelectedRegistryFlow(rf)}
                      className={clsx(
                        'w-full text-left px-3 py-2 rounded-lg mb-1 transition-colors cursor-pointer',
                        selectedRegistryFlow?.filename === rf.filename
                          ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                      )}
                    >
                      <p className="text-sm font-medium truncate">{rf.name}</p>
                      <p className="text-xs text-slate-400 dark:text-slate-500">
                        {rf.author ? `${rf.author} · ` : ''}{rf.stepCount} step{rf.stepCount !== 1 ? 's' : ''}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* My Flows tab content */}
          {activeTab === 'my-flows' && (
          <>
          {/* Flow list */}
          <div className="flex-1 overflow-y-auto px-2 pb-2" data-testid="flow-list">
            {/* Built-in default flow row */}
            <div
              data-testid="flow-item-__builtin__"
              onClick={() => { setSelectedFlowId(BUILTIN_ID); setIsNewFlow(false); setClonedFlow(null); }}
              className={clsx(
                'w-full text-left px-3 py-2 rounded-lg mb-1 transition-colors group cursor-pointer',
                selectedFlowId === BUILTIN_ID && !isNewFlow && !isEditingClone
                  ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-sm font-medium truncate flex-1">Default Flow</span>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    data-testid="clone-flow-btn-__builtin__"
                    type="button"
                    onClick={e => {
                      e.stopPropagation();
                      if (builtinFlow) {
                        handleClone(builtinFlow, builtinFlow.name ?? 'Default Flow');
                      }
                    }}
                    title="Clone flow"
                    className="p-1 rounded transition-colors text-slate-300 hover:text-indigo-500 dark:text-slate-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20"
                  >
                    <CopyPlus size={13} />
                  </button>
                  <span className="text-xs font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400">
                    DEFAULT
                  </span>
                </div>
              </div>
            </div>

            {flows.map(flow => {
              const isActive = flow.id === effectiveActiveFlowId;
              const isSelected = selectedFlowId === flow.id && !isNewFlow && !isEditingClone;
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
                      setClonedFlow(null);
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
                    <div className="flex items-center gap-0.5 shrink-0">
                      {/* Clone button */}
                      <button
                        data-testid={`clone-flow-btn-${flow.id}`}
                        type="button"
                        onClick={e => {
                          e.stopPropagation();
                          handleClone(flow, flow.name);
                        }}
                        title="Clone flow"
                        className="p-1 rounded transition-colors text-slate-300 hover:text-indigo-500 dark:text-slate-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20"
                      >
                        <CopyPlus size={13} />
                      </button>
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
                setClonedFlow(null);
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
          </>
          )}
        </div>

        {/* ── RIGHT PANEL ───────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {activeTab === 'community' ? (
            selectedRegistryFlow ? (
              <CommunityPreviewPanel
                key={selectedRegistryFlow.filename}
                flow={selectedRegistryFlow}
                onInstalled={handleCommunityInstall}
                onCloneToEdit={handleCommunityClone}
              />
            ) : (
              <div className="flex flex-col items-center justify-center flex-1 text-slate-400 dark:text-slate-600 gap-3 p-8">
                <Globe size={40} className="opacity-30" />
                <p className="text-sm">Select a community flow to preview it.</p>
              </div>
            )
          ) : selectedFlowId !== null || isNewFlow || isEditingClone ? (
            <EditorPanel
              key={isEditingClone ? '__clone__' : isNewFlow ? '__new__' : selectedFlowId}
              flow={selectedFlow}
              isReadOnly={isReadOnly}
              projectId={projectId}
              activeFlowId={effectiveActiveFlowId}
              onSaved={handleFlowSaved}
              onClose={onClose}
              onClone={
                isReadOnly && builtinFlow
                  ? () => handleClone(builtinFlow, builtinFlow.name ?? 'Default Flow')
                  : undefined
              }
              onUseDefault={
                isReadOnly
                  ? () => useDefaultFlowMutation.mutate()
                  : undefined
              }
            />
          ) : (
            <div className="flex flex-col items-center justify-center flex-1 text-slate-400 dark:text-slate-600 gap-3 p-8">
              <GitBranch size={40} className="opacity-30" />
              <p className="text-sm">Select a flow from the sidebar or create a new one.</p>
              <button
                onClick={() => { setIsNewFlow(true); setClonedFlow(null); }}
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
