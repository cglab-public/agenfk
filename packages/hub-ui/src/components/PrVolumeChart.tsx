import { useId, useState, type KeyboardEvent } from 'react';
import { SIZE_META, fmtAverage } from '../prOverview';
import type { VolumeBucket, VolumeSeries } from '../prVolumeGranularity';
import { niceTicks } from './chartAxis';
import { StatTile } from './ui';

const SIZE_META_DESC = [...SIZE_META].reverse();
const plural = (n: number) => `${n} PR${n === 1 ? '' : 's'}`;
const pct = (share: number) => `${Math.round(share * 100)}%`;

/** What a bar says to a screen reader: its span, total and sizes. */
function barLabel(b: VolumeBucket): string {
  if (!b.total) return `${b.rangeLabel}: no PRs`;
  const sizes = SIZE_META.filter(s => b.sizes[s.key] > 0).map(s => `${b.sizes[s.key]} ${s.label}`).join(', ');
  return `${b.rangeLabel}: ${plural(b.total)} — ${sizes}`;
}

/** Who opened a bucket's PRs, most first, over every size. */
function developers(b: VolumeBucket): Array<{ user_key: string; count: number }> {
  const by = new Map<string, number>();
  for (const s of SIZE_META) for (const d of b.devBySize[s.key] ?? []) by.set(d.user_key, (by.get(d.user_key) ?? 0) + d.count);
  return [...by.entries()].map(([user_key, count]) => ({ user_key, count }))
    .sort((x, y) => y.count - x.count || x.user_key.localeCompare(y.user_key));
}

/**
 * "PR volume by size": a bar per bucket (day, week or month), stacked by size,
 * with the stats beneath it (story da96916f).
 *
 * - A y-axis of nice ticks with a gridline each; bars scale against its top,
 *   so a bar's height reads off the axis.
 * - Exact values in ONE styled tooltip, opened by hovering, tapping or
 *   focusing a bar — never in title= attributes, which are slow, unstyled and
 *   out of reach of a keyboard or a finger.
 * - The chart is a single tab stop (a listbox whose options are the bars):
 *   the arrow keys, Home and End walk the bars, and each bar is named for a
 *   screen reader. A tab stop per bar would be dozens at 90 days.
 */
