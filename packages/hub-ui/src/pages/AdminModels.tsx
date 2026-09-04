import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { api } from '../api';
import {
  groupModels, validateMapping, knownCanonicalNames,
  MappingRow, ObservedModel,
} from './modelMappings';
import { ModelMetaRow } from './adminModelMeta';
import { ModelTable } from '../components/ModelTable';

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

      <ModelTable
        groups={groups}
        metaRows={data.data?.meta ?? []}
        loading={data.isLoading}
        onError={setError}
        invalidate={invalidate}
        onUnmap={(alias) => {
          if (window.confirm(`Stop mapping "${alias}"? Dashboards will show it as its own model again.`)) {
            remove.mutate(alias);
          }
        }}
        unmapping={remove.isPending}
        unmappedCount={unmappedCount}
        unusedCount={unusedCount}
      />
    </div>
  );
}
