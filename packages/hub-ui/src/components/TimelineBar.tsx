import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import {
  buildAxis,
  effectiveBucket,
  fmtBucketKey,
  fromIsoForRange,
  shortLabel,
  type Bucket,
  type RangeKey,
} from './timelineAxis';

interface HistogramBucket { time: string; total: number; by_type: Record<string, number> }
interface HistogramResponse { bucket: 'day' | 'hour'; buckets: HistogramBucket[] }

interface Props {
  users?: string[];
  types?: string[];
  projects?: string[];
  itemTypes?: string[];
  className?: string;
  title?: string;
  range?: RangeKey;
  onRangeChange?: (r: RangeKey) => void;
  fromIsoOverride?: string;
  toIsoOverride?: string;
}

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: 'today' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
];

// Teal ramp matching the CG/lab brand accent when no specific type selected.
const ACCENT = '#04cc98';
const TYPE_COLORS = ['#04cc98', '#7fe5ca', '#056f71', '#4f8ef7', '#f59e0b', '#f26d7e', '#ec4899', '#0d9488', '#eab308', '#3b82f6', '#22d3ee', '#06b6d4'];
const colorForType = (type: string, idx: number) => TYPE_COLORS[idx % TYPE_COLORS.length];

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

function buildAxisForBounds(fromIso: string, toIso: string | undefined, bucket: Bucket): string[] {
  const from = new Date(fromIso);
  const to = toIso ? new Date(toIso) : new Date();
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) return [];

  const out: string[] = [];
  if (bucket === 'day') {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
    while (d <= end) { out.push(fmtBucketKey(d, 'day')); d.setDate(d.getDate() + 1); }
  } else {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours());
    const end = new Date(to.getFullYear(), to.getMonth(), to.getDate(), to.getHours());
    while (d <= end) { out.push(fmtBucketKey(d, 'hour')); d.setHours(d.getHours() + 1); }
  }
  return out;
}

