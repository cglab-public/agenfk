import { Link } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, CheckCircle2, XCircle, Inbox, Coins, ArrowRightLeft, ChevronRight, GitBranch } from 'lucide-react';
import { api } from '../api';
import { TimelineBar } from '../components/TimelineBar';
import { mergeEventTypes } from '../eventTypes';

interface MetricsResponse { bucket: string; series: Array<{ user_key: string; day: string; events_count: number; items_closed: number; tokens_in: number; tokens_out: number; validate_passes: number; validate_fails: number }> }
interface UsersResponse { user_key: string; last_seen: string; events_count: number }
interface EventTypesResponse { types: string[] }
interface ProjectsResponse { projects: string[] }
interface ItemTypesResponse { itemTypes: string[] }

const KNOWN_ITEM_TYPES = ['EPIC', 'STORY', 'TASK', 'BUG'] as const;

function shortRemote(remote: string): string {
  // git@github.com:acme/web.git → acme/web ; https://github.com/acme/web.git → acme/web
  const m = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : remote;
}

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

interface TileProps { label: string; value: number; icon: React.ReactNode; tone: string }
function Tile({ label, value, icon, tone }: TileProps) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl px-5 py-4 hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-sm transition-all">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">{label}</span>
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${tone}`}>{icon}</span>
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">{value.toLocaleString()}</div>
    </div>
  );
}

function formatLastSeen(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const m = 60_000, h = 3600_000, d = 86400_000;
  if (diff < m) return 'just now';
  if (diff < h) return `${Math.floor(diff / m)}m ago`;
  if (diff < d) return `${Math.floor(diff / h)}h ago`;
  if (diff < 30 * d) return `${Math.floor(diff / d)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function useToggleSet() {
  const [s, setS] = useState<Set<string>>(new Set());
  return {
    set: s,
    toggle: (v: string) => setS(prev => { const n = new Set(prev); n.has(v) ? n.delete(v) : n.add(v); return n; }),
    clear: () => setS(new Set()),
  };
}

export function OrgPage() {
  const eventTypeSel = useToggleSet();
  const projectSel = useToggleSet();
  const itemTypeSel = useToggleSet();

  // Build the query string once for everything that needs the same filters.
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    if (itemTypeSel.set.size) p.set('itemTypes', [...itemTypeSel.set].join(','));
    return p.toString();
  }, [projectSel.set, itemTypeSel.set]);

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
  const itemTypes = useQuery<ItemTypesResponse>({ queryKey: ['item-types'], queryFn: async () => (await api.get('/v1/item-types')).data });

  const totals = (metrics.data?.series ?? []).reduce(
    (a, r) => ({
      events: a.events + r.events_count,
      closed: a.closed + r.items_closed,
      tokensIn: a.tokensIn + r.tokens_in,
      tokensOut: a.tokensOut + r.tokens_out,
      passes: a.passes + r.validate_passes,
      fails: a.fails + r.validate_fails,
    }),
    { events: 0, closed: 0, tokensIn: 0, tokensOut: 0, passes: 0, fails: 0 },
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

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Tile label="Events"      value={totals.events}    icon={<Activity className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />} tone="bg-indigo-50 dark:bg-indigo-900/30" />
        <Tile label="Closed"      value={totals.closed}    icon={<Inbox className="w-4 h-4 text-violet-600 dark:text-violet-400" />} tone="bg-violet-50 dark:bg-violet-900/30" />
        <Tile label="Tokens in"   value={totals.tokensIn}  icon={<Coins className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />} tone="bg-cyan-50 dark:bg-cyan-900/30" />
        <Tile label="Tokens out"  value={totals.tokensOut} icon={<ArrowRightLeft className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />} tone="bg-cyan-50 dark:bg-cyan-900/30" />
        <Tile label="Validate ✓"  value={totals.passes}    icon={<CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />} tone="bg-emerald-50 dark:bg-emerald-900/30" />
        <Tile label="Validate ✗"  value={totals.fails}     icon={<XCircle className="w-4 h-4 text-rose-600 dark:text-rose-400" />} tone="bg-rose-50 dark:bg-rose-900/30" />
      </div>

      <section className="space-y-4 p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl">
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-indigo-500" />
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Filters</h2>
          <span className="text-[11px] text-slate-500">all queries below honor these</span>
        </div>
        <ChipRow label="Project (git remote)" options={projectOptions} selected={projectSel.set} onToggle={projectSel.toggle} onClear={projectSel.clear} optionLabel={shortRemote} />
        <ChipRow label="Item type" options={itemTypeOptions} selected={itemTypeSel.set} onToggle={itemTypeSel.toggle} onClear={itemTypeSel.clear} />
        <ChipRow label="Event type" options={types} selected={eventTypeSel.set} onToggle={eventTypeSel.toggle} onClear={eventTypeSel.clear} />
      </section>

      <TimelineBar
        types={[...eventTypeSel.set]}
        projects={[...projectSel.set]}
        itemTypes={[...itemTypeSel.set]}
        title="Activity timeline"
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
