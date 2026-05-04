import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

interface HistogramBucket { time: string; total: number; by_type: Record<string, number> }
interface HistogramResponse { bucket: 'day' | 'hour'; buckets: HistogramBucket[] }

interface Props {
  users?: string[];
  types?: string[];
  projects?: string[];
  itemTypes?: string[];
  className?: string;
  title?: string;
}

const RANGES: Array<{ label: string; days: number }> = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

// Indigo→violet ramp matching the AgenFK logo when no specific type selected.
const ACCENT = '#6366f1';
const TYPE_COLORS = ['#6366f1', '#a855f7', '#22d3ee', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#eab308', '#3b82f6', '#8b5cf6', '#06b6d4'];
const colorForType = (type: string, idx: number) => TYPE_COLORS[idx % TYPE_COLORS.length];

function pad2(n: number) { return String(n).padStart(2, '0'); }
// Bucket keys are computed in the user's local timezone (mirroring the
// backend's tzOffsetMin shift) so axis labels and histogram counts agree.
function fmtBucketKey(d: Date, bucket: 'day' | 'hour'): string {
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  if (bucket === 'day') return `${yyyy}-${mm}-${dd}`;
  return `${yyyy}-${mm}-${dd}T${pad2(d.getHours())}:00`;
}

function buildAxis(days: number, bucket: 'day' | 'hour'): string[] {
  const out: string[] = [];
  const now = new Date();
  const start = new Date(now.getTime() - days * 86400_000);
  if (bucket === 'day') {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    while (d <= end) { out.push(fmtBucketKey(d, 'day')); d.setDate(d.getDate() + 1); }
  } else {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
    while (d <= end) { out.push(fmtBucketKey(d, 'hour')); d.setHours(d.getHours() + 1); }
  }
  return out;
}

// "Nice" Y-axis ticks for an integer-count chart. Returns at most 5 evenly-spaced values.
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const target = 4;
  const raw = max / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * pow;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(Math.round(v));
  return out;
}

function shortLabel(time: string, bucket: 'day' | 'hour'): string {
  if (bucket === 'day') {
    const [y, m, d] = time.split('-');
    return `${m}/${d}`;
    void y;
  }
  // hour: 2026-05-04T08:00 → "08:00"
  const [, hh] = time.split('T');
  return hh ?? time;
}