export function TimelineBar({ users, types, projects, itemTypes, className, title, range: rangeProp, onRangeChange, fromIsoOverride, toIsoOverride }: Props) {
  const [rangeInternal, setRangeInternal] = useState<RangeKey>('30d');
  const range = rangeProp ?? rangeInternal;
  const setRange = (r: RangeKey) => { setRangeInternal(r); onRangeChange?.(r); };
  const [bucketSel, setBucketSel] = useState<Bucket>('day');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const bucket = effectiveBucket(range, bucketSel);
  const isToday = range === 'today';

  // Recompute "now" on each render — TimelineBar is light enough that this is fine,
  // and we want the axis/from to track the wall clock as the user lingers.
  const now = new Date();
  const rangeFromIso = useMemo(() => fromIsoForRange(now, range), [range, now.getHours()]);
  const fromIso = fromIsoOverride ?? rangeFromIso;

  // JS getTimezoneOffset returns minutes WEST of UTC; the hub expects minutes
  // EAST of UTC (positive for tz ahead of UTC). Negate to align.
  const tzOffsetMin = -now.getTimezoneOffset();

  const params = new URLSearchParams();
  if (users?.length) params.set('users', users.join(','));
  if (types?.length) params.set('types', types.join(','));
  if (projects?.length) params.set('projects', projects.join(','));
  if (itemTypes?.length) params.set('itemTypes', itemTypes.join(','));
  params.set('from', fromIso);
  if (toIsoOverride) params.set('to', toIsoOverride);
  params.set('bucket', bucket);
  params.set('tzOffsetMin', String(tzOffsetMin));

  const q = useQuery<HistogramResponse>({
    queryKey: ['histogram', users?.join(',') ?? '', types?.join(',') ?? '', projects?.join(',') ?? '', itemTypes?.join(',') ?? '', range, fromIsoOverride ?? '', toIsoOverride ?? '', bucket, tzOffsetMin],
    queryFn: async () => (await api.get(`/v1/histogram?${params}`)).data,
  });

  const axis = useMemo(
    () => fromIsoOverride || toIsoOverride
      ? buildAxisForBounds(fromIso, toIsoOverride, bucket)
      : buildAxis(now, range, bucket),
    [fromIso, fromIsoOverride, toIsoOverride, range, bucket, now.getHours()],
  );
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

  const rangeBlurb = fromIsoOverride || toIsoOverride
    ? 'custom period'
    : isToday
    ? 'today'
    : `last ${range === '7d' ? 7 : range === '30d' ? 30 : 90} days`;

  return (
    <section className={`relative bg-card-glass backdrop-blur border border-border-soft rounded-2xl ${className ?? ''}`}>
      <header className="flex items-center justify-between gap-4 px-5 pt-4 pb-3 border-b border-border-soft">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink truncate">{title ?? 'Activity'}</h3>
          <p className="mt-0.5 text-[11px] text-ink-tertiary">
            {totalEvents.toLocaleString()} event{totalEvents === 1 ? '' : 's'} · {rangeBlurb}{users?.length ? ` · ${users.length} user${users.length === 1 ? '' : 's'}` : ''}{stackedTypes ? ` · ${stackedTypes.length} type${stackedTypes.length === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Range picker only shown when not controlled externally (standalone usage) */}
          {rangeProp == null && (
            <div className="inline-flex rounded-lg border border-border-soft bg-chip p-0.5 text-[11px] font-medium">
              {RANGES.map(r => (
                <button
                  key={r.key}
                  onClick={() => setRange(r.key)}
                  className={`px-2.5 py-1 rounded-md transition-colors ${range === r.key
                    ? 'bg-card-glass text-accent-text shadow-sm'
                    : 'text-ink-tertiary hover:text-ink'}`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
          <div className="inline-flex rounded-lg border border-border-soft bg-chip p-0.5 text-[11px] font-medium">
            {(['day', 'hour'] as const).map(b => {
              const active = bucket === b;
              const disabled = isToday && b === 'day';
              return (
                <button
                  key={b}
                  onClick={() => !disabled && setBucketSel(b)}
                  disabled={disabled}
                  title={disabled ? 'Today view is hourly' : undefined}
                  className={`px-2.5 py-1 rounded-md transition-colors ${active
                    ? 'bg-card-glass text-accent-text shadow-sm'
                    : disabled
                      ? 'text-ink-tertiary/50 cursor-not-allowed'
                      : 'text-ink-tertiary hover:text-ink'}`}
                >
                  {b}
                </button>
              );
            })}
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
                      className="stroke-border-soft" strokeDasharray={t === 0 ? '0' : '2 3'} />
                <text x={m.left - 6} y={y} textAnchor="end" dominantBaseline="middle"
                      className="fill-ink-tertiary" style={{ fontSize: 10 }}>
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
                        className="fill-border-soft" />
                )}
                {/* hover highlight column */}
                {isHover && (
                  <rect x={x - 1} y={m.top} width={barW + 2} height={innerH}
                        className="fill-brand/5 dark:fill-brand/10" pointerEvents="none" />
                )}
                {/* count label on top of hovered bar */}
                {isHover && total > 0 && (
                  <text x={x + barW / 2} y={m.top + innerH - barH - 4}
                        textAnchor="middle"
                        className="fill-ink font-semibold"
                        style={{ fontSize: 10 }}>
                    {total}
                  </text>
                )}
              </g>
            );
          })}

          {/* X axis baseline */}
          <line x1={m.left} x2={m.left + innerW} y1={m.top + innerH} y2={m.top + innerH}
                className="stroke-border-soft" />

          {/* X tick labels */}
          {axis.map((t, i) => {
            if (i % xLabelStep !== 0 && i !== axis.length - 1) return null;
            const x = m.left + i * (barW + barGap) + barW / 2;
            return (
              <text key={t} x={x} y={m.top + innerH + 14}
                    textAnchor="middle"
                    className="fill-ink-tertiary font-mono"
                    style={{ fontSize: 10 }}>
                {shortLabel(t, bucket, range)}
              </text>
            );
          })}

          {/* Axis titles */}
          <text x={m.left} y={m.top - 2}
                className="fill-ink-tertiary"
                style={{ fontSize: 9, letterSpacing: '0.06em' }}>
            EVENTS
          </text>
        </svg>

        {/* Hover tooltip — positioned over the SVG using percentages of the same coordinate system. */}
        {hoveredBucket && hoverIdx != null && (
          <div
            className="pointer-events-none absolute z-10 px-3 py-2 rounded-lg shadow-lg border border-border-soft bg-card-glass backdrop-blur text-[11px] min-w-[140px]"
            style={{
              left: `calc(${(hoveredX / width) * 100}% )`,
              top: '14px',
              transform: hoveredX > width * 0.7 ? 'translateX(-100%)' : 'translateX(8px)',
            }}
          >
            <div className="font-mono text-ink-tertiary">{hoveredBucket.time}</div>
            <div className="mt-0.5 font-semibold text-ink">
              {hoveredBucket.total} <span className="font-normal text-ink-tertiary">event{hoveredBucket.total === 1 ? '' : 's'}</span>
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
                          <span className="font-mono text-ink-secondary truncate">{k}</span>
                        </span>
                        <span className="font-semibold text-ink">{v}</span>
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
        <footer className="flex flex-wrap gap-x-4 gap-y-1.5 px-5 pb-4 pt-1 text-[11px] text-ink-tertiary">
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
