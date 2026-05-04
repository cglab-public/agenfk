import { Link, useParams } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, GitBranch } from 'lucide-react';
import { api } from '../api';
import { TimelineBar } from '../components/TimelineBar';
import { FacetMultiselect } from '../components/FacetMultiselect';
import { shortRemote } from '../components/facetSearch';
import { mergeEventTypes } from '../eventTypes';
import { fmtDateTime, browserTimezone } from '../dates';

interface TimelineRow {
  event_id: string; occurred_at: string; type: string; project_id: string | null; item_id: string | null; item_type: string | null; remote_url: string | null; item_title: string | null; external_id: string | null; user_key: string; payload: any;
}
interface EventTypesResponse { types: string[] }
interface ProjectsResponse { projects: string[] }
interface ItemTypesResponse { itemTypes: string[]; counts?: Record<string, number> }

const KNOWN_ITEM_TYPES = ['EPIC', 'STORY', 'TASK', 'BUG'] as const;

const formatTime = fmtDateTime;

const TYPE_BADGE: Record<string, string> = {
  'item.created':       'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800',
  'item.updated':       'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800',
  'item.moved':         'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800',
  'step.transitioned':  'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  'validate.invoked':   'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  'validate.passed':    'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  'validate.failed':    'bg-rose-50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
  'comment.added':      'bg-pink-50 dark:bg-pink-900/30 text-pink-700 dark:text-pink-300 border-pink-200 dark:border-pink-800',
  'tokens.logged':      'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300 border-cyan-200 dark:border-cyan-800',
  'test.logged':        'bg-yellow-50 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800',
  'item.closed':        'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  'item.deleted':       'bg-rose-50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
};
const DEFAULT_BADGE = 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700';

const ITEM_TYPE_BADGE: Record<string, string> = {
  EPIC:  'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800',
  STORY: 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800',
  TASK:  'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  BUG:   'bg-rose-50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
};

