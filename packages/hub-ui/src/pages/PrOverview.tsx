import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { GitPullRequest, RefreshCw, TrendingUp, TrendingDown } from 'lucide-react';
import { api } from '../api';
import { FacetMultiselect } from '../components/FacetMultiselect';
import { shortRemote } from '../components/facetSearch';
import { useToggleSet } from '../hooks/useToggleSet';
import { fromIsoForRange, type RangeKey } from '../components/timelineAxis';
import { SIZE_META, type SizeKey, buildDayAxis, pctDelta } from '../prOverview';

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: 'today' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
];

type SizeDist = Record<SizeKey, number>;
interface PrOverviewResponse {
  period: { from: string | null; to: string | null };
  buckets: SizeKey[];
  totals: { prs: number; sizePoints: number; developers: number; medianBucket: SizeKey | null };
  resized: { count: number; grew: number; shrank: number };
  byDay: Array<{
    day: string;
    sizes: SizeDist;
    total: number;
    devBySize: Record<SizeKey, Array<{ user_key: string; count: number }>>;
  }>;
  byDeveloper: Array<{ user_key: string; prs: number; sizePoints: number; sizes: SizeDist; daily: Record<string, number> }>;
  byModel: Array<{ model: string; harnesses: string[]; prs: number; sizePoints: number; sizes: SizeDist }>;
  previous: { prs: number; sizePoints: number } | null;
}
interface ProjectsResponse { projects: string[] }

const EMPTY: SizeDist = { xs: 0, s: 0, m: 0, l: 0, xl: 0 };
// XL→XS so the stacked bar renders largest at the bottom. Hoisted out of render.
const SIZE_META_DESC = [...SIZE_META].reverse();
const colorOf = (k: SizeKey) => SIZE_META.find(s => s.key === k)!.color;

function DeltaBadge({ value }: { value: number | null }) {
  if (value == null) return <span className="text-[11px] text-slate-400">— no prior period</span>;
  const up = value >= 0;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
      {up ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {up ? '+' : ''}{value}%
    </span>
  );
}

