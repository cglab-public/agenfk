/**
 * Meta-filter over the model list (CGLAB-133 follow-up).
 *
 * Lets the user select/deselect models by vendor (Z.ai, Anthropic, OpenAI, …)
 * and by license class (open weights / commercial API), instead of searching a
 * long model list one chip at a time.
 *
 * It is a SELECTOR, not a filter axis: clicking "Anthropic" puts Anthropic's
 * models into the same `?model=` CSV the Model facet already uses. Two
 * consequences that shape the design:
 *
 *  - No backend change — the server already accepts a model CSV — and a shared
 *    link restores the exact same view, because the result is plain model ids.
 *  - It only ADDS models. Removing a vendor is done by removing models from the
 *    Model facet, not by unclicking a vendor, because "which models are
 *    selected" is the real state and a vendor chip cannot un-select models the
 *    user picked individually without surprising them. The copy says so rather
 *    than implying a toggle it does not implement.
 *
 * Provider and license class are NOT computed here — they arrive on each
 * `byModel` row from the server's model_meta table, which an admin edits in
 * Admin → Models. Counts per option are the number of models that selection
 * would add, so a chip is informative before it is clicked and an exhausted
 * vendor reads as exhausted rather than missing.
 */
import { useId, useMemo } from 'react';
import {
  modelMeta, providersFor, licenseClassesFor, modelsMatching,
  LICENSE_CLASS_LABEL, UNCLASSIFIED,
  type FacetClass, type ModelFacetRow,
} from '../modelMeta';

interface Props {
  /**
   * The API's `byModel` rows for the current window. Each carries the
   * provider/licenseClass resolved server-side from the model_meta table.
   */
  rows: ModelFacetRow[];
  /** Models already selected in the Model facet. */
  selected: Set<string>;
  /** Add the models this selection resolves to. */
  onApply: (modelsToAdd: string[]) => void;
  /**
   * Inert, not hidden — see FacetMultiselect's `disabled`. The PR Overview's
   * PR-number search supersedes the model filter, and this selector writes into
   * that same filter, so it has to read as inactive while the search is on.
   */
  disabled?: boolean;
}

/** Why a still-selected control is dead. Named once because it has to be said in
 *  three places, and because the WRONG reason is worse than none: "Add 0 more
 *  Anthropic models" tells a reader who landed on a shared `?pr=57&model=` link
 *  that the filter is exhausted, when it is actually switched off. */
const SUPERSEDED_TITLE =
  'A PR search supersedes the model filter — this selection is kept but does not apply until the search is cleared';

