import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { GitPullRequest, RefreshCw, TrendingUp, TrendingDown } from 'lucide-react';
import { api } from '../api';
import { FacetMultiselect } from '../components/FacetMultiselect';
import { shortRemote } from '../components/facetSearch';
import { useToggleSet } from '../hooks/useToggleSet';
import { fromIsoForRange, type RangeKey } from '../components/timelineAxis';
import { SIZE_META, type SizeKey, buildDayAxis, pctDelta } from '../prOverview';
import { buildMonthBands, dayHeaderInfo, contributionPcts, cellTooltip, placeTooltip } from '../prPerDay';

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
  // CGLAB-131 drill-down: the resolved PR set behind the heatmap cells
  // (opener attribution, latest sizing — same aggregation pass as the totals).
  prs: Array<{
    repo: string;
    prNumber: number;
    url: string | null;
    user_key: string;
    model: string;
    harness: string | null;
    openedAt: string;
    day: string;
    points: number;
    bucket: SizeKey;
  }>;
  previous: { prs: number; sizePoints: number } | null;
}
interface ProjectsResponse { projects: string[] }

const EMPTY: SizeDist = { xs: 0, s: 0, m: 0, l: 0, xl: 0 };
// XL→XS so the stacked bar renders largest at the bottom. Hoisted out of render.
const SIZE_META_DESC = [...SIZE_META].reverse();
const colorOf = (k: SizeKey) => SIZE_META.find(s => s.key === k)!.color;

