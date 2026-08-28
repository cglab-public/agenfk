/**
 * Exit criteria editor — the "popped up view" for a flow step's exit criteria
 * (CGLAB-109).
 *
 * Exit criteria were designed to show short text (a plain inline textarea in
 * the step column) but grew into long markdown. This popup gives the full
 * surface: a markdown source editor, a rendered preview beside it, and a
 * token count estimate under the editor so the author sees the context cost
 * before saving. It is a nested modal (z-index above FlowEditorModal's z-50)
 * with local edit state: Save commits via onSave, Cancel/Escape/overlay-click
 * discard.
 *
 * Markdown rendering uses react-markdown + remark-gfm (peer deps) with the
 * same `prose` styling the host apps already use for rendered markdown (the
 * host's Tailwind build must include the typography plugin — ui and hub-ui
 * both do).
 */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, ScrollText } from 'lucide-react';
import { estimateTokenCount } from './estimateTokens';

export interface ExitCriteriaEditorModalProps {
  /** Step label (display name) shown in the header. */
  stepLabel: string;
  /** Current criteria (markdown source) — seeds the editor. */
  initialValue: string;
  /** Committed on Save with the editor's final value. */
  onSave: (value: string) => void;
  /** Called on Cancel / Escape / overlay click. */
  onClose: () => void;
}

export const ExitCriteriaEditorModal: React.FC<ExitCriteriaEditorModalProps> = ({
  stepLabel,
  initialValue,
  onSave,
  onClose,
}) => {
  const [value, setValue] = useState(initialValue);

  // Escape closes without saving — and ONLY this popup. The parent flow
  // editor has its own bubble-phase window Escape listener (which hard-
  // unmounts it in the hosts, discarding every unsaved step edit), so this
  // one registers in the CAPTURE phase and stops propagation: capture on
  // window runs before the parent's bubble listener, and stopPropagation
  // here means the parent's handler never sees the keypress. (A bubble-phase
  // stopPropagation would not work — both listeners sit on window.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const tokens = estimateTokenCount(value);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      data-testid="exit-criteria-editor-modal"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[calc(100vw-2rem)] max-w-4xl h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-700 flex items-center gap-2.5 shrink-0">
          <ScrollText size={16} className="text-accent-text shrink-0" />
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">
              Exit Criteria
            </h3>
            <p className="text-xs text-slate-400 dark:text-slate-500 truncate">{stepLabel}</p>
          </div>
          <button
            data-testid="exit-criteria-close"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body: editor | preview */}
        <div className="flex-1 min-h-0 grid grid-cols-2">
          {/* Editor column */}
          <div className="flex flex-col min-h-0 border-r border-slate-200 dark:border-slate-700">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500 px-4 pt-3 shrink-0">
              Markdown
            </label>
            <textarea
              data-testid="exit-criteria-editor"
              value={value}
              onChange={e => setValue(e.target.value)}
              rows={14}
              placeholder={'What must be true before leaving this step?\n\nMarkdown is supported:\n- lists, **bold**, `code`, [links](…)'}
              className="flex-1 min-h-0 mx-4 my-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-brand resize-none leading-relaxed"
            />
            {/* Token estimate — under the editor, as specified */}
            <div
              data-testid="exit-criteria-token-count"
              className="px-4 pb-3 shrink-0 text-xs text-slate-400 dark:text-slate-500 tabular-nums"
            >
              ~{tokens} {tokens === 1 ? 'token' : 'tokens'} (estimate)
            </div>
          </div>
          {/* Preview column */}
          <div className="flex flex-col min-h-0">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500 px-4 pt-3 shrink-0">
              Preview
            </span>
            <div
              data-testid="exit-criteria-preview"
              className="flex-1 min-h-0 overflow-y-auto px-4 py-3 prose prose-slate dark:prose-invert prose-sm max-w-none"
            >
              {value.trim() ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
              ) : (
                <span className="not-prose text-sm italic text-slate-400 dark:text-slate-600">
                  Nothing to preview yet.
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-700 flex items-center justify-end gap-2 shrink-0">
          <button
            data-testid="exit-criteria-cancel"
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            Cancel
          </button>
          <button
            data-testid="exit-criteria-save"
            type="button"
            onClick={() => onSave(value)}
            className="px-3.5 py-1.5 rounded-lg text-sm font-semibold text-white bg-brand hover:opacity-90 transition-opacity"
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
