import { useId, useState, type KeyboardEvent } from 'react';
import { niceTicks } from './chartAxis';
import { ALL_EVENTS_COLOR } from '../chartColours';

export interface DailyBar {
  /** YYYY-MM-DD, the viewer's day. */
  day: string;
  value: number;
  /** What a reader must know about the value ("includes $1 estimated"), said with it. */
  note?: string;
  /** The value's parts, one per `series` entry and in its order, stacked bottom up. */
  parts?: number[];
}

/** One part of a stacked bar: what it is called and the colour it wears. */
export interface BarSeries {
  label: string;
  color: string;
  /** Drawn in stripes of its colour: a part of another kind than the solid ones beside it. */
  pattern?: 'hatched';
}

/** How a part is painted, in the bar, the legend and the tooltip alike. */
function fillStyle(s: BarSeries): { background: string; boxShadow?: string } {
  if (s.pattern !== 'hatched') return { background: s.color };
  return {
    background: `repeating-linear-gradient(135deg, ${s.color} 0 3px, transparent 3px 6px)`,
    boxShadow: `inset 0 0 0 1px ${s.color}`,
  };
}

/**
 * One measure per day as bars on its own y-axis (GH-389 usage timeline). One
 * series, so the title names it and there is no legend; two measures of
 * different scale are two of these, never one chart with two axes. With
 * `series`, each bar stacks the parts of that one measure (tokens by type),
 * named in a legend; the parts add up to the bar, so the axis is unchanged.
 * A `hatched` series is striped, in the bar, the legend and the tooltip: a
 * part of another kind than the solid ones (usage on no card, which is every
 * token type at once, on top of the types).
 *
 * - y-axis of nice ticks with a gridline each; `scale` turns the value into
 *   the whole units the ticks count in (cents for dollars), `format` writes a
 *   value for people.
 * - Exact values in one tooltip, opened by hovering, tapping or focusing a bar.
 *   A stacked bar's tooltip lists every part with its share of the day, and
 *   hovering a part singles out its line.
 * - One tab stop (a listbox whose options are the bars): arrow keys, Home and
 *   End walk them, and each bar is named "day: value" for a screen reader.
 */
