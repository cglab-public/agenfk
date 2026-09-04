/**
 * Admin → Models — the unified model table with inline editing.
 *
 * One row per model NAME. Aliasing (which reported spellings fold into it) and
 * classification (provider / weights / licence) are two axes shown on the same
 * row, because they describe the same thing: the name the dashboard groups and
 * filters by.
 *
 * Classification attaches to the group row, never to an individual spelling —
 * classifying a spelling would let one model have two licences depending on
 * which agent reported it.
 *
 * Editing is inline: click a value, change it, Save/Cancel in the row. A
 * separate add-form was removed because "correct this row" and "add a row" are
 * the same operation against an upsert endpoint.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Pencil, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { LICENSE_CLASSES, validateMetaRow, isHarnessName, licenseClassLabel } from '../pages/adminModelMeta';
import {
  buildUnifiedRows, editorInitial, isDirty, UNKNOWN_LABEL,
  type UnifiedRow,
} from '../pages/adminModelsUnified';
import type { ModelGroup } from '../pages/modelMappings';

const cardCls = 'bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5';
const inputCls = 'w-full px-2 py-1 rounded-md border border-border-soft bg-chip text-ink dark:text-white text-[12px] placeholder:text-ink-tertiary focus:outline-none focus:ring-2 focus:ring-brand';
const filterCls = 'w-full px-3 py-2 rounded-lg border border-border-soft bg-chip text-ink dark:text-white text-sm placeholder:text-ink-tertiary focus:outline-none focus:ring-2 focus:ring-brand';

interface Props {
  groups: ModelGroup[];
  metaRows: Array<{ model: string; provider: string; licenseClass: 'open_weights' | 'commercial'; license: string; source: 'seed' | 'admin' }>;
  loading: boolean;
  onError: (msg: string | null) => void;
  invalidate: () => void;
  /**
   * Remove an alias→canonical mapping. The unified table replaced the old
   * mappings table, so unmap lives here now — on the alias row, never the
   * model row: unmapping is about a spelling, not about the model.
   */
  onUnmap: (aliasModel: string) => void;
  unmapping: boolean;
  /** Names that are each their own group — the thing mapping exists to fix. */
  unmappedCount: number;
  /** Mappings whose alias has not been reported yet. */
  unusedCount: number;
}

interface Draft {
  provider: string;
  licenseClass: string;
  license: string;
}

