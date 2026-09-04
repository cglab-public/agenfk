import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { fmtDate } from '../dates';
import {
  groupModels, validateMapping, knownCanonicalNames,
  MappingRow, ObservedModel,
} from './modelMappings';
import {
  ModelMetaRow, LICENSE_CLASSES, validateMetaRow, isHarnessName,
  sortMetaRows, filterMetaRows, licenseClassLabel,
} from './adminModelMeta';

const inputCls = 'w-full px-3 py-2 rounded-lg border border-border-soft bg-chip text-ink dark:text-white text-sm placeholder:text-ink-tertiary focus:outline-none focus:ring-2 focus:ring-brand';
const cardCls = 'bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5';
const primaryBtnCls = 'px-4 py-2 rounded-lg bg-[image:var(--gradient-accent)] text-navy shadow-glow disabled:opacity-50 text-sm font-bold transition-colors';

interface ModelsResponse {
  mappings: MappingRow[];
  observed: ObservedModel[];
  meta?: ModelMetaRow[];
}

/**
 * Admin → Models: fold the several spellings an agent can report for one model
 * into the single name the admin chooses.
 *
 * The left column is the desired name — what dashboards group and filter by.
 * Under each, the reported spellings folded into it with their PR counts.
 * Resolved at read time, so nothing here rewrites history and deleting a
 * mapping puts the dashboard back the way it was.
 */