export function DailyBarChart({ title, bars, format, tickFormat = format, scale = 1, series }: {
  title: string;
  bars: DailyBar[];
  /** A value as the tooltip and a screen reader say it. */
  format: (v: number) => string;
  /** A y-axis label (short). */
  tickFormat?: (v: number) => string;
  scale?: number;
  /** Stack each bar by these parts (DailyBar.parts); a part is written with tickFormat. */
  series?: BarSeries[];
}) {
  const ticks = niceTicks(Math.max(0, ...bars.map(b => b.value * scale)));
  const top = ticks[ticks.length - 1] || 1;
  const at = (units: number) => `${(units / top) * 100}%`;
  // A tiny value keeps a visible sliver rather than vanishing.
  const barHeight = (v: number) => (v > 0 ? `${Math.max(1.5, (v * scale / top) * 100)}%` : '0');
  const [active, setActive] = useState<number | null>(null);
  /** The part under the pointer, by index into `series`. */
  const [activePart, setActivePart] = useState<number | null>(null);
  const id = useId();
  const optionId = (i: number) => `${id}-bar-${i}`;
  const last = bars.length - 1;
  const current = active != null && active <= last ? active : null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (last < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape') { if (current != null) { e.preventDefault(); setActive(null); setActivePart(null); } return; }
    const cur = current ?? last;
    const next: Record<string, number> = {
      ArrowLeft: current == null ? last : Math.max(0, cur - 1),
      ArrowRight: current == null ? last : Math.min(last, cur + 1),
      Home: 0,
      End: last,
    };
    if (!(e.key in next)) return;
    e.preventDefault();
    // The keyboard picks a day, not a part: no part stays singled out.
    setActivePart(null);
    setActive(next[e.key]);
    document.getElementById(optionId(next[e.key]))?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  const shown = current != null ? bars[current] : null;
  /**
   * A bar stacks only when its parts are all there and add up to it (within
   * rounding): otherwise the colours would claim a split the data does not
   * have, so it is drawn whole, as an unstacked bar.
   */
  const stacks = (b: DailyBar) => !!series && Array.isArray(b.parts) && b.parts.length === series.length
    && Math.abs(b.parts.reduce((a, p) => a + p, 0) - b.value) <= Math.max(1e-9, Math.abs(b.value) * 1e-6);
  const partsOf = (b: DailyBar) => (series && stacks(b) ? series.map((s, k) => ({ ...s, k, value: b.parts![k] })) : []);
  const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%');
  const nameOf = (b: DailyBar) => {
    const parts = stacks(b) ? ` (${partsOf(b).map(p => `${p.label.toLowerCase()} ${tickFormat(p.value)}`).join(', ')})` : '';
    return `${b.day}: ${format(b.value)}${parts}${b.note ? ` (${b.note})` : ''}`;
  };
  // Kept inside the chart: anchored left near the start, right near the end.
  const position = current != null && bars.length > 1 ? current / last : 0.5;
  const align = position < 0.15 ? 'left' : position > 0.85 ? 'right' : 'center';

  return (
    <section aria-label={title} className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-body font-semibold text-ink-secondary">{title}</h2>
        {series && (
          <ul aria-label={`${title} legend`} className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-ink-secondary">
            {series.map(s => (
              <li key={s.label} className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" data-pattern={s.pattern} className="inline-block w-2.5 h-2.5 rounded-sm" style={fillStyle(s)} />
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex gap-2">
        <div className="relative w-12 h-36 shrink-0 font-mono text-caption text-ink-tertiary" aria-hidden="true">
          {ticks.map(t => (
            <span key={t} className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: at(t) }}>{tickFormat(t / scale)}</span>
          ))}
        </div>
        <div className="flex-1 min-w-0 overflow-x-auto">
          <div className="relative h-36" style={{ minWidth: `${Math.max(240, bars.length * 4)}px` }}>
            {ticks.map(t => (
              <div key={t} aria-hidden="true" className="absolute inset-x-0 border-t border-border-soft" style={{ bottom: at(t) }} />
            ))}
            <div
              role="listbox"
              aria-label={title}
              tabIndex={0}
              aria-activedescendant={current != null ? optionId(current) : undefined}
              onKeyDown={onKeyDown}
              onBlur={() => { setActive(null); setActivePart(null); }}
              onMouseLeave={() => { setActive(null); setActivePart(null); }}
              className="absolute inset-0 flex items-end gap-[2px] outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
            >
              {bars.map((b, i) => (
                <div
                  key={b.day}
                  id={optionId(i)}
                  role="option"
                  aria-selected={current === i}
                  aria-label={nameOf(b)}
                  onMouseEnter={() => { setActive(i); setActivePart(null); }}
                  onClick={() => setActive(i)}
                  className="relative flex-1 h-full flex items-end cursor-default"
                >
                  {stacks(b) ? (
                    <div
                      className="w-full flex flex-col-reverse rounded-t-[4px] overflow-hidden"
                      style={{
                        height: barHeight(b.value),
                        opacity: current == null || current === i ? 1 : 0.45,
                      }}
                    >
                      {partsOf(b).map(p => (
                        <div
                          key={p.label}
                          data-series={p.label}
                          data-pattern={p.pattern}
                          onMouseEnter={() => setActivePart(p.k)}
                          onMouseLeave={() => setActivePart(null)}
                          style={{
                            // A share of the bar, so the parts fill it exactly.
                            height: `${b.value > 0 ? (p.value / b.value) * 100 : 0}%`,
                            ...fillStyle(p),
                            opacity: current === i && activePart != null && activePart !== p.k ? 0.55 : 1,
                          }}
                        />
                      ))}
                    </div>
                  ) : (
                    <div
                      className="w-full rounded-t-[4px]"
                      style={{
                        height: barHeight(b.value),
                        background: ALL_EVENTS_COLOR,
                        opacity: current == null || current === i ? 1 : 0.45,
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
            {shown && (
              <div
                aria-hidden="true"
                data-testid="bar-tooltip"
                className="pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded-lg border border-border-soft bg-surface px-2.5 py-1.5 shadow-lg text-caption"
                style={{
                  left: `${((current! + 0.5) / bars.length) * 100}%`,
                  transform: align === 'left' ? 'translateX(-10%)' : align === 'right' ? 'translateX(-90%)' : 'translateX(-50%)',
                }}
              >
                <div className="text-ink-tertiary">{shown.day}</div>
                <div className="font-mono tabular-nums text-ink">{format(shown.value)}</div>
                {stacks(shown) && (
                  <ul className="mt-1 space-y-0.5">
                    {partsOf(shown).slice().reverse().map(p => {
                      const on = activePart === p.k;
                      return (
                        <li
                          key={p.label}
                          data-active={on ? 'true' : undefined}
                          className={`flex items-center gap-1.5 ${on ? 'text-ink font-semibold' : 'text-ink-secondary'}`}
                        >
                          <span className="inline-block w-2 h-2 rounded-sm" data-pattern={p.pattern} style={fillStyle(p)} />
                          <span>{p.label}</span>
                          <span className="ml-auto pl-3 font-mono tabular-nums">{tickFormat(p.value)}</span>
                          <span className="w-9 text-right font-mono tabular-nums text-ink-tertiary">{share(p.value, shown.value)}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {shown.note && <div className="text-ink-tertiary">{shown.note}</div>}
              </div>
            )}
          </div>
          <div className="flex justify-between pt-1 font-mono text-caption text-ink-tertiary" aria-hidden="true" style={{ minWidth: `${Math.max(240, bars.length * 4)}px` }}>
            <span>{bars[0]?.day.slice(5)}</span>
            {bars.length > 2 && <span>{bars[Math.floor(last / 2)].day.slice(5)}</span>}
            <span>{bars[last]?.day.slice(5)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