export function TimelineBar({ users, types, projects, itemTypes, className, title }: Props) {
  const [days, setDays] = useState(30);
  const [bucket, setBucket] = useState<'day' | 'hour'>('day');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const fromIso = useMemo(() => new Date(Date.now() - days * 86400_000).toISOString(), [days]);

  // JS getTimezoneOffset returns minutes WEST of UTC; the hub expects minutes
  // EAST of UTC (positive for tz ahead of UTC). Negate to align.
  const tzOffsetMin = -new Date().getTimezoneOffset();

  const params = new URLSearchParams();
  if (users?.length) params.set('users', users.join(','));
  if (types?.length) params.set('types', types.join(','));
  if (projects?.length) params.set('projects', projects.join(','));
  if (itemTypes?.length) params.set('itemTypes', itemTypes.join(','));
  params.set('from', fromIso);
  params.set('bucket', bucket);
  params.set('tzOffsetMin', String(tzOffsetMin));

  const q = useQuery<HistogramResponse>({
    queryKey: ['histogram', users?.join(',') ?? '', types?.join(',') ?? '', projects?.join(',') ?? '', itemTypes?.join(',') ?? '', days, bucket, tzOffsetMin],
    queryFn: async () => (await api.get(`/v1/histogram?${params}`)).data,
  });

  const axis = useMemo(() => buildAxis(days, bucket), [days, bucket]);
  const byTime = useMemo(() => {
    const m = new Map<string, HistogramBucket>();
    for (const b of q.data?.buckets ?? []) m.set(b.time, b);
    return m;
  }, [q.data]);

  const stackedTypes = types && types.length > 0 ? types : null;

  const maxTotal = useMemo(() => {
    let m = 0;
    for (const t of axis) {
      const b = byTime.get(t);
      if (b && b.total > m) m = b.total;
    }
    return m;
  }, [axis, byTime]);

  const ticks = useMemo(() => niceTicks(maxTotal), [maxTotal]);
  const yTop = ticks[ticks.length - 1] || 1;

  // SVG geometry — a real chart with margins so axes don't get clipped.
  const width = 920;
  const height = 220;
  const m = { top: 12, right: 16, bottom: 32, left: 40 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;
  const barGap = 1;
  const barW = Math.max(1, (innerW - barGap * (axis.length - 1)) / Math.max(axis.length, 1));

  // Show ~6 X-axis labels to avoid crowding.
  const xLabelStep = Math.max(1, Math.ceil(axis.length / 6));

  const totalEvents = useMemo(() => axis.reduce((a, t) => a + (byTime.get(t)?.total ?? 0), 0), [axis, byTime]);
  const hovered = hoverIdx != null ? axis[hoverIdx] : null;
  const hoveredBucket = hovered ? byTime.get(hovered) : null;
  const hoveredX = hoverIdx != null ? m.left + hoverIdx * (barW + barGap) + barW / 2 : 0;

  return (
    <section className={`relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm ${className ?? ''}`}>
      <header className="flex items-center justify-between gap-4 px-5 pt-4 pb-3 border-b border-slate-100 dark:border-slate-800">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{title ?? 'Activity'}</h3>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            {totalEvents.toLocaleString()} event{totalEvents === 1 ? '' : 's'} · last {days} days{users?.length ? ` · ${users.length} user${users.length === 1 ? '' : 's'}` : ''}
            {stackedTypes ? ` · ${stackedTypes.length} type${stackedTypes.length === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-0.5 text-[11px] font-medium">
            {RANGES.map(r => (
              <button
                key={r.label}
                onClick={() => setDays(r.days)}
                className={`px-2.5 py-1 rounded-md transition-colors ${days === r.days
                  ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-0.5 text-[11px] font-medium">
            {(['day', 'hour'] as const).map(b => (
              <button
                key={b}
                onClick={() => setBucket(b)}
                className={`px-2.5 py-1 rounded-md transition-colors ${bucket === b
                  ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
              >
                {b}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="px-3 pt-3 pb-3 relative">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full h-[220px] block" role="img" aria-label="Event timeline histogram">
          {/* Y gridlines + labels */}
          {ticks.map((t) => {
            const y = m.top + innerH - (t / yTop) * innerH;
            return (
              <g key={t}>
                <line x1={m.left} x2={m.left + innerW} y1={y} y2={y}
                      className="stroke-slate-200 dark:stroke-slate-800" strokeDasharray={t === 0 ? '0' : '2 3'} />
                <text x={m.left - 6} y={y} textAnchor="end" dominantBaseline="middle"
                      className="fill-slate-400 dark:fill-slate-500" style={{ fontSize: 10 }}>
                  {t}
                </text>
              </g>
            );
          })}

          {/* Bars */}
          {axis.map((t, i) => {
            const b = byTime.get(t);
            const total = b?.total ?? 0;
            const x = m.left + i * (barW + barGap);
            const segs = stackedTypes
              ? stackedTypes.map((tp, idx) => ({ type: tp, n: b?.by_type[tp] ?? 0, color: colorForType(tp, idx) }))
              : [{ type: 'all', n: total, color: ACCENT }];
            let yCursor = m.top + innerH;
            const barH = (total / yTop) * innerH;
            const isHover = hoverIdx === i;
            return (
              <g key={t}
                 onMouseEnter={() => setHoverIdx(i)}
                 onMouseLeave={() => setHoverIdx(prev => prev === i ? null : prev)}>
                {/* invisible full-height hit target for easier hover on tiny bars */}
                <rect x={x} y={m.top} width={barW + barGap} height={innerH} fill="transparent" />
                {segs.map(s => {
                  if (!s.n) return null;
                  const segH = (s.n / yTop) * innerH;
                  yCursor -= segH;
                  return (
                    <rect key={s.type}
                          x={x} y={yCursor} width={barW} height={segH}
                          rx={barW > 6 ? 1.5 : 0}
                          fill={s.color}
                          opacity={isHover ? 1 : (hoverIdx == null ? 0.92 : 0.5)}
                          style={{ transition: 'opacity 120ms ease-out' }} />
                  );
                })}
                {/* faint placeholder bar so empty buckets are still readable */}
                {total === 0 && (
                  <rect x={x} y={m.top + innerH - 1} width={barW} height={1}
                        className="fill-slate-200 dark:fill-slate-800" />
                )}
                {/* hover highlight column */}
                {isHover && (
                  <rect x={x - 1} y={m.top} width={barW + 2} height={innerH}
                        className="fill-indigo-500/5 dark:fill-indigo-400/5" pointerEvents="none" />
                )}
                {/* count label on top of hovered bar */}
                {isHover && total > 0 && (
                  <text x={x + barW / 2} y={m.top + innerH - barH - 4}
                        textAnchor="middle"
                        className="fill-slate-700 dark:fill-slate-200 font-semibold"
                        style={{ fontSize: 10 }}>
                    {total}
                  </text>
                )}
              </g>
            );
          })}

          {/* X axis baseline */}
          <line x1={m.left} x2={m.left + innerW} y1={m.top + innerH} y2={m.top + innerH}
                className="stroke-slate-300 dark:stroke-slate-700" />

          {/* X tick labels */}
          {axis.map((t, i) => {
            if (i % xLabelStep !== 0 && i !== axis.length - 1) return null;
            const x = m.left + i * (barW + barGap) + barW / 2;
            return (
              <text key={t} x={x} y={m.top + innerH + 14}
                    textAnchor="middle"
                    className="fill-slate-500 dark:fill-slate-400 font-mono"
                    style={{ fontSize: 10 }}>
                {shortLabel(t, bucket)}
              </text>
            );
          })}

          {/* Axis titles */}
          <text x={m.left} y={m.top - 2}
                className="fill-slate-400 dark:fill-slate-500"
                style={{ fontSize: 9, letterSpacing: '0.06em' }}>
            EVENTS
          </text>
        </svg>

        {/* Hover tooltip — positioned over the SVG using percentages of the same coordinate system. */}
        {hoveredBucket && hoverIdx != null && (
          <div
            className="pointer-events-none absolute z-10 px-3 py-2 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] min-w-[140px]"
            style={{
              left: `calc(${(hoveredX / width) * 100}% )`,
              top: '14px',
              transform: hoveredX > width * 0.7 ? 'translateX(-100%)' : 'translateX(8px)',
            }}
          >
            <div className="font-mono text-slate-500 dark:text-slate-400">{hoveredBucket.time}</div>
            <div className="mt-0.5 font-semibold text-slate-900 dark:text-slate-100">
              {hoveredBucket.total} <span className="font-normal text-slate-500">event{hoveredBucket.total === 1 ? '' : 's'}</span>
            </div>
            {Object.entries(hoveredBucket.by_type).length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {Object.entries(hoveredBucket.by_type)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => {
                    const idx = stackedTypes ? stackedTypes.indexOf(k) : -1;
                    const color = idx >= 0 ? colorForType(k, idx) : ACCENT;
                    return (
                      <li key={k} className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: color }} />
                          <span className="font-mono text-slate-600 dark:text-slate-300 truncate">{k}</span>
                        </span>
                        <span className="font-semibold text-slate-900 dark:text-slate-100">{v}</span>
                      </li>
                    );
                  })}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Legend (only when filtered by type) */}
      {stackedTypes && stackedTypes.length > 0 && (
        <footer className="flex flex-wrap gap-x-4 gap-y-1.5 px-5 pb-4 pt-1 text-[11px] text-slate-500 dark:text-slate-400">
          {stackedTypes.map((tp, idx) => (
            <span key={tp} className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: colorForType(tp, idx) }} />
              <span className="font-mono">{tp}</span>
            </span>
          ))}
        </footer>
      )}
    </section>
  );
}