export function AdminModels() {
  const qc = useQueryClient();
  const [alias, setAlias] = useState('');
  const [canonical, setCanonical] = useState('');
  const [error, setError] = useState<string | null>(null);

  const data = useQuery<ModelsResponse>({
    queryKey: ['admin-models'],
    queryFn: async () => (await api.get('/v1/admin/models')).data,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-models'] });
    // The PR Overview "By model" table and its filter options are what this
    // actually changes, so they must refetch too.
    qc.invalidateQueries({ queryKey: ['pr-overview'] });
    qc.invalidateQueries({ queryKey: ['pr-overview-opts'] });
  };

  const mappings = data.data?.mappings ?? [];
  const observed = data.data?.observed ?? [];
  const groups = useMemo(() => groupModels(mappings, observed), [mappings, observed]);
  const suggestions = useMemo(() => knownCanonicalNames(mappings), [mappings]);

  const add = useMutation({
    mutationFn: async (body: { aliasModel: string; canonicalModel: string }) =>
      (await api.post('/v1/admin/models/mappings', body)).data,
    onSuccess: () => {
      setError(null); setAlias(''); setCanonical('');
      invalidate();
    },
    onError: (e: any) => setError(e?.response?.data?.error ?? 'Could not save the mapping.'),
  });

  const remove = useMutation({
    mutationFn: async (aliasModel: string) =>
      (await api.delete(`/v1/admin/models/mappings/${encodeURIComponent(aliasModel)}`)).data,
    onSuccess: () => { setError(null); invalidate(); },
    onError: (e: any) => setError(e?.response?.data?.error ?? 'Could not delete the mapping.'),
  });

  const submit = () => {
    const problem = validateMapping(alias, canonical, mappings);
    if (problem) { setError(problem); return; }
    setError(null);
    add.mutate({ aliasModel: alias.trim(), canonicalModel: canonical.trim() });
  };

  const unmappedCount = observed.filter(o => !o.isMapped && o.model !== o.canonicalModel).length;
  const unusedCount = groups.reduce((n, g) => n + g.unusedMappings.length, 0);

  return (
    <div className="space-y-6">
      <section className={cardCls}>
        <header>
          <h3 className="text-sm font-semibold text-ink">Add a mapping</h3>
          <p className="mt-0.5 text-xs text-ink-tertiary">
            A model name is whatever each install reports, so one model can arrive as several spellings and
            appear as several rows. Map a reported spelling to the single name you want shown.
          </p>
        </header>

        <div className="mt-3 grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto] gap-2 items-end">
          <label className="block">
            <span className="block mb-1 text-[10px] uppercase tracking-[0.14em] text-ink-tertiary font-semibold">
              Reported today as
            </span>
            <input
              className={inputCls}
              list="observed-model-ids"
              placeholder="qwen38-27b"
              value={alias}
              onChange={e => setAlias(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            />
          </label>
          <span className="hidden sm:block pb-2 text-ink-tertiary">→</span>
          <label className="block">
            <span className="block mb-1 text-[10px] uppercase tracking-[0.14em] text-ink-tertiary font-semibold">
              Show as (desired name)
            </span>
            <input
              className={inputCls}
              list="known-canonical-names"
              placeholder="qwen3.8:27b"
              value={canonical}
              onChange={e => setCanonical(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            />
          </label>
          <button
            className={primaryBtnCls}
            disabled={add.isPending || !alias.trim() || !canonical.trim()}
            onClick={submit}
          >
            {add.isPending ? 'Saving…' : 'Add'}
          </button>
        </div>

        <datalist id="observed-model-ids">
          {observed.map(o => <option key={o.model} value={o.model} />)}
        </datalist>
        <datalist id="known-canonical-names">
          {suggestions.map(n => <option key={n} value={n} />)}
        </datalist>

        {error && (
          <p role="alert" className="mt-2 text-xs font-semibold text-red-600 dark:text-red-400">{error}</p>
        )}
        {suggestions.length > 0 && !error && (
          <p className="mt-2 text-[11px] text-ink-tertiary">
            Pick an existing desired name to add a spelling to a group that already exists, rather than
            starting a second one for the same model.
          </p>
        )}
      </section>

      <section className={cardCls}>
        <header className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink">
              Models <span className="text-ink-tertiary font-normal">({groups.length})</span>
            </h3>
            <p className="mt-0.5 text-xs text-ink-tertiary">
              Every model name shown on the dashboards, with the reported spellings folded into it.
            </p>
          </div>
          {unmappedCount > 0 && (
            <span
              className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 cursor-help"
              title="These names are each their own group. Map the ones that are really the same model."
            >
              <AlertTriangle className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />
              {unmappedCount} unmapped
            </span>
          )}
        </header>

        {data.isLoading && <p className="mt-3 text-sm text-ink-tertiary">Loading…</p>}

        {!data.isLoading && groups.length === 0 && (
          <p className="mt-3 text-sm text-ink-tertiary">No PR events with a model have been reported yet.</p>
        )}

        {unusedCount > 0 && (
          <p className="mt-2 text-[11px] text-ink-tertiary">
            {unusedCount} {unusedCount === 1 ? 'mapping is' : 'mappings are'} listed below but that spelling
            has not been reported yet — the mapping is waiting, not broken.
          </p>
        )}

        <div className="mt-3 -mx-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-tertiary font-semibold">
                <th className="px-5 py-2 text-left font-semibold">Desired name</th>
                <th className="px-5 py-2 text-left font-semibold">Mapped from</th>
                <th className="px-5 py-2 text-right font-semibold">PRs</th>
                <th className="px-5 py-2 text-left font-semibold">Mapped by</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <ModelGroupRows
                  key={g.canonicalModel}
                  group={g}
                  onDelete={(a) => {
                    if (window.confirm(`Stop mapping "${a}"? Dashboards will show it as its own model again.`)) {
                      remove.mutate(a);
                    }
                  }}
                  deleting={remove.isPending}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <ModelMetaSection
        rows={data.data?.meta ?? []}
        loading={data.isLoading}
        onError={setError}
        invalidate={invalidate}
      />
    </div>
  );
}

/**
 * Provider + license class per model, feeding the PR Overview's meta-filter.
 *
 * The table is seeded automatically on first read, so this is a list to
 * correct rather than one to build from scratch. Saving marks the row
 * admin-sourced, which is what protects it from any future seed refresh.
 */
function ModelMetaSection({ rows, loading, onError, invalidate }: {
  rows: ModelMetaRow[];
  loading: boolean;
  onError: (msg: string | null) => void;
  invalidate: () => void;
}) {
  const [query, setQuery] = useState('');
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('');
  const [license, setLicense] = useState('');
  const [licenseClass, setLicenseClass] = useState<string>('open_weights');
  const [localError, setLocalError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (body: {
      model: string; provider: string; license: string; licenseClass: string;
    }) => (await api.put('/v1/admin/models/meta', body)).data,
    onSuccess: () => {
      setLocalError(null); onError(null); setModel(''); setProvider(''); setLicense('');
      invalidate();
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.error ?? 'Could not save the model metadata.';
      setLocalError(msg); onError(msg);
    },
  });

  const remove = useMutation({
    mutationFn: async (m: string) =>
      (await api.delete(`/v1/admin/models/meta/${encodeURIComponent(m)}`)).data,
    onSuccess: () => { setLocalError(null); onError(null); invalidate(); },
    onError: (e: any) => {
      const msg = e?.response?.data?.error ?? 'Could not delete the row.';
      setLocalError(msg); onError(msg);
    },
  });

  const visible = useMemo(
    () => filterMetaRows(sortMetaRows(rows), query),
    [rows, query],
  );
  const adminCount = rows.filter(r => r.source === 'admin').length;

  const submit = () => {
    const problem = validateMetaRow({ model, provider, license, licenseClass })
      ?? (isHarnessName(model)
        ? `"${model.trim()}" is an agent runtime, not a model — it is always shown as unclassified.`
        : null);
    if (problem) { setLocalError(problem); return; }
    setLocalError(null);
    save.mutate({
      model: model.trim(), provider: provider.trim(),
      license: license.trim(), licenseClass,
    });
  };

  return (
    <section className={cardCls}>
      <header>
        <h3 className="text-sm font-semibold text-ink">
          Provider &amp; license <span className="text-ink-tertiary font-normal">({rows.length})</span>
        </h3>
        <p className="mt-0.5 text-xs text-ink-tertiary">
          Drives the PR Overview’s Provider and Weights filters. Seeded from each vendor’s
          published licence; edit a row to correct it. “Open weights” means the weights are
          downloadable — it does not mean the licence is open source.
        </p>
        {adminCount > 0 && (
          <p className="mt-1 text-[11px] text-ink-tertiary">{adminCount} edited by an admin (shown first).</p>
        )}
      </header>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-2">
        <input
          value={model} onChange={e => setModel(e.target.value)}
          placeholder="Model id, e.g. glm-5.2"
          aria-label="Model id"
          className={`${inputCls} font-mono text-[12px]`}
        />
        <input
          value={provider} onChange={e => setProvider(e.target.value)}
          placeholder="Provider, e.g. Z.ai"
          aria-label="Provider"
          className={inputCls}
        />
        <select
          value={licenseClass} onChange={e => setLicenseClass(e.target.value)}
          aria-label="License class"
          className={inputCls}
        >
          {LICENSE_CLASSES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <input
          value={license} onChange={e => setLicense(e.target.value)}
          placeholder="Licence, e.g. MIT"
          aria-label="License name"
          className={inputCls}
        />
      </div>

      <div className="mt-2 flex items-center gap-3 flex-wrap">
        <button onClick={submit} disabled={save.isPending} className={primaryBtnCls}>
          {save.isPending ? 'Saving…' : 'Save model metadata'}
        </button>
        <span className="text-[11px] text-ink-tertiary">
          Saves as an admin override. Matching is by prefix, longest first, so a specific
          id beats its family.
        </span>
      </div>

      {localError && (
        <p className="mt-2 text-[12px] text-rose-600 dark:text-rose-400">{localError}</p>
      )}

      <input
        value={query} onChange={e => setQuery(e.target.value)}
        placeholder="Filter by model, provider or licence…"
        aria-label="Filter model metadata"
        className={`mt-4 ${inputCls}`}
      />

      {loading && <p className="mt-3 text-sm text-ink-tertiary">Loading…</p>}
      {!loading && rows.length === 0 && (
        <p className="mt-3 text-sm text-ink-tertiary">No metadata rows yet.</p>
      )}

      {visible.length > 0 && (
        <div className="mt-3 -mx-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-tertiary font-semibold">
                <th className="px-5 py-2 text-left font-semibold">Model</th>
                <th className="px-5 py-2 text-left font-semibold">Provider</th>
                <th className="px-5 py-2 text-left font-semibold">Weights</th>
                <th className="px-5 py-2 text-left font-semibold">Licence</th>
                <th className="px-5 py-2 text-left font-semibold">Source</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody>
              {visible.map(r => (
                <tr key={`${r.source}:${r.model}`} className="border-t border-border-soft hover:bg-chip/50">
                  <td className="px-5 py-2 font-mono text-[12px] text-ink-secondary">{r.model}</td>
                  <td className="px-5 py-2 text-[12px] text-ink">{r.provider}</td>
                  <td className="px-5 py-2 text-[12px] text-ink-secondary">{licenseClassLabel(r.licenseClass)}</td>
                  <td className="px-5 py-2 text-[12px] text-ink-tertiary">{r.license}</td>
                  <td className="px-5 py-2 text-[11px]">
                    {r.source === 'admin'
                      ? <span className="text-accent-text">admin</span>
                      : <span className="text-ink-tertiary">seed</span>}
                  </td>
                  <td className="px-5 py-2 text-right">
                    <button
                      onClick={() => {
                        if (window.confirm(`Delete metadata for "${r.model}"? It will show as unclassified until re-added.`)) {
                          remove.mutate(r.model);
                        }
                      }}
                      disabled={remove.isPending}
                      aria-label={`Delete metadata for ${r.model}`}
                      className="text-ink-tertiary hover:text-rose-600 disabled:opacity-40"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && query && visible.length === 0 && rows.length > 0 && (
        <p className="mt-3 text-sm text-ink-tertiary">No rows match “{query}”.</p>
      )}
    </section>
  );
}

function ModelGroupRows({ group, onDelete, deleting }: {
  group: ReturnType<typeof groupModels>[number];
  onDelete: (aliasModel: string) => void;
  deleting: boolean;
}) {
  // Every row of the group is a spelling that folds into the desired name, so
  // every one of them gets an unmap control. Rendering only the tail would
  // leave a group with a single alias — the common case — with no way back.
  const rows = [
    ...group.aliases
      .filter(a => a.model !== group.canonicalModel)
      .map(a => ({
        key: a.model,
        reported: a.model,
        prs: a.prs,
        mappedAt: null as string | null,
      })),
    ...group.unusedMappings.map(mm => ({
      key: mm.aliasModel,
      reported: mm.aliasModel,
      prs: 0,
      mappedAt: mm.createdAt,
    })),
  ];

  return (
    <>
      <tr className="border-t border-border-soft">
        <td className="px-5 py-2 align-top" rowSpan={Math.max(rows.length, 1)}>
          <div className="font-mono text-[12px] font-semibold text-ink">{group.canonicalModel}</div>
          {group.createdBy && (
            <div className="mt-0.5 text-[10px] text-ink-tertiary">by {group.createdBy}</div>
          )}
        </td>
        {rows.length === 0 ? (
          <td className="px-5 py-2 text-[11px] text-ink-tertiary italic" colSpan={2}>
            Reported as this exact name — nothing mapped
          </td>
        ) : (
          <td className="px-5 py-2 text-[11px]" colSpan={2}>
            <AliasCell row={rows[0]} />
          </td>
        )}
        <td className="px-5 py-2 text-right align-top font-mono text-[12px] text-ink-secondary">
          {group.prs}
        </td>
        <td className="px-5 py-2 align-top">
          {rows.length > 0 && (
            <UnmapButton alias={rows[0].reported} onDelete={onDelete} deleting={deleting} />
          )}
        </td>
      </tr>
      {rows.slice(1).map(r => (
        <tr key={r.key} className="border-t border-border-soft/50">
          <td className="px-5 py-2 text-[11px]" colSpan={2}>
            <AliasCell row={r} indent />
          </td>
          <td />
          <td className="px-5 py-2 text-right">
            <UnmapButton alias={r.reported} onDelete={onDelete} deleting={deleting} />
          </td>
        </tr>
      ))}
    </>
  );
}

function AliasCell({ row, indent }: {
  row: { reported: string; prs: number; mappedAt: string | null };
  indent?: boolean;
}) {
  return (
    <>
      {indent && <span className="text-ink-tertiary/60 mr-1">↳</span>}
      <span className="font-mono text-ink-secondary">{row.reported}</span>
      {row.prs > 0
        ? <span className="ml-1 font-mono text-ink-secondary">{row.prs}</span>
        : <span className="ml-1 italic text-ink-tertiary">not reported yet</span>}
      {row.mappedAt && (
        <span className="ml-1 text-ink-tertiary">· mapped {fmtDate(row.mappedAt)}</span>
      )}
    </>
  );
}

function UnmapButton({ alias, onDelete, deleting }: {
  alias: string;
  onDelete: (aliasModel: string) => void;
  deleting: boolean;
}) {
  return (
    <button
      disabled={deleting}
      onClick={() => onDelete(alias)}
      className="text-ink-tertiary hover:text-red-500 disabled:opacity-40"
      title={`Unmap "${alias}"`}
    >
      <Trash2 className="w-3.5 h-3.5" />
    </button>
  );
}
