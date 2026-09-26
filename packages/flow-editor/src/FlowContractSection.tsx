/**
 * CGLAB-384 — the flow editor's contract pieces, around the step columns:
 * a per-step summary button (role, check count, approval lock), the dialog
 * that edits one step's contract, the records lane (what steps hand to each
 * other), the problems the server reports with one-click fixes, and the
 * template picker. All of it reads the server's contract; none of it is shown
 * when the host has no contract route.
 */
import React, { useEffect, useState } from 'react';
import { KeyRound, UserCheck, X, LayoutTemplate, AlertTriangle } from 'lucide-react';
import { StepContractPanel } from './StepContractPanel';
import { checkText, RECORD_TEXTS, ROLE_TEXTS } from './checkTexts';
import { FLOW_TEMPLATES } from './flowTemplates';
import type { FlowContract, FlowStep } from './types';

/** Records a step with the test-authoring role makes: what the "add a step" fix can supply. */
const WRITING_TESTS_MAKES = new Set(['redSet', 'testSurface', 'authoredTests']);

const approvalOf = (step: FlowStep) => (Array.isArray(step.checks) ? step.checks : []).find(c => c.id === 'human-approval');

export const StepContractButton: React.FC<{
  index: number;
  step: FlowStep;
  stepContract: FlowContract['steps'][number] | undefined;
  onOpen: () => void;
}> = ({ index, step, stepContract, onOpen }) => {
  const role = typeof step.role === 'string' ? ROLE_TEXTS[step.role] : undefined;
  // What verify runs to leave the step and blocks on; warn-only checks are not counted.
  const count = (stepContract?.onLeave ?? stepContract?.checks ?? []).filter(c => c.applicable && c.severity === 'block').length;
  const approval = approvalOf(step);
  return (
    <button
      type="button"
      data-testid={`step-contract-btn-${index}`}
      onClick={onOpen}
      title="Role, checks and approvals"
      className="w-full text-left rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs hover:border-border-brand"
    >
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: role?.color ?? 'transparent', border: role ? 'none' : '1px dashed #94a3b8' }} />
        <span className="font-semibold truncate flex-1 text-slate-700 dark:text-slate-200">{role?.name ?? (step.role ? String(step.role) : 'No role')}</span>
        {approval && <UserCheck size={12} aria-label="A person approves" className="text-amber-600 shrink-0" />}
        {approval?.params?.signature === 'passkey' && <KeyRound size={12} aria-label="Signed with a passkey" className="text-amber-600 shrink-0" />}
      </span>
      <span className="block text-slate-500 dark:text-slate-400">{count} {count === 1 ? 'check' : 'checks'}</span>
    </button>
  );
};

export const StepContractDialog: React.FC<{
  step: FlowStep;
  stepContract: FlowContract['steps'][number] | undefined;
  contract: FlowContract;
  disabled: boolean;
  /** Why the contract cannot be edited here, when it cannot. */
  readOnlyNote?: string;
  onChange: (patch: Partial<FlowStep>) => void;
  onClose: () => void;
}> = ({ step, stepContract, contract, disabled, readOnlyNote, onChange, onClose }) => {
  // Capture phase on window, like ExitCriteriaEditorModal: the editor closes on
  // a bubble-phase window Escape (discarding unsaved edits), and focus often
  // drops to <body> after a pick unmounts the clicked button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
  // Dimmed, blurred, and one surface up with a border: a dialog over the
  // editor must not share its background (it blended into it in dark mode).
  <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-label={`Checks for ${step.label || step.name}`}>
    <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-2xl">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-200 dark:border-slate-700">
        <div className="flex-1">
          <div className="font-bold text-slate-900 dark:text-slate-100">{step.label || step.name}</div>
          <div className="text-xs text-slate-500">What happens in this step, and what an agent must show to leave it.</div>
        </div>
        <button type="button" autoFocus aria-label="Close step checks" onClick={onClose} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700">
          <X size={16} />
        </button>
      </div>
      <div className="p-5 space-y-3">
        {disabled && readOnlyNote && (
          <div className="text-xs rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 text-blue-900 dark:text-blue-100 px-3 py-2">{readOnlyNote}</div>
        )}
        <StepContractPanel step={step} stepContract={stepContract} contract={contract} disabled={disabled} onChange={onChange} />
      </div>
    </div>
  </div>
  );
};