export function ModelMetaFilter({ rows, selected, onApply, disabled = false }: Props) {
  const id = useId();
  const unclassifiedHintId = `${id}-unclassified`;
  const openHintId = `${id}-open`;
  const closedHintId = `${id}-closed`;
  const providers = useMemo(() => providersFor(rows), [rows]);
  const classes = useMemo(() => licenseClassesFor(rows), [rows]);

  // How many models each option would ADD (already-selected ones excluded), so
  // a chip that does nothing reads as 0 instead of looking broken.
  const counts = useMemo(() => {
    const byProvider = new Map<string, number>();
    for (const p of providers) {
      byProvider.set(p, modelsMatching(rows, new Set([p]), new Set())
        .filter(m => !selected.has(m)).length);
    }
    const byClass = new Map<string, number>();
    for (const c of classes) {
      byClass.set(c, modelsMatching(rows, new Set(), new Set([c]))
        .filter(m => !selected.has(m)).length);
    }
    return { byProvider, byClass };
  }, [rows, selected, providers, classes]);

  // Nothing to filter on: one model, or no metadata at all (e.g. the overview
  // was served by a hub that predates model_meta).
  if (rows.length <= 1 || providers.length === 0) return null;

  const applyProvider = (p: string) => onApply(modelsMatching(rows, new Set([p]), new Set()));
  const applyClass = (c: FacetClass) => onApply(modelsMatching(rows, new Set(), new Set([c])));

  return (
    <div className="space-y-2">
      <p className="text-caption text-ink-tertiary">
        Select by vendor or license — adds the matching models to the selection.
      </p>

      <div>
        <h4 className="eyebrow text-ink-tertiary">Provider</h4>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {providers.map(p => {
            const n = counts.byProvider.get(p) ?? 0;
            const label = p === UNCLASSIFIED ? 'Unclassified' : p;
            const off = disabled || n === 0;
            return (
              <button
                key={p}
                // A vendor with nothing left to add is disabled rather than
                // hidden, so "all of Anthropic is already selected" is legible.
                disabled={off}
                onClick={() => applyProvider(p)}
                // The tooltip has to name the REAL reason the button is dead —
                // see SUPERSEDED_TITLE. What Unclassified means is said under
                // the row, not only in a title.
                title={disabled
                  ? SUPERSEDED_TITLE
                  : p === UNCLASSIFIED ? undefined : `Add ${n} more ${p} model${n === 1 ? '' : 's'}`}
                aria-describedby={!disabled && p === UNCLASSIFIED ? unclassifiedHintId : undefined}
                className={`px-2.5 py-1 rounded-full font-mono text-caption border transition-colors ${
                  off
                    ? 'text-ink-tertiary border-border-soft opacity-50 cursor-not-allowed'
                    : 'text-ink-secondary border-border-soft hover:text-accent-ink hover:border-accent'}`}
              >
                {label}
                <span className="ml-1 text-ink-tertiary">{n}</span>
                {!disabled && n === 0 && <span className="sr-only"> (all already selected)</span>}
              </button>
            );
          })}
        </div>
        {(providers.includes(UNCLASSIFIED) || classes.includes(UNCLASSIFIED)) && (
          <p id={unclassifiedHintId} className="mt-1 text-caption text-ink-tertiary">
            Unclassified: models the hub could not classify — configure them in Admin → Models.
          </p>
        )}
      </div>

      <div>
        <h4 className="eyebrow text-ink-tertiary">Weights</h4>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {classes.map(c => {
            const n = counts.byClass.get(c) ?? 0;
            const off = disabled || n === 0;
            return (
              <button
                key={c}
                disabled={off}
                onClick={() => applyClass(c)}
                // What each class means is said under the row, not only in a title.
                title={disabled ? SUPERSEDED_TITLE : undefined}
                aria-describedby={disabled ? undefined
                  : c === 'open_weights' ? openHintId
                    : c === UNCLASSIFIED ? unclassifiedHintId : closedHintId}
                className={`px-2.5 py-1 rounded-full font-mono text-caption border transition-colors ${
                  off
                    ? 'text-ink-tertiary border-border-soft opacity-50 cursor-not-allowed'
                    : 'text-ink-secondary border-border-soft hover:text-accent-ink hover:border-accent'}`}
              >
                {LICENSE_CLASS_LABEL[c]}
                <span className="ml-1 text-ink-tertiary">{n}</span>
                {!disabled && n === 0 && <span className="sr-only"> (all already selected)</span>}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-caption text-ink-tertiary">
          {classes.includes('open_weights') && (
            <span id={openHintId}>Open weights: publicly downloadable, including bespoke licences with commercial-use gates — open weights, not open source. </span>
          )}
          {classes.includes('commercial') && <span id={closedHintId}>{LICENSE_CLASS_LABEL.commercial}: no downloadable weights, hosted API only.</span>}
        </p>
      </div>

      {/* Show the licence of what is selected, so "Open weights" is verifiable
          rather than a claim the reader has to trust.

          Under a PR search this disclosure describes a selection that does not
          apply, so it is made inert too: the accordion says these filters "do not
          apply", and a still-clickable control inside it contradicts that. */}
      {selected.size > 0 && (
        <details className="text-caption" aria-disabled={disabled || undefined} title={disabled ? SUPERSEDED_TITLE : undefined}>
          <summary className={`text-ink-tertiary ${disabled ? 'opacity-60 pointer-events-none' : 'cursor-pointer hover:text-ink-secondary'}`}>
            License of {selected.size} selected model{selected.size === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1.5 space-y-0.5 max-h-32 overflow-y-auto">
            {[...selected].sort().map(m => {
              const meta = modelMeta(m, rows);
              return (
                <li key={m} className="font-mono text-caption text-ink-tertiary truncate">
                  <span className="text-ink-secondary">{m}</span>
                  {' — '}
                  {meta.provider === UNCLASSIFIED ? 'unclassified' : meta.provider}
                  {' · '}
                  {LICENSE_CLASS_LABEL[meta.licenseClass]}
                  {meta.license ? ` · ${meta.license}` : ''}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
