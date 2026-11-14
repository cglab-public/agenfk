/**
 * 7ddeaf7c — the controls for a project's two suite settings: how far the
 * flow's verifyAt 'parent' reaches (the project's own scope, or the flow's),
 * and whether the project runs one suite at a time.
 *
 * Plain choices, not shell strings, so a browser may write them, as it writes
 * autoWorktree. One component for both places they appear: the desktop
 * project page and the Settings panel, which is the only settings screen the
 * board has in a browser.
 */
import React from 'react';
import { api } from '../api';
import { Switch } from './ui/switch';

interface SuiteRow { key: string; label: string; value: string | null; origin: string }

const SUITE_KEYS = new Set(['verifyAtScope', 'exclusiveSuite']);

/** Whether a settings row is one of the two this control writes - not when the repository's file decided it. */
export const hasSuiteControl = (row: { key: string; origin: string }): boolean =>
  SUITE_KEYS.has(row.key) && row.origin !== 'from-file';

const SCOPE_TEXT: Record<string, string> = {
  worktree: "Only the parent's own worktree",
  project: 'Any worktree in the project',
};

export function ProjectSuiteControl({ projectId, row, onSaved }: {
  projectId: string;
  row: SuiteRow;
  /** Called after a save, to read the rows again. */
  onSaved?: () => unknown;
}): React.ReactElement | null {
  // The project's OWN scope: '' while it inherits the flow's.
  const own = row.key === 'verifyAtScope' ? (row.origin === 'set-here' ? row.value ?? '' : '') : '';
  const on = row.value?.toLowerCase() === 'on';
  // Held here as well as in the row: a save answered with the same rows must not snap the control back.
  const [scope, setScope] = React.useState(own);
  const [checked, setChecked] = React.useState(on);
  React.useEffect(() => setScope(own), [own]);
  React.useEffect(() => setChecked(on), [on]);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState<string | null>(null);
  // A save the server refused puts the control back where the project is: never a value that was not saved.
  const save = async (patch: { verifyAtScope?: 'worktree' | 'project' | null; exclusiveSuite?: boolean }) => {
    setBusy(true);
    setFailed(null);
    try {
      await api.updateProject(projectId, patch);
      await onSaved?.();
    } catch (e: any) {
      setScope(own);
      setChecked(on);
      setFailed(`Not saved: ${e?.response?.data?.error ?? e?.message ?? 'the server refused it'}`);
    } finally {
      setBusy(false);
    }
  };
  const error = failed ? <span data-testid={`setting-error-${row.key}`} className="text-[11px] font-semibold text-danger-text">{failed}</span> : null;

  if (!hasSuiteControl(row)) return null;
  if (row.key === 'verifyAtScope') {
    return (
      <span className="flex shrink-0 items-center gap-2">
        {error}
        <select
          data-testid="setting-select-verifyAtScope"
          aria-label={row.label}
          value={scope}
          disabled={busy}
          onChange={e => {
            const next = e.target.value;
            setScope(next);
            void save({ verifyAtScope: next === 'worktree' || next === 'project' ? next : null });
          }}
          className="shrink-0 rounded-lg border border-border-soft bg-canvas px-2.5 py-1.5 text-[13px] text-ink-secondary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">{own === '' && row.value ? `The flow's: ${SCOPE_TEXT[row.value] ?? row.value}` : "The flow's setting"}</option>
          <option value="worktree">{SCOPE_TEXT.worktree}</option>
          <option value="project">{SCOPE_TEXT.project}</option>
        </select>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-2">
      {error}
      <Switch
        data-testid="setting-toggle-exclusiveSuite"
        aria-label={row.label}
        checked={checked}
        disabled={busy}
        onCheckedChange={next => {
          setChecked(next);
          void save({ exclusiveSuite: next });
        }}
      />
    </span>
  );
}