function DeltaBadge({ value }: { value: number | null }) {
  if (value == null) return <span className="text-[11px] text-ink-tertiary">— no prior period</span>;
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
    <div className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-4">
      <div className="text-[10px] uppercase tracking-[0.14em] font-mono text-ink-tertiary">{label}</div>
      <div className="mt-2 text-3xl font-bold tabular-nums text-ink">{value}</div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/** Horizontal stacked size-mix bar for one row of size counts. */
function MixBar({ sizes, total }: { sizes: SizeDist; total: number }) {
  if (total === 0) return <div className="h-2 w-full rounded-full bg-chip" />;
  return (
    <div className="flex h-2 w-full rounded-full overflow-hidden bg-chip">
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
            ? 'text-ink-tertiary bg-chip'
            : 'text-ink-secondary bg-chip'}`}
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
      <polyline points={pts} fill="none" stroke="#04cc98" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** CGLAB-131 — the per-cell drill-down: the PRs one developer opened on one
 *  day, with a GitHub link where the server could derive one. Rendered at the
 *  page root (fixed positioning — same containing-block rule as the tooltip). */
function PrDrilldownModal({ dev, day, prs, onClose }: {
  dev: string;
  day: string;
  prs: NonNullable<PrOverviewResponse['prs']>;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const { weekday } = dayHeaderInfo(day);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`PRs by ${dev} on ${day}`}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-50 w-full max-w-xl max-h-[70vh] overflow-y-auto rounded-2xl border border-border-soft bg-surface shadow-2xl">
        <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-border-soft bg-surface px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-ink">{dev}</h3>
            <p className="font-mono text-[11px] text-ink-tertiary">{weekday} {day} · {prs.length} PR{prs.length === 1 ? '' : 's'}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg border border-border-soft px-2 py-1 text-[12px] text-ink-tertiary hover:text-ink hover:bg-chip transition-colors"
          >
            ✕
          </button>
        </div>
        <ul className="divide-y divide-border-soft">
          {prs.map(p => {
            const size = SIZE_META.find(s => s.key === p.bucket);
            const openedAt = new Date(p.openedAt);
            return (
              <li key={`${p.repo}#${p.prNumber}`} className="flex items-center gap-3 px-5 py-2.5">
                {p.url ? (
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[13px] font-bold text-accent-text hover:underline shrink-0"
                    title="Open on GitHub"
                  >
                    #{p.prNumber}
                  </a>
                ) : (
                  <span className="font-mono text-[13px] font-bold text-ink-secondary shrink-0" title={`${p.repo} — no GitHub link (non-GitHub host)`}>
                    #{p.prNumber}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12px] text-ink-secondary">{p.repo}</div>
                  <div className="text-[11px] text-ink-tertiary truncate">{p.model}{p.harness ? ` · via ${p.harness}` : ''}</div>
                </div>
                <div className="text-right shrink-0">
                  {size && (
                    <span className="inline-block rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold text-white" style={{ background: size.color }}>
                      {size.label}
                    </span>
                  )}
                  <div className="mt-0.5 font-mono text-[10px] text-ink-tertiary tabular-nums">
                    {Number.isNaN(openedAt.getTime()) ? '' : openedAt.toISOString().slice(11, 19)} UTC
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
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
  // Reference date for the heatmap's "today" column highlight (UTC, like the axis).
  const todayIso = new Date().toISOString().slice(0, 10);
  // Per-column header info, computed once per axis instead of per cell.
  const dayInfos = useMemo(() => axis.map(day => dayHeaderInfo(day, todayIso)), [axis, todayIso]);
  // One shared, fixed-position tooltip for the whole heatmap: per-cell hidden
  // spans would add tens of thousands of DOM nodes on a 90d × many-devs grid,
  // and anything positioned inside the overflow-x-auto scroller gets clipped
  // at its edges. Fixed positioning escapes the scroller — BUT only when the
  // tooltip is NOT a descendant of a backdrop-filter/transform element (those
  // create a containing block that silently re-roots the fixed coordinates and
  // a stacking context that swallows the z-index — the CGLAB-131 defect). So it
  // renders at the page root, below, in viewport coordinates from placeTooltip.
  const [heatTip, setHeatTip] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null);
  const showHeatTip = (text: string) => (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHeatTip({ text, ...placeTooltip({ left: r.left, top: r.top, width: r.width, height: r.height }, text, window.innerWidth) });
  };
  // CGLAB-131 — the cell being drilled into (developer × day), or null.
  const [drill, setDrill] = useState<{ dev: string; day: string } | null>(null);
  const drillPrs = useMemo(() => {
    if (!drill || !d?.prs) return [];
    // The server already orders by open time, then repo#number, and applied the
    // same window/model/developer filters as the heatmap itself.
    return d.prs.filter(p => p.user_key === drill.dev && p.day === drill.day);
  }, [drill, d?.prs]);
  const maxDayTotal = Math.max(1, ...(d?.byDay.map(x => x.total) ?? [1]));
  const byDayMap = useMemo(() => new Map((d?.byDay ?? []).map(x => [x.day, x])), [d]);

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-accent-text font-semibold">Analytics</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink flex items-center gap-2">
            <GitPullRequest className="w-6 h-6 text-accent-text" /> PR Overview
          </h1>
          <p className="mt-1 text-sm text-ink-tertiary">Pull requests per developer, weighted by size — for the selected period, with a daily breakdown.</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            className="text-[12px] font-medium rounded-lg border border-border-soft bg-surface text-ink-secondary px-2.5 py-1.5"
          >
            <option value="">All models</option>
            {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <div className="inline-flex rounded-lg border border-border-soft bg-chip p-0.5 text-[11px] font-medium">
            {RANGES.map(r => {
              const active = !customFrom && !customTo && range === r.key;
              return (
                <button
                  key={r.key}
                  onClick={() => pickRange(r.key)}
                  className={`px-2.5 py-1 rounded-md transition-colors ${active
                    ? 'bg-surface text-accent-text shadow-sm'
                    : 'text-ink-tertiary hover:text-ink'}`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
          <div className="inline-flex items-center gap-1 text-[11px] text-ink-tertiary">
            <input
              type="date"
              value={customFrom}
              max={customTo || undefined}
              onChange={e => setCustomFrom(e.target.value)}
              aria-label="From date"
              className="rounded-lg border border-border-soft bg-surface text-ink-secondary px-2 py-1"
            />
            <span>→</span>
            <input
              type="date"
              value={customTo}
              min={customFrom || undefined}
              onChange={e => setCustomTo(e.target.value)}
              aria-label="To date"
              className="rounded-lg border border-border-soft bg-surface text-ink-secondary px-2 py-1"
            />
            {(customFrom || customTo) && (
              <button
                onClick={() => { setCustomFrom(''); setCustomTo(''); }}
                className="ml-0.5 px-1.5 py-1 rounded-md text-ink-tertiary hover:text-rose-600 dark:hover:text-rose-400"
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

      {overview.isLoading && <div className="text-sm text-ink-tertiary py-8 text-center">Loading…</div>}
      {d && d.totals.prs === 0 && (
        <div className="rounded-2xl border border-border-soft bg-surface px-5 py-10 text-center text-sm text-ink-tertiary">
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
              <span className="text-[11px] text-ink-tertiary">size points</span>
            </Tile>
            <Tile label="Active developers" value={d.totals.developers}>
              <span className="text-[11px] text-ink-tertiary">{(d.totals.prs / Math.max(1, d.totals.developers)).toFixed(1)} PRs / dev</span>
            </Tile>
            <Tile label="Median size" value={<span className="uppercase">{d.totals.medianBucket ?? '—'}</span>}>
              <span className="text-[11px] text-ink-tertiary">across {d.totals.prs} PRs</span>
            </Tile>
          </div>

          {/* Resize strip */}
          {d.resized.count > 0 && (
            <div className="flex items-center gap-3 flex-wrap rounded-xl border border-border-soft border-l-[3px] border-l-brand bg-gradient-to-r from-chip to-transparent px-4 py-3">
              <RefreshCw className="w-4 h-4 text-accent-text" />
              <span className="text-[13px] text-ink-secondary">
                <b className="text-ink">{d.resized.count} PRs re-sized</b> this period —{' '}
                <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{d.resized.grew} grew ↑</span>,{' '}
                <span className="text-rose-600 dark:text-rose-400 font-semibold">{d.resized.shrank} shrank ↓</span>.
              </span>
              <span className="ml-auto text-[11px] text-ink-tertiary">Each PR counts once, at its latest sizing.</span>
            </div>
          )}

          {/* Daily stacked bar */}
          <section className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5">
            <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
              <h2 className="text-sm font-semibold text-ink">Daily PR volume by size</h2>
              <div className="flex gap-3 flex-wrap">
                {SIZE_META.map(s => (
                  <span key={s.key} className="inline-flex items-center gap-1.5 text-[11px] text-ink-tertiary">
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
                  <div key={day} className="flex-1 text-center font-mono text-[9px] text-ink-tertiary">
                    {i % Math.ceil(axis.length / 10 || 1) === 0 ? day.slice(5) : ''}
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* By developer */}
          <section className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-border-soft">
              <h2 className="text-sm font-semibold text-ink">By developer</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase tracking-[0.08em] text-ink-tertiary">
                    <th className="px-5 py-2 font-semibold">Developer</th>
                    <th className="px-3 py-2 font-semibold text-right">PRs</th>
                    <th className="px-3 py-2 font-semibold w-[180px]">Size mix</th>
                    <th className="px-3 py-2 font-semibold">XS · S · M · L · XL</th>
                    <th className="px-5 py-2 font-semibold text-right">Trend</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-soft">
                  {d.byDeveloper.map(dev => (
                    <tr key={dev.user_key} className="hover:bg-chip/50 transition-colors">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-lg bg-[image:var(--gradient-accent)] text-navy text-[10px] font-bold flex items-center justify-center shrink-0">
                            {dev.user_key.slice(0, 2).toUpperCase()}
                          </div>
                          <span className="font-mono text-[12px] text-ink-secondary truncate max-w-[200px]">{dev.user_key}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-lg font-bold text-ink">{dev.prs}</td>
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
          <section className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-border-soft">
              <h2 className="text-sm font-semibold text-ink">By model</h2>
              <p className="text-[11px] text-ink-tertiary mt-0.5">Which agent runtime opened the PRs.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase tracking-[0.08em] text-ink-tertiary">
                    <th className="px-5 py-2 font-semibold">Model</th>
                    <th className="px-3 py-2 font-semibold text-right">PRs</th>
                    <th className="px-3 py-2 font-semibold w-[180px]">Size mix</th>
                    <th className="px-5 py-2 font-semibold text-right">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-soft">
                  {d.byModel.map(m => (
                    <tr key={m.model} className="hover:bg-chip/50 transition-colors">
                      <td className="px-5 py-3">
                        <div className="font-mono text-[12px] text-ink-secondary">{m.model}</div>
                        {m.harnesses.length > 0 && <div className="text-[10px] text-ink-tertiary">via {m.harnesses.join(', ')}</div>}
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-lg font-bold text-ink">{m.prs}</td>
                      <td className="px-3 py-3"><MixBar sizes={m.sizes} total={m.prs} /></td>
                      <td className="px-5 py-3 text-right font-mono tabular-nums text-ink-secondary">{Math.round((m.prs / d.totals.prs) * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Per developer per day heatmap — calendar headers (month band +
              weekday/day per column), contribution pills per dev, and a styled
              tooltip on EVERY cell (the native title alone proved unreliable
              here, and 0-count cells previously lost hover to a nested div). */}
          <section className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-ink mb-1">Per developer, per day</h2>
            <p className="text-[11px] text-ink-tertiary mb-4">Cell shade = PRs opened that day. Pills: share of PRs · share of size points.</p>
            <div className="overflow-x-auto">
              <div
                className="grid gap-1 items-center min-w-[560px]"
                style={{ gridTemplateColumns: `minmax(150px, 190px) repeat(${Math.max(axis.length, 1)}, minmax(10px, 40px))` }}
              >
                {/* header row 1: month name spanning its day columns */}
                <div className="sticky left-0 z-10 self-stretch bg-surface" />
                {buildMonthBands(axis).map((band, i) => (
                  <div
                    key={`${band.label}-${i}`}
                    style={{ gridColumn: `span ${band.span}` }}
                    className="text-center font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary border-b-2 border-border-brand pb-1"
                  >
                    {band.label}
                  </div>
                ))}

                {/* header row 2: weekday abbreviation + day number per column */}
                <div className="sticky left-0 z-10 self-stretch bg-surface" />
                {axis.map((day, i) => {
                  const h = dayInfos[i];
                  return (
                    <div
                      key={day}
                      className={`text-center rounded-md py-0.5 ${h.isToday
                        ? 'bg-chip outline outline-1 outline-border-brand'
                        : h.isWeekend ? 'bg-chip' : ''}`}
                    >
                      <span className={`block font-mono text-[8px] uppercase leading-tight ${h.isWeekend ? 'text-ink-tertiary' : 'text-ink-tertiary'}`}>{h.weekday}</span>
                      <span className={`block font-mono text-[11px] font-bold tabular-nums leading-tight ${h.isToday
                        ? 'text-accent-text'
                        : h.isWeekend ? 'text-ink-tertiary' : 'text-ink-secondary'}`}>{h.dayNum}</span>
                    </div>
                  );
                })}

                {/* one row per developer: name + contribution pills | day cells */}
                {d.byDeveloper.map(dev => {
                  const max = Math.max(1, ...axis.map(day => dev.daily[day] ?? 0));
                  const pct = contributionPcts(dev, d.totals);
                  return (
                    <Fragment key={dev.user_key}>
                      {/* sticky so names + pills stay visible when the day axis scrolls */}
                      <div className="sticky left-0 z-10 self-stretch flex items-center gap-2 pr-2 min-w-0 bg-surface">
                        <span title={dev.user_key} className="font-mono text-[11px] text-ink-tertiary truncate">{dev.user_key}</span>
                        {/* stacked vertically so long dev emails keep the width */}
                        <span className="ml-auto flex flex-col items-end gap-0.5 shrink-0">
                          <span className="font-mono text-[9px] font-bold tabular-nums whitespace-nowrap rounded-full px-1.5 py-px text-accent-text bg-chip border border-border-brand">{pct.prPct}% PRs</span>
                          <span className="font-mono text-[9px] font-bold tabular-nums whitespace-nowrap rounded-full px-1.5 py-px text-brand-dark dark:text-brand-light bg-mint/40 dark:bg-brand/10 border border-border-brand">{pct.ptsPct}% pts</span>
                        </span>
                      </div>
                      {axis.map((day, i) => {
                        const c = dev.daily[day] ?? 0;
                        const h = dayInfos[i];
                        const intensity = c === 0 ? 0 : 0.25 + (c / max) * 0.7;
                        return (
                          <div
                            key={day}
                            onMouseEnter={showHeatTip(cellTooltip(dev.user_key, day, c))}
                            onMouseLeave={() => setHeatTip(null)}
                            // CGLAB-131 — non-empty cells are drillable: open the PR list.
                            // (Clear the tooltip so it cannot peek out from the modal.)
                            onClick={c > 0 ? () => { setHeatTip(null); setDrill({ dev: dev.user_key, day }); } : undefined}
                            className={`aspect-square rounded-[3px] ${c === 0
                              ? h.isWeekend
                                ? 'bg-chip border border-dashed border-border-soft'
                                : 'bg-chip'
                              : 'cursor-pointer hover:opacity-75 transition-opacity'}`}
                            style={{ background: c === 0 ? undefined : `rgba(99,102,241,${intensity.toFixed(2)})` }}
                          />
                        );
                      })}
                    </Fragment>
                  );
                })}
              </div>
            </div>
          </section>

          {/* CGLAB-131 — deliberately OUTSIDE the heatmap section above: a
              backdrop-filter ancestor would re-root these fixed coordinates
              (the "tooltip far away" defect) and swallow the z-50 (the z-order
              defect). Coordinates are viewport-relative, from placeTooltip. */}
          {heatTip && (
            <div
              className={`pointer-events-none fixed z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-card-glass text-white font-mono text-[10px] px-2 py-1 shadow-lg ${heatTip.below ? '' : '-translate-y-full'}`}
              style={{ left: heatTip.x, top: heatTip.y }}
            >
              {heatTip.text}
            </div>
          )}
          {drill && <PrDrilldownModal dev={drill.dev} day={drill.day} prs={drillPrs} onClose={() => setDrill(null)} />}

          {/* Size model explainer */}
          <section className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-ink mb-3">How size is derived</h2>
            <div className="font-mono text-[13px] rounded-lg bg-chip border border-border-soft px-4 py-3 text-ink-secondary">
              <span className="text-ink-tertiary">// count leaves — the unit of work in each branch</span><br />
              <span className="text-accent-text">size_points</span> = leafStory·<b>4</b> + task·<b>2</b> + bug·<b>1</b>
            </div>
            <p className="text-[12px] text-ink-tertiary mt-3 max-w-2xl">
              An Epic rolls up its Stories, and a Story rolls up its Tasks &amp; Bugs — so summing all four tiers
              double-counts. We size by the atomic deliverables; a Story with no subtasks is itself a leaf and scores ×4.
              A later re-size re-buckets the same PR (it never adds a second one), and the PR is attributed to its opener.
            </p>
            <div className="flex gap-2 flex-wrap mt-3 text-[11px] font-mono">
              {[{ b: 'XS', r: '0–2' }, { b: 'S', r: '3–6' }, { b: 'M', r: '7–14' }, { b: 'L', r: '15–30' }, { b: 'XL', r: '31+' }].map((x, i) => (
                <span key={x.b} className="inline-flex items-center gap-1.5 rounded-md border border-border-soft px-2 py-1">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ background: colorOf(SIZE_META[i].key) }} />
                  <b>{x.b}</b> <span className="text-ink-tertiary">{x.r} pts</span>
                </span>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