function ChipRow({ label, options, selected, onToggle, onClear, optionLabel }: {
  label: string;
  options: string[];
  selected: Set<string>;
  onToggle: (v: string) => void;
  onClear: () => void;
  optionLabel?: (v: string) => string;
}) {
  if (options.length === 0) return null;
  return (
    <div>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-slate-500 dark:text-slate-400">{label}</h3>
        {selected.size > 0 && (
          <button onClick={onClear} className="text-[11px] font-medium text-slate-500 hover:text-rose-600 dark:hover:text-rose-400">
            Clear ({selected.size})
          </button>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {options.map(t => {
          const on = selected.has(t);
          return (
            <button
              key={t}
              onClick={() => onToggle(t)}
              title={t}
              className={`px-2.5 py-1 rounded-full font-mono text-[11px] border transition-colors max-w-[260px] truncate ${on
                ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm'
                : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-300 hover:text-indigo-700 dark:hover:text-indigo-300'}`}
            >
              {optionLabel ? optionLabel(t) : t}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function useToggleSet(initial: Iterable<string> = []) {
  const [s, setS] = useState<Set<string>>(() => new Set(initial));
  return {
    set: s,
    toggle: (v: string) => setS(prev => { const n = new Set(prev); n.has(v) ? n.delete(v) : n.add(v); return n; }),
    clear: () => setS(new Set()),
  };
}

export function UserDetailPage() {
  const { userKey = '' } = useParams();
  const decoded = decodeURIComponent(userKey);
  // Default to "what did this user ship?" — closures only — until the dev
  // widens the chip selection.
  const eventTypeSel = useToggleSet(['item.closed']);
  const projectSel = useToggleSet();
  const itemTypeSel = useToggleSet();

  const eventTypes = useQuery<EventTypesResponse>({
    queryKey: ['event-types'],
    queryFn: async () => (await api.get('/v1/event-types')).data,
  });
  const projects = useQuery<ProjectsResponse>({ queryKey: ['projects'], queryFn: async () => (await api.get('/v1/projects')).data });

  // Per-itemType counts honour the user, project, and event-type filters but
  // ignore the itemTypes filter (the chip answers "what would I see if I
  // selected this", which can't pre-filter by the current selection).
  const itemTypesQs = useMemo(() => {
    const p = new URLSearchParams();
    p.set('users', decoded);
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    if (eventTypeSel.set.size) p.set('types', [...eventTypeSel.set].join(','));
    return p.toString();
  }, [decoded, projectSel.set, eventTypeSel.set]);
  const itemTypes = useQuery<ItemTypesResponse>({
    queryKey: ['item-types', itemTypesQs],
    queryFn: async () => (await api.get(`/v1/item-types?${itemTypesQs}`)).data,
  });

  const params = new URLSearchParams();
  params.set('users', decoded);
  if (eventTypeSel.set.size) params.set('types', [...eventTypeSel.set].join(','));
  if (projectSel.set.size) params.set('projects', [...projectSel.set].join(','));
  if (itemTypeSel.set.size) params.set('itemTypes', [...itemTypeSel.set].join(','));
  params.set('limit', '200');

  const tl = useQuery<{ events: TimelineRow[] }>({
    queryKey: ['timeline', userKey, [...eventTypeSel.set].sort().join(','), [...projectSel.set].sort().join(','), [...itemTypeSel.set].sort().join(',')],
    queryFn: async () => (await api.get(`/v1/timeline?${params}`)).data,
  });

  const types = mergeEventTypes(eventTypes.data?.types);
  const projectOptions = projects.data?.projects ?? [];
  const itemTypeOptions = useMemo(() => {
    const set = new Set<string>(KNOWN_ITEM_TYPES);
    for (const t of itemTypes.data?.itemTypes ?? []) set.add(t);
    return [...set].sort();
  }, [itemTypes.data]);

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <Link to="/" className="inline-flex items-center gap-1.5 text-[12px] text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to org
      </Link>

      <header className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white text-base font-bold flex items-center justify-center shadow-sm">
          {decoded.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.18em] text-indigo-600 dark:text-indigo-400 font-semibold">User</p>
          <h1 className="mt-0.5 text-xl font-bold tracking-tight font-mono text-slate-900 dark:text-slate-100 truncate">{decoded}</h1>
        </div>
      </header>

      <section className="space-y-4 p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl">
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-indigo-500" />
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Filters</h2>
        </div>
        <FacetMultiselect
          label="Project (git remote)"
          options={projectOptions}
          selected={projectSel.set}
          onToggle={projectSel.toggle}
          onClear={projectSel.clear}
          optionLabel={shortRemote}
          inlineThreshold={6}
          placeholder="Search projects…"
        />
        <ChipRow
          label="Item type"
          options={itemTypeOptions}
          selected={itemTypeSel.set}
          onToggle={itemTypeSel.toggle}
          onClear={itemTypeSel.clear}
          optionLabel={(t) => {
            const n = itemTypes.data?.counts?.[t];
            return n == null ? t : `${t} (${n})`;
          }}
        />
        <ChipRow label="Event type" options={types} selected={eventTypeSel.set} onToggle={eventTypeSel.toggle} onClear={eventTypeSel.clear} />
      </section>

      <TimelineBar
        users={[decoded]}
        types={[...eventTypeSel.set]}
        projects={[...projectSel.set]}
        itemTypes={[...itemTypeSel.set]}
        title="Activity timeline"
      />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Recent events</h2>
          <span className="text-[11px] text-slate-500" title={`All times in ${browserTimezone()}`}>{tl.data?.events.length ?? 0} shown · times in {browserTimezone()}</span>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl divide-y divide-slate-100 dark:divide-slate-800 overflow-hidden">
          {(tl.data?.events ?? []).map(e => {
            const badge = TYPE_BADGE[e.type] ?? DEFAULT_BADGE;
            const itemBadge = e.item_type ? (ITEM_TYPE_BADGE[e.item_type] ?? DEFAULT_BADGE) : null;
            return (
              <details key={e.event_id} className="group">
                <summary className="flex items-center gap-3 px-5 py-2.5 cursor-pointer list-none hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400 group-open:rotate-180 transition-transform shrink-0" />
                  <span className={`px-2 py-0.5 rounded-md text-[10px] font-mono border ${badge}`}>{e.type}</span>
                  {itemBadge && <span className={`px-2 py-0.5 rounded-md text-[10px] font-mono border ${itemBadge}`}>{e.item_type}</span>}
                  {e.external_id && (
                    <span title={`External tracker: ${e.external_id}`} className="px-2 py-0.5 rounded-md text-[10px] font-mono bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                      {e.external_id}
                    </span>
                  )}
                  {e.remote_url && (
                    <span title={e.remote_url} className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 max-w-[180px] truncate">
                      <GitBranch className="w-2.5 h-2.5 shrink-0" /> {shortRemote(e.remote_url)}
                    </span>
                  )}
                  <span className="text-[12px] text-slate-800 dark:text-slate-200 truncate flex-1" title={e.item_id ?? undefined}>
                    {e.item_title ?? <span className="text-slate-400 font-mono">{e.item_id ?? e.project_id ?? '—'}</span>}
                  </span>
                  <span className="text-[11px] text-slate-400 tabular-nums shrink-0">{formatTime(e.occurred_at)}</span>
                </summary>
                <pre className="px-5 pb-3 text-[11px] font-mono text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-words bg-slate-50/60 dark:bg-slate-950/40 border-t border-slate-100 dark:border-slate-800 -mt-0.5">{JSON.stringify(e.payload, null, 2)}</pre>
              </details>
            );
          })}
          {tl.data?.events.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-slate-500">No events match the current filters.</div>
          )}
        </div>
      </section>
    </div>
  );
}