export function PrVolumeChart({ series, unit }: { series: VolumeSeries; unit: string }) {
  const buckets = series.buckets;
  const ticks = niceTicks(Math.max(0, ...buckets.map(b => b.total)));
  const top = ticks[ticks.length - 1] || 1;
  const [active, setActive] = useState<number | null>(null);
  const id = useId();
  const optionId = (i: number) => `${id}-bar-${i}`;
  const last = buckets.length - 1;
  const at = (v: number) => `${(v / top) * 100}%`;

  const onKeyDown = (e: KeyboardEvent) => {
    if (last < 0) return;
    const cur = active ?? last;
    const next: Record<string, number | null> = {
      ArrowLeft: active == null ? last : Math.max(0, cur - 1),
      ArrowRight: active == null ? last : Math.min(last, cur + 1),
      Home: 0,
      End: last,
      Escape: null,
    };
    if (!(e.key in next)) return;
    e.preventDefault();
    setActive(next[e.key]);
  };

  const shown = active != null ? buckets[active] : null;
  const shownDevs = shown ? developers(shown).slice(0, 5) : [];
  // Kept inside the plot: right-aligned near the right edge, left-aligned near the left.
  const along = active != null ? (active + 0.5) / buckets.length : 0;
  const shift = along > 0.7 ? '-100%' : along < 0.3 ? '0%' : '-50%';
  const { stats } = series;

  return (
    <>
      <div className="flex gap-2">
        {/* y-axis labels, level with the gridlines */}
        <div className="relative w-7 h-44 shrink-0 font-mono text-[11px] text-ink-tertiary" aria-hidden="true">
          {ticks.map(t => (
            <span key={t} data-y-tick className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: at(t) }}>{t}</span>
          ))}
        </div>
        <div className="flex-1 min-w-0 overflow-x-auto">
          <div className="min-w-[420px]">
            <div className="relative h-44">
              {ticks.map(t => (
                <div key={t} data-gridline aria-hidden="true"
                     className={`absolute inset-x-0 border-t ${t === 0 ? 'border-border' : 'border-dashed border-border-soft'}`}
                     style={{ bottom: at(t) }} />
              ))}
              <div
                role="listbox"
                aria-label={`PR volume by size, per ${unit}. Use the arrow keys to read each ${unit}.`}
                aria-orientation="horizontal"
                tabIndex={0}
                aria-activedescendant={active != null ? optionId(active) : undefined}
                onFocus={() => setActive(a => a ?? (last >= 0 ? last : null))}
                onBlur={() => setActive(null)}
                onKeyDown={onKeyDown}
                onMouseLeave={() => setActive(null)}
                className="absolute inset-0 flex items-end gap-1.5 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {buckets.map((b, i) => (
                  <div
                    key={b.key}
                    id={optionId(i)}
                    role="option"
                    aria-selected={active === i}
                    aria-label={barLabel(b)}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => setActive(i)}
                    className={`flex-1 flex flex-col justify-end gap-0.5 h-full cursor-default ${active === i ? 'bg-accent-fill/40' : ''}`}
                  >
                    {SIZE_META_DESC.filter(s => b.sizes[s.key] > 0).map(s => (
                      <div key={s.key} data-segment className="rounded-[2px]"
                           style={{ background: s.color, height: at(b.sizes[s.key]) }} />
                    ))}
                  </div>
                ))}
              </div>
              {shown && (
                <div
                  data-testid="volume-tooltip"
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0 z-10 px-3 py-2 rounded-lg shadow-lg border border-border-soft bg-surface text-ink text-[11px] min-w-[150px]"
                  style={{ left: `${along * 100}%`, transform: `translateX(${shift})` }}
                >
                  <div className="font-mono text-ink-tertiary">{shown.rangeLabel}</div>
                  <div className="mt-0.5 font-semibold">{shown.total ? plural(shown.total) : 'no PRs'}</div>
                  {shown.total > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {SIZE_META_DESC.filter(s => shown.sizes[s.key] > 0).map(s => (
                        <li key={s.key} className="flex items-center justify-between gap-3">
                          <span className="flex items-center gap-1.5">
                            <span className="inline-block w-2 h-2 rounded-sm" style={{ background: s.color }} />
                            <span className="text-ink-secondary">{s.label}</span>
                          </span>
                          <span className="font-semibold">{shown.sizes[s.key]}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {shownDevs.length > 0 && (
                    <ul className="mt-1.5 pt-1.5 border-t border-border-soft space-y-0.5">
                      {shownDevs.map(d => (
                        <li key={d.user_key} className="flex items-center justify-between gap-3">
                          <span className="text-ink-secondary truncate max-w-[180px]">{d.user_key}</span>
                          <span className="font-semibold">{d.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-1.5 mt-2" aria-hidden="true">
              {buckets.map((b, i) => (
                <div key={b.key} data-x-label className="flex-1 text-center font-mono text-[11px] text-ink-tertiary">
                  {buckets.length <= 16 || i % Math.ceil(buckets.length / 10 || 1) === 0 ? b.label : ''}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {/* Stats under the chart. Average is per bucket over the WHOLE range
          (empty buckets included). No total: the Total PRs tile has it. */}
      <div data-testid="volume-stats" className="mt-4 flex gap-3 flex-wrap">
        <StatTile
          size="sm"
          label="Busiest weekday"
          value={stats.busiestWeekday?.day ?? '—'}
          hint={stats.busiestWeekday ? `${pct(stats.busiestWeekday.share)} of PRs` : undefined}
        />
        <StatTile
          size="sm"
          label="L / XL share"
          value={stats.largeShare == null ? '—' : pct(stats.largeShare)}
          hint={stats.largeShare == null ? undefined : 'of PRs sized L or XL'}
        />
        <StatTile size="sm" label={`Average / ${unit}`} value={fmtAverage(stats.average)} />
        <StatTile size="sm" label={`Max${stats.maxLabel ? ` · ${stats.maxLabel}` : ''}`} value={stats.max} />
      </div>
    </>
  );
}