function Tile({ label, value, children }: { label: string; value: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4">
      <div className="text-[10px] uppercase tracking-[0.14em] font-mono text-slate-400 dark:text-slate-500">{label}</div>
      <div className="mt-2 text-3xl font-bold tabular-nums text-slate-900 dark:text-slate-100">{value}</div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/** Horizontal stacked size-mix bar for one row of size counts. */
function MixBar({ sizes, total }: { sizes: SizeDist; total: number }) {
  if (total === 0) return <div className="h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800" />;
  return (
    <div className="flex h-2 w-full rounded-full overflow-hidden bg-slate-100 dark:bg-slate-800">
      {SIZE_META.filter(s => sizes[s.key] > 0).map(s => (
        <span key={s.key} title={`${s.label}: ${sizes[s.key]}`} style={{ background: s.color, width: `${(sizes[s.key] / total) * 100}%` }} />
      ))}
    </div>
  );
}

function SizeCounts({ sizes }: { sizes: SizeDist }) {
  return (
    <div className="flex gap-1">
      {SIZE_META.map(s => (
        <span
          key={s.key}
          title={`${s.label} PRs`}
          className={`min-w-[26px] text-center rounded-md px-1 py-0.5 font-mono text-[11px] tabular-nums ${sizes[s.key] === 0
            ? 'text-slate-300 dark:text-slate-600 bg-slate-50 dark:bg-slate-800/40'
            : 'text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800'}`}
        >
          {sizes[s.key]}
        </span>
      ))}
    </div>
  );
}

/** Tiny inline sparkline of daily PR counts over the period axis. */
function Sparkline({ daily, axis }: { daily: Record<string, number>; axis: string[] }) {
  const values = axis.map(d => daily[d] ?? 0);
  const w = 96, h = 24, max = Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="overflow-visible">
      <polyline points={pts} fill="none" stroke="#6366f1" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function PrOverviewPage() {
  // The URL query string is the source of truth for every filter, so a refresh
  // or a shared link restores the exact same view. State is seeded from the URL
  // on first render and written back (replace) whenever a filter changes.
  const [searchParams, setSearchParams] = useSearchParams();
  const csv = (k: string) => (searchParams.get(k) ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const urlRange = searchParams.get('range');
  const initRange = (RANGES.some(r => r.key === urlRange) ? urlRange : '30d') as RangeKey;

  const projectSel = useToggleSet(csv('projects'));
  const devSel = useToggleSet(csv('developers'));
  const [range, setRange] = useState<RangeKey>(initRange);
  const [model, setModel] = useState<string>(searchParams.get('model') ?? '');
  // Explicit date range (YYYY-MM-DD); when set it overrides the preset range.
  const [customFrom, setCustomFrom] = useState<string>(searchParams.get('from') ?? '');
  const [customTo, setCustomTo] = useState<string>(searchParams.get('to') ?? '');

  useEffect(() => {
    const p = new URLSearchParams();
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    if (devSel.set.size) p.set('developers', [...devSel.set].join(','));
    if (model) p.set('model', model);
    if (customFrom || customTo) {
      // Explicit range takes precedence over the preset in the URL too.
      if (customFrom) p.set('from', customFrom);
      if (customTo) p.set('to', customTo);
    } else if (range !== '30d') {
      p.set('range', range); // omit the default to keep the URL clean
    }
    setSearchParams(p, { replace: true });
  }, [projectSel.set, devSel.set, model, range, customFrom, customTo, setSearchParams]);

  const from = useMemo(
    () => (customFrom ? `${customFrom}T00:00:00.000Z` : fromIsoForRange(new Date(), range)),
    [customFrom, range],
  );
  // Inclusive end-of-day so a PR opened any time on `customTo` is counted.
  const toParam = customTo ? `${customTo}T23:59:59.999Z` : '';

  // Shared filters (project + date window). Model and developer are NOT here —
  // they're applied only to the data query, so the options query can list the
  // full set of models/developers available in the window.
  const baseQs = useMemo(() => {
    const p = new URLSearchParams();
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    p.set('from', from);
    if (toParam) p.set('to', toParam);
    return p;
  }, [projectSel.set, from, toParam]);

  const dataQs = useMemo(() => {
    const p = new URLSearchParams(baseQs);
    if (model) p.set('model', model);
    if (devSel.set.size) p.set('users', [...devSel.set].join(','));
    return p.toString();
  }, [baseQs, model, devSel.set]);

  const overview = useQuery<PrOverviewResponse>({
    queryKey: ['pr-overview', dataQs],
    queryFn: async () => (await api.get(`/v1/prs/overview?${dataQs}`)).data,
  });

  // Model + developer dropdown options come from the overview UNFILTERED by
  // model/developer (same project + window). When neither filter is active the
  // main `overview` already holds the full lists, so the extra request only runs
  // once a model or developer is selected.
  const filtersActive = !!model || devSel.set.size > 0;
  const optionsQuery = useQuery<PrOverviewResponse>({
    queryKey: ['pr-overview-opts', baseQs.toString()],
    queryFn: async () => (await api.get(`/v1/prs/overview?${baseQs.toString()}`)).data,
    enabled: filtersActive,
    placeholderData: prev => prev, // keep prior options during refetch — don't blank the facet
  });
  // While the unfiltered options query is still loading, fall back to the main
  // overview so the Developer/Model controls (and the selected chip) never vanish.
  const optionsData = (filtersActive ? optionsQuery.data : overview.data) ?? overview.data;
  const modelOptions = optionsData?.byModel.map(m => m.model) ?? [];
  const devOptions = optionsData?.byDeveloper.map(x => x.user_key) ?? [];
  const projects = useQuery<ProjectsResponse>({ queryKey: ['projects'], queryFn: async () => (await api.get('/v1/projects')).data });

  // Picking a preset clears any explicit date range so the two don't fight.
  const pickRange = (r: RangeKey) => { setRange(r); setCustomFrom(''); setCustomTo(''); };

  const d = overview.data;
  const to = d?.period.to ?? (toParam || new Date().toISOString());
  const axis = useMemo(() => (d ? buildDayAxis(from, to) : []), [d, from, to]);
  const maxDayTotal = Math.max(1, ...(d?.byDay.map(x => x.total) ?? [1]));
  const byDayMap = useMemo(() => new Map((d?.byDay ?? []).map(x => [x.day, x])), [d]);

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-indigo-600 dark:text-indigo-400 font-semibold">Analytics</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <GitPullRequest className="w-6 h-6 text-indigo-500" /> PR Overview
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Pull requests per developer, weighted by size — for the selected period, with a daily breakdown.</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            className="text-[12px] font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 px-2.5 py-1.5"
          >
            <option value="">All models</option>
            {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-0.5 text-[11px] font-medium">
            {RANGES.map(r => {
              const active = !customFrom && !customTo && range === r.key;
              return (
                <button
                  key={r.key}
                  onClick={() => pickRange(r.key)}
                  className={`px-2.5 py-1 rounded-md transition-colors ${active
                    ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
          <div className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
            <input
              type="date"
              value={customFrom}
              max={customTo || undefined}
              onChange={e => setCustomFrom(e.target.value)}
              aria-label="From date"
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 px-2 py-1"
            />
            <span>→</span>
            <input
              type="date"
              value={customTo}
              min={customFrom || undefined}
              onChange={e => setCustomTo(e.target.value)}
              aria-label="To date"
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 px-2 py-1"
            />
            {(customFrom || customTo) && (
              <button
                onClick={() => { setCustomFrom(''); setCustomTo(''); }}
                className="ml-0.5 px-1.5 py-1 rounded-md text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                title="Clear date range"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </header>

      <FacetMultiselect
        label="Project (git remote)"
        options={projects.data?.projects ?? []}
        selected={projectSel.set}
        onToggle={projectSel.toggle}
        onClear={projectSel.clear}
        optionLabel={shortRemote}
        inlineThreshold={6}
        placeholder="Search projects…"
      />

      <FacetMultiselect
        label="Developer"
        options={devOptions}
        selected={devSel.set}
        onToggle={devSel.toggle}
        onClear={devSel.clear}
        inlineThreshold={6}
        placeholder="Search developers…"
      />

      {overview.isLoading && <div className="text-sm text-slate-500 py-8 text-center">Loading…</div>}
      {d && d.totals.prs === 0 && (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-5 py-10 text-center text-sm text-slate-500">
          No PRs registered for this project and period.
        </div>
      )}

      {d && d.totals.prs > 0 && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Tile label="Total PRs" value={d.totals.prs}>
              <DeltaBadge value={d.previous ? pctDelta(d.totals.prs, d.previous.prs) : null} />
            </Tile>
            <Tile label="Weighted size" value={<span>{d.totals.sizePoints}</span>}>
              <span className="text-[11px] text-slate-400">size points</span>
            </Tile>
            <Tile label="Active developers" value={d.totals.developers}>
              <span className="text-[11px] text-slate-400">{(d.totals.prs / Math.max(1, d.totals.developers)).toFixed(1)} PRs / dev</span>
            </Tile>
            <Tile label="Median size" value={<span className="uppercase">{d.totals.medianBucket ?? '—'}</span>}>
              <span className="text-[11px] text-slate-400">across {d.totals.prs} PRs</span>
            </Tile>
          </div>

          {/* Resize strip */}
          {d.resized.count > 0 && (
            <div className="flex items-center gap-3 flex-wrap rounded-xl border border-slate-200 dark:border-slate-800 border-l-[3px] border-l-indigo-500 bg-gradient-to-r from-indigo-50/60 to-transparent dark:from-indigo-900/20 px-4 py-3">
              <RefreshCw className="w-4 h-4 text-indigo-500" />
              <span className="text-[13px] text-slate-600 dark:text-slate-300">
                <b className="text-slate-900 dark:text-slate-100">{d.resized.count} PRs re-sized</b> this period —{' '}
                <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{d.resized.grew} grew ↑</span>,{' '}
                <span className="text-rose-600 dark:text-rose-400 font-semibold">{d.resized.shrank} shrank ↓</span>.
              </span>
              <span className="ml-auto text-[11px] text-slate-400">Each PR counts once, at its latest sizing.</span>
            </div>
          )}

          {/* Daily stacked bar */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
            <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
              <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Daily PR volume by size</h2>
              <div className="flex gap-3 flex-wrap">
                {SIZE_META.map(s => (
                  <span key={s.key} className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                    <span className="w-3 h-3 rounded-sm" style={{ background: s.color }} /> {s.label}
                  </span>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <div className="flex items-end gap-1.5 h-44 min-w-[420px]">
                {axis.map(day => {
                  const entry = byDayMap.get(day);
                  const sizes = entry?.sizes ?? EMPTY;
                  const total = entry?.total ?? 0;
                  const sliceTitle = (key: SizeKey, label: string) => {
                    const devs = entry?.devBySize?.[key] ?? [];
                    const head = `${label} · ${day} · ${sizes[key]} PR${sizes[key] === 1 ? '' : 's'}`;
                    const lines = devs.map(x => `  ${x.user_key}: ${x.count}`).join('\n');
                    return lines ? `${head}\n${lines}` : head;
                  };
                  return (
                    <div key={day} className="flex-1 flex flex-col justify-end gap-0.5 h-full group" title={`${day}: ${total} PR${total === 1 ? '' : 's'}`}>
                      {SIZE_META_DESC.filter(s => sizes[s.key] > 0).map(s => (
                        <div
                          key={s.key}
                          style={{ background: s.color, height: `${(sizes[s.key] / maxDayTotal) * 100}%` }}
                          className="rounded-[2px] hover:opacity-80 transition-opacity cursor-default"
                          title={sliceTitle(s.key, s.label)}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-1.5 mt-2 min-w-[420px]">
                {axis.map((day, i) => (
                  <div key={day} className="flex-1 text-center font-mono text-[9px] text-slate-400">
                    {i % Math.ceil(axis.length / 10 || 1) === 0 ? day.slice(5) : ''}
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* By developer */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
              <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">By developer</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase tracking-[0.08em] text-slate-400">
                    <th className="px-5 py-2 font-semibold">Developer</th>
                    <th className="px-3 py-2 font-semibold text-right">PRs</th>
                    <th className="px-3 py-2 font-semibold w-[180px]">Size mix</th>
                    <th className="px-3 py-2 font-semibold">XS · S · M · L · XL</th>
                    <th className="px-5 py-2 font-semibold text-right">Trend</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {d.byDeveloper.map(dev => (
                    <tr key={dev.user_key} className="hover:bg-indigo-50/30 dark:hover:bg-indigo-900/10 transition-colors">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                            {dev.user_key.slice(0, 2).toUpperCase()}
                          </div>
                          <span className="font-mono text-[12px] text-slate-700 dark:text-slate-200 truncate max-w-[200px]">{dev.user_key}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-lg font-bold text-slate-900 dark:text-slate-100">{dev.prs}</td>
                      <td className="px-3 py-3"><MixBar sizes={dev.sizes} total={dev.prs} /></td>
                      <td className="px-3 py-3"><SizeCounts sizes={dev.sizes} /></td>
                      <td className="px-5 py-3 text-right"><div className="inline-block"><Sparkline daily={dev.daily} axis={axis} /></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* By model */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
              <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">By model</h2>
              <p className="text-[11px] text-slate-500 mt-0.5">Which agent runtime opened the PRs.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase tracking-[0.08em] text-slate-400">
                    <th className="px-5 py-2 font-semibold">Model</th>
                    <th className="px-3 py-2 font-semibold text-right">PRs</th>
                    <th className="px-3 py-2 font-semibold w-[180px]">Size mix</th>
                    <th className="px-5 py-2 font-semibold text-right">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {d.byModel.map(m => (
                    <tr key={m.model} className="hover:bg-indigo-50/30 dark:hover:bg-indigo-900/10 transition-colors">
                      <td className="px-5 py-3">
                        <div className="font-mono text-[12px] text-slate-700 dark:text-slate-200">{m.model}</div>
                        {m.harnesses.length > 0 && <div className="text-[10px] text-slate-400">via {m.harnesses.join(', ')}</div>}
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-lg font-bold text-slate-900 dark:text-slate-100">{m.prs}</td>
                      <td className="px-3 py-3"><MixBar sizes={m.sizes} total={m.prs} /></td>
                      <td className="px-5 py-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">{Math.round((m.prs / d.totals.prs) * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Per developer per day heatmap */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-1">Per developer, per day</h2>
            <p className="text-[11px] text-slate-500 mb-4">Cell shade = PRs opened that day.</p>
            <div className="overflow-x-auto">
              <div className="space-y-1 min-w-[560px]">
                {d.byDeveloper.map(dev => {
                  const max = Math.max(1, ...axis.map(day => dev.daily[day] ?? 0));
                  return (
                    <div key={dev.user_key} className="grid items-center gap-2" style={{ gridTemplateColumns: '150px 1fr' }}>
                      <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 truncate">{dev.user_key}</span>
                      <div className="flex gap-1">
                        {axis.map(day => {
                          const c = dev.daily[day] ?? 0;
                          const intensity = c === 0 ? 0 : 0.25 + (c / max) * 0.7;
                          return (
                            <div
                              key={day}
                              title={`${dev.user_key} · ${day}: ${c} PRs`}
                              className="flex-1 aspect-square rounded-[3px] min-w-[10px] max-w-[40px]"
                              style={{ background: c === 0 ? undefined : `rgba(99,102,241,${intensity.toFixed(2)})` }}
                            >
                              {c === 0 && <div className="w-full h-full rounded-[3px] bg-slate-100 dark:bg-slate-800" />}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {/* Size model explainer */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-3">How size is derived</h2>
            <div className="font-mono text-[13px] rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 px-4 py-3 text-slate-700 dark:text-slate-200">
              <span className="text-slate-400">// count leaves — the unit of work in each branch</span><br />
              <span className="text-indigo-600 dark:text-indigo-400">size_points</span> = leafStory·<b>4</b> + task·<b>2</b> + bug·<b>1</b>
            </div>
            <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-3 max-w-2xl">
              An Epic rolls up its Stories, and a Story rolls up its Tasks &amp; Bugs — so summing all four tiers
              double-counts. We size by the atomic deliverables; a Story with no subtasks is itself a leaf and scores ×4.
              A later re-size re-buckets the same PR (it never adds a second one), and the PR is attributed to its opener.
            </p>
            <div className="flex gap-2 flex-wrap mt-3 text-[11px] font-mono">
              {[{ b: 'XS', r: '0–2' }, { b: 'S', r: '3–6' }, { b: 'M', r: '7–14' }, { b: 'L', r: '15–30' }, { b: 'XL', r: '31+' }].map((x, i) => (
                <span key={x.b} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ background: colorOf(SIZE_META[i].key) }} />
                  <b>{x.b}</b> <span className="text-slate-400">{x.r} pts</span>
                </span>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