/** What steps hand to each other: each record, where it is made and where it is read. */
export const RecordsLane: React.FC<{ steps: FlowStep[]; contract: FlowContract }> = ({ steps, contract }) => {
  const fmt = (name: string) => { const l = steps.find(s => s.name === name)?.label || name; return l === name ? name : `${l} (${name})`; };
  const records = new Map<string, { made: string[]; used: string[] }>();
  for (const st of contract.steps) {
    for (const r of st.produces) (records.get(r) ?? records.set(r, { made: [], used: [] }).get(r)!).made.push(st.name);
    for (const r of st.consumes ?? []) (records.get(r) ?? records.set(r, { made: [], used: [] }).get(r)!).used.push(st.name);
  }
  if (!records.size) return null;
  return (
    <div data-testid="records-lane" className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-3 space-y-1">
      <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">What steps hand to each other</div>
      <div className="text-xs text-slate-500 dark:text-slate-400">A check can only use something an earlier step made.</div>
      <ul className="text-sm space-y-0.5 pt-1">
        {[...records.entries()].map(([rec, { made, used }]) => (
          <li key={rec} className="text-slate-700 dark:text-slate-200">
            <span className="font-semibold">{RECORD_TEXTS[rec] ?? rec}</span>
            <span className="text-slate-500 dark:text-slate-400">
              {' '}— made in {made.length ? made.map(fmt).join(', ') : 'no step'}
              {used.length ? `; used by ${used.map(fmt).join(', ')}` : '; not used yet'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/**
 * The problems that block Save, in words. A check that needs a record no
 * earlier step makes gets two fixes: remove it, or (when a Writing-tests step
 * would make that record) add one before it.
 */
export const ContractProblems: React.FC<{
  steps: FlowStep[];
  contract: FlowContract;
  disabled: boolean;
  onRemoveCheck: (stepIndex: number, checkId: string) => void;
  onAddWritingTestsBefore: (stepIndex: number) => void;
}> = ({ steps, contract, disabled, onRemoveCheck, onAddWritingTestsBefore }) => {
  if (contract.valid) return null;
  const catalogue = new Map(contract.catalogue.map(c => [c.id, c]));
  const orphans = contract.steps.flatMap(st => st.checks
    .filter(c => c.source === 'flow' && !c.applicable)
    .map(c => ({ step: st.name, check: c.id, missing: c.missing ?? [] })));
  // Messages the orphan rows do not already say.
  const other = contract.errors.filter(e => !/needs the record/.test(e));
  return (
    <div data-testid="flow-contract-problems" className="rounded-xl border border-orange-300 bg-orange-50 dark:bg-orange-950/30 dark:border-orange-800 px-4 py-3 space-y-3">
      {orphans.map(o => {
        const index = steps.findIndex(s => s.name === o.step);
        const stepLabel = steps[index]?.label || o.step;
        const title = checkText(o.check, catalogue.get(o.check)?.description).title;
        const recs = o.missing.map(r => RECORD_TEXTS[r] ?? r).join(', ');
        return (
          <div key={`${o.step}-${o.check}`} className="flex gap-2">
            <AlertTriangle size={16} className="text-orange-700 shrink-0 mt-0.5" aria-hidden />
            <div className="space-y-2 flex-1">
              <div className="text-sm text-orange-900 dark:text-orange-100">
                <span className="font-semibold">"{title}" on {stepLabel} has nothing to check.</span> It needs the {recs}, which no step before {stepLabel} makes.
              </div>
              {!disabled && (
                <div className="flex gap-2 flex-wrap">
                  {o.missing.every(r => WRITING_TESTS_MAKES.has(r)) && (
                    <button type="button" onClick={() => onAddWritingTestsBefore(index)}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900">
                      Add a "Writing tests" step before {stepLabel}
                    </button>
                  )}
                  <button type="button" onClick={() => onRemoveCheck(index, o.check)}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-orange-300 text-orange-900 dark:text-orange-100 bg-white dark:bg-transparent">
                    Remove this check
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
      {other.map((e, i) => (
        <div key={i} className="flex gap-2 text-sm text-orange-900 dark:text-orange-100">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden /> {e}
        </div>
      ))}
      <div className="text-xs text-orange-800 dark:text-orange-200">Fix these to save. The server checks the same thing, so a flow like this is refused from the registry and the hub too.</div>
    </div>
  );
};

/** One-click starting points: they replace the steps, roles and checks included. */
export const TemplatePicker: React.FC<{ onApply: (steps: FlowStep[]) => void }> = ({ onApply }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1 text-xs font-semibold text-accent-text hover:opacity-80">
        <LayoutTemplate size={14} /> Start from template
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-50 w-72 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg p-2 space-y-1">
          {Object.values(FLOW_TEMPLATES).map(t => (
            <button key={t.name} type="button" onClick={() => { onApply(t.steps); setOpen(false); }}
              className="w-full text-left rounded-lg px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-700">
              <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">{t.name}</span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">{t.description}</span>
            </button>
          ))}
          <div className="px-3 pt-1 text-xs text-slate-400">Replaces this flow's steps. Nothing is saved until you press Save.</div>
        </div>
      )}
    </div>
  );
};