export function ModelTable({ groups, metaRows, loading, onError, invalidate, onUnmap, unmapping, unmappedCount, unusedCount }: Props) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'observed' | 'all'>('observed');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ provider: '', licenseClass: '', license: '' });
  const [rowError, setRowError] = useState<string | null>(null);

  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: async (body: { model: string; provider: string; license: string; licenseClass: string }) =>
      (await api.put('/v1/admin/models/meta', body)).data,
    onSuccess: () => {
      setRowError(null); onError(null); setEditing(null);
      invalidate();
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.error ?? 'Could not save the model metadata.';
      setRowError(msg); onError(msg);
    },
  });

  const remove = useMutation({
    mutationFn: async (model: string) =>
      (await api.delete(`/v1/admin/models/meta/${encodeURIComponent(model)}`)).data,
    onSuccess: () => { setRowError(null); onError(null); invalidate(); },
    onError: (e: any) => {
      const msg = e?.response?.data?.error ?? 'Could not delete the row.';
      setRowError(msg); onError(msg);
    },
  });

  const all = useMemo(
    () => buildUnifiedRows(groups, metaRows, scope),
    [groups, metaRows, scope],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(r =>
      r.canonicalModel.toLowerCase().includes(q)
      || (r.meta?.provider ?? UNKNOWN_LABEL).toLowerCase().includes(q)
      || (r.meta?.license ?? '').toLowerCase().includes(q));
  }, [all, query]);

  const unknownCount = all.filter(r => r.unknown).length;
  const adminCount = all.filter(r => r.meta?.source === 'admin').length;

  const beginEdit = (row: UnifiedRow) => {
    setEditing(row.canonicalModel);
    setRowError(null);
    setDraft(editorInitial(row));
  };

  /**
   * Validate the whole row, mirroring the server's checks so an invalid edit is
   * refused here instead of bouncing off the API after a round trip.
   *
   * The model key is validated too even though inline editing cannot change it:
   * a harness name (claude-code) must never become classifiable, and this is
   * the last place that knows it before the request goes out.
   */
  const rowProblem = (model: string, d: Draft): string | null =>
    validateMetaRow({
      model,
      provider: d.provider,
      license: d.license,
      licenseClass: d.licenseClass,
    }) ?? (isHarnessName(model) ? `"${model}" is an agent runtime, not a model.` : null);

  const commit = (row: UnifiedRow) => {
    const problem = rowProblem(row.canonicalModel, draft);
    if (problem) { setRowError(problem); return; }
    save.mutate({
      model: row.canonicalModel,
      provider: draft.provider.trim(),
      license: draft.license.trim(),
      licenseClass: draft.licenseClass,
    });
  };

  return (
    <section className={cardCls}>
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-ink">
            Models <span className="text-ink-tertiary font-normal">({visible.length})</span>
          </h3>
          <p className="mt-0.5 text-xs text-ink-tertiary">
            One row per model name. Aliases fold into it; provider and licence are what the PR
            Overview filters by. Click a value to edit it inline. “Open weights” means the
            weights are downloadable — not that the licence is open source.
          </p>
          {(unknownCount > 0 || adminCount > 0) && (
            <p className="mt-1 text-[11px] text-ink-tertiary">
              {unknownCount > 0 && (
                <span className="text-amber-600 dark:text-amber-400 font-semibold">
                  {unknownCount} unknown
                </span>
              )}
              {unknownCount > 0 && adminCount > 0 && ' · '}
              {adminCount > 0 && <span>{adminCount} edited by an admin</span>}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <label className="flex items-center gap-2 text-[11px] text-ink-tertiary cursor-pointer">
            <input
              type="checkbox"
              checked={scope === 'all'}
              onChange={e => setScope(e.target.checked ? 'all' : 'observed')}
              className="accent-brand"
            />
            Show all classification rules
            <span
              title="Off: only models actually reported. On: also the seeded rules that matched nothing, so family rules like 'glm-' can be edited."
              className="cursor-help"
            >
              ⓘ
            </span>
          </label>
        </div>
      </header>

      {unmappedCount > 0 && (
        <p className="mt-2 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
          <AlertTriangle className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />
          {unmappedCount} unmapped — these names are each their own group. Use “add a mapping”
          above to fold spellings of the same model together.
        </p>
      )}

      {unusedCount > 0 && (
        <p className="mt-2 text-[11px] text-ink-tertiary">
          {unusedCount} {unusedCount === 1 ? 'mapping is' : 'mappings are'} listed below but that
          spelling has not been reported yet — the mapping is waiting, not broken.
        </p>
      )}

      <input
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Filter by model, provider or licence…"
        aria-label="Filter models"
        className={`mt-4 ${filterCls}`}
      />

      {rowError && (
        <p role="alert" className="mt-2 text-[12px] text-rose-600 dark:text-rose-400">{rowError}</p>
      )}

      {loading && <p className="mt-3 text-sm text-ink-tertiary">Loading…</p>}

      {!loading && visible.length === 0 && (
        <p className="mt-3 text-sm text-ink-tertiary">
          {query ? `No models match “${query}”.` : 'No models reported yet.'}
        </p>
      )}

      {visible.length > 0 && (
        <div className="mt-3 -mx-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-tertiary font-semibold">
                <th className="px-5 py-2 text-left font-semibold">Model</th>
                <th className="px-3 py-2 text-right font-semibold">PRs</th>
                <th className="px-3 py-2 text-left font-semibold">Provider</th>
                <th className="px-3 py-2 text-left font-semibold">Weights</th>
                <th className="px-3 py-2 text-left font-semibold">Licence</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {visible.map(row => (
                <ModelRow
                  key={row.canonicalModel}
                  row={row}
                  editing={editing === row.canonicalModel}
                  draft={draft}
                  dirty={isDirty(row, draft)}
                  invalid={!!rowProblem(row.canonicalModel, draft)}
                  busy={save.isPending || remove.isPending}
                  onEdit={() => beginEdit(row)}
                  onCancel={() => { setEditing(null); setRowError(null); }}
                  onChange={(d) => { setDraft(d); setRowError(isDirty(row, d) ? rowProblem(row.canonicalModel, d) : null); }}
                  onSave={() => commit(row)}
                  onUnmap={onUnmap}
                  unmapping={unmapping}
                  onDelete={() => {
                    if (window.confirm(`Delete the classification for "${row.canonicalModel}"? It will show as unknown until re-added.`)) {
                      remove.mutate(row.meta?.matchedKey ?? row.canonicalModel);
                    }
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-[11px] text-ink-tertiary">
        Rules match by prefix, longest first, so a specific model beats its family. Editing a row
        that inherited a family rule narrows that rule to this model.
      </p>
    </section>
  );
}

function ModelRow({ row, editing, draft, dirty, invalid, busy, onEdit, onCancel, onChange, onSave, onDelete, onUnmap, unmapping }: {
  row: UnifiedRow;
  editing: boolean;
  draft: Draft;
  dirty: boolean;
  invalid: boolean;
  busy: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onDelete: () => void;
  onUnmap: (aliasModel: string) => void;
  unmapping: boolean;
}) {
  const inherited = row.meta && !row.meta.exact;

  return (
    <>
      <tr className={`border-t border-border-soft ${row.unknown ? 'bg-amber-500/5' : ''}`}>
        <td className="px-5 py-2 align-top">
          <div className="font-mono text-[12px] font-semibold text-ink">{row.canonicalModel}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-ink-tertiary">
            {row.aliasCount > 0 && <span>{row.aliasCount} alias{row.aliasCount === 1 ? '' : 'es'}</span>}
            {row.meta?.source === 'admin' && <span className="text-accent-text">edited</span>}
            {inherited && (
              <span title={`Inherited from the rule "${row.meta?.matchedKey}"`} className="cursor-help">
                from {row.meta?.matchedKey}
              </span>
            )}
            {row.familyCovers != null && <span>covers {row.familyCovers}</span>}
          </div>
        </td>
        <td className="px-3 py-2 text-right align-top font-mono text-[12px] text-ink-secondary">
          {row.prs}
        </td>

        {editing ? (
          <>
            <td className="px-3 py-2">
              <input
                autoFocus
                value={draft.provider}
                onChange={e => onChange({ ...draft, provider: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter' && dirty) onSave(); if (e.key === 'Escape') onCancel(); }}
                aria-label="Provider"
                placeholder="Provider"
                className={`${inputCls} font-mono`}
              />
            </td>
            <td className="px-3 py-2">
              <select
                value={draft.licenseClass}
                onChange={e => onChange({ ...draft, licenseClass: e.target.value })}
                onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}
                aria-label="Weights"
                className={inputCls}
              >
                <option value="">— choose —</option>
                {LICENSE_CLASSES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </td>
            <td className="px-3 py-2">
              <input
                value={draft.license}
                onChange={e => onChange({ ...draft, license: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter' && dirty) onSave(); if (e.key === 'Escape') onCancel(); }}
                aria-label="License"
                placeholder="e.g. MIT"
                className={inputCls}
              />
            </td>
            <td className="px-3 py-2 text-right whitespace-nowrap">
              <button
                onClick={onSave}
                disabled={!dirty || invalid || busy}
                title={invalid ? 'Fix the highlighted value first' : dirty ? 'Save' : 'No changes to save'}
                aria-label="Save"
                className="p-1 rounded text-accent-text disabled:opacity-30 hover:bg-chip"
              >
                <Check className="w-4 h-4" />
              </button>
              <button
                onClick={onCancel}
                aria-label="Cancel"
                className="p-1 rounded text-ink-tertiary hover:text-ink hover:bg-chip"
              >
                <X className="w-4 h-4" />
              </button>
            </td>
          </>
        ) : (
          <>
            <td className="px-3 py-2 text-[12px] text-ink">
              {row.meta?.provider ?? <span className="text-amber-600 dark:text-amber-400 font-semibold">{UNKNOWN_LABEL}</span>}
            </td>
            <td className="px-3 py-2 text-[12px] text-ink-secondary">
              {row.meta ? licenseClassLabel(row.meta.licenseClass) : '—'}
            </td>
            <td className="px-3 py-2 text-[12px] text-ink-tertiary">
              {row.meta?.license || '—'}
            </td>
            <td className="px-3 py-2 text-right whitespace-nowrap">
              <button
                onClick={onEdit}
                aria-label={`Edit classification for ${row.canonicalModel}`}
                title={row.unknown ? 'Classify this model' : 'Edit'}
                className="p-1 rounded text-ink-tertiary hover:text-accent-text hover:bg-chip"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              {row.meta && (
                <button
                  onClick={onDelete}
                  disabled={busy}
                  aria-label={`Delete classification for ${row.canonicalModel}`}
                  className="p-1 rounded text-ink-tertiary hover:text-rose-600 disabled:opacity-40"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </td>
          </>
        )}
      </tr>

      {/* Alias spellings folded into this name — shown, but not individually
          classifiable: one model must not have two licences. They DO get an
          unmap control, since unmapping is about a spelling, not the model. */}
      {!editing && row.aliases.map(a => (
        <tr key={a.model} className="border-t border-border-soft/50">
          <td className="px-5 py-1 pl-9 text-[11px] text-ink-tertiary font-mono">
            <span className="text-ink-tertiary/70">↳</span> {a.model}
            {a.reported
              ? a.prs > 0 && <span className="ml-1">({a.prs})</span>
              : <span className="ml-1 italic">not reported yet</span>}
          </td>
          <td className="px-3 py-1 text-[10px] text-ink-tertiary italic">maps to {row.canonicalModel}</td>
          <td className="px-3 py-1" colSpan={2} />
          <td className="px-3 py-1 text-right whitespace-nowrap">
            <button
              onClick={() => onUnmap(a.model)}
              disabled={unmapping}
              aria-label={`Unmap ${a.model}`}
              title={`Stop mapping "${a.model}" — dashboards will show it as its own model again`}
              className="p-1 rounded text-ink-tertiary hover:text-rose-600 disabled:opacity-40"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </td>
        </tr>
      ))}
    </>
  );
}
