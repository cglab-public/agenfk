import { Link } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, GitBranch } from 'lucide-react';
import { api } from '../api';
import { TimelineBar } from '../components/TimelineBar';
import { FacetMultiselect } from '../components/FacetMultiselect';
import { MetricsTilesRow, MetricsTotals } from '../components/MetricsTilesRow';
import { shortRemote } from '../components/facetSearch';
import { mergeEventTypes } from '../eventTypes';
import { fmtRelative } from '../dates';
import { useToggleSet } from '../hooks/useToggleSet';
import { fromIsoForRange, type RangeKey } from '../components/timelineAxis';

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: 'today' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
];

interface MetricsResponse { bucket: string; series: Array<{ user_key: string; day: string; events_count: number; items_closed: number; validate_passes: number; validate_fails: number; prs_opened: number }> }
interface UsersResponse { user_key: string; last_seen: string; events_count: number }
interface EventTypesResponse { types: string[] }
interface ProjectsResponse { projects: string[] }
interface ItemTypesResponse { itemTypes: string[]; counts?: Record<string, number> }

const KNOWN_ITEM_TYPES = ['EPIC', 'STORY', 'TASK', 'BUG'] as const;

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

const formatLastSeen = fmtRelative;

export function OrgPage() {
  // Default to "shipped today/this week" framing — answers the most common
  // org-level question without requiring a click. Persisted in localStorage
  // so a refresh doesn't drop the user's hand-tuned filter back to default.
  const eventTypeSel = useToggleSet(['item.closed'], { storageKey: 'agenfk-hub:org:eventTypes' });
  const projectSel = useToggleSet([], { storageKey: 'agenfk-hub:org:projects' });
  const itemTypeSel = useToggleSet([], { storageKey: 'agenfk-hub:org:itemTypes' });
  const [range, setRange] = useState<RangeKey>('30d');

  // Build the query string once for everything that needs the same filters.
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    if (itemTypeSel.set.size) p.set('itemTypes', [...itemTypeSel.set].join(','));
    p.set('from', fromIsoForRange(new Date(), range));
    return p.toString();
  }, [projectSel.set, itemTypeSel.set, range]);

  // For per-itemType counts we honour project + event-type selections but
  // intentionally drop the itemTypes filter — the chip count answers
  // "what would I see if I picked this", which is meaningless if we
  // pre-filter by the active selection.
  const itemTypesQs = useMemo(() => {
    const p = new URLSearchParams();
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    if (eventTypeSel.set.size) p.set('types', [...eventTypeSel.set].join(','));
    return p.toString();
  }, [projectSel.set, eventTypeSel.set]);

  const metrics = useQuery<MetricsResponse>({
    queryKey: ['metrics', qs],
    queryFn: async () => (await api.get(`/v1/metrics${qs ? `?${qs}` : ''}`)).data,
  });
  const users = useQuery<UsersResponse[]>({
    queryKey: ['users', qs],
    queryFn: async () => (await api.get(`/v1/users${qs ? `?${qs}` : ''}`)).data,
  });
  const eventTypes = useQuery<EventTypesResponse>({ queryKey: ['event-types'], queryFn: async () => (await api.get('/v1/event-types')).data });
  const projects = useQuery<ProjectsResponse>({ queryKey: ['projects'], queryFn: async () => (await api.get('/v1/projects')).data });
  const itemTypes = useQuery<ItemTypesResponse>({
    queryKey: ['item-types', itemTypesQs],
    queryFn: async () => (await api.get(`/v1/item-types${itemTypesQs ? `?${itemTypesQs}` : ''}`)).data,
  });

  const totals: MetricsTotals = (metrics.data?.series ?? []).reduce(
    (a, r) => ({
      events: a.events + r.events_count,
      closed: a.closed + r.items_closed,
      passes: a.passes + r.validate_passes,
      fails: a.fails + r.validate_fails,
      prsOpened: a.prsOpened + (r.prs_opened ?? 0),
    }),
    { events: 0, closed: 0, passes: 0, fails: 0, prsOpened: 0 },
  );

  const types = mergeEventTypes(eventTypes.data?.types);
  const projectOptions = projects.data?.projects ?? [];
  const itemTypeOptions = useMemo(() => {
    const set = new Set<string>(KNOWN_ITEM_TYPES);
    for (const t of itemTypes.data?.itemTypes ?? []) set.add(t);
    return [...set].sort();
  }, [itemTypes.data]);

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.18em] text-indigo-600 dark:text-indigo-400 font-semibold">Dashboard</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Organization rollup</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Fleet-wide AgEnFK activity across every connected installation.</p>
      </header>

      <MetricsTilesRow totals={totals} />

      <section className="space-y-4 p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl">
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-indigo-500" />
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Filters</h2>
          <span className="text-[11px] text-slate-500">all queries below honor these</span>
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
        <div>
          <h3 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-slate-500 dark:text-slate-400 mb-1.5">Period</h3>
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-0.5 text-[11px] font-medium">
            {RANGES.map(r => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={`px-2.5 py-1 rounded-md transition-colors ${range === r.key
                  ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <TimelineBar
        types={[...eventTypeSel.set]}
        projects={[...projectSel.set]}
        itemTypes={[...itemTypeSel.set]}
        title="Activity timeline"
        range={range}
        onRangeChange={setRange}
      />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Users</h2>
          <span className="text-[11px] text-slate-500">{users.data?.length ?? 0} reporting</span>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl divide-y divide-slate-100 dark:divide-slate-800 overflow-hidden">
          {(users.data ?? []).map(u => (
            <Link
              key={u.user_key}
              to={`/users/${encodeURIComponent(u.user_key)}`}
              className="group flex items-center justify-between gap-3 px-5 py-3 hover:bg-indigo-50/40 dark:hover:bg-indigo-900/10 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0">
                  {u.user_key.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="font-mono text-[13px] text-slate-800 dark:text-slate-200 truncate group-hover:text-indigo-700 dark:group-hover:text-indigo-300 transition-colors">{u.user_key}</div>
                  <div className="text-[11px] text-slate-500">{u.events_count.toLocaleString()} events · last {formatLastSeen(u.last_seen)}</div>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-indigo-500 transition-colors shrink-0" />
            </Link>
          ))}
          {users.data?.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-slate-500">No users match the current filters.</div>
          )}
        </div>
      </section>
    </div>
  );
}
