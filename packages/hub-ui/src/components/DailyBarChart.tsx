import { useId, useState, type KeyboardEvent } from 'react';
import { niceTicks } from './chartAxis';
import { ALL_EVENTS_COLOR } from '../chartColours';

export interface DailyBar {
  /** YYYY-MM-DD, the viewer's day. */
  day: string;
  value: number;
  /** What a reader must know about the value ("includes $1 estimated"), said with it. */
  note?: string;
}

/**
 * One measure per day as bars on its own y-axis (GH-389 usage timeline). One
 * series, so the title names it and there is no legend; two measures of
 * different scale are two of these, never one chart with two axes.
 *
 * - y-axis of nice ticks with a gridline each; `scale` turns the value into
 *   the whole units the ticks count in (cents for dollars), `format` writes a
 *   value for people.
 * - Exact values in one tooltip, opened by hovering, tapping or focusing a bar.
 * - One tab stop (a listbox whose options are the bars): arrow keys, Home and
 *   End walk them, and each bar is named "day: value" for a screen reader.
 */
export function DailyBarChart({ title, bars, format, tickFormat = format, scale = 1 }: {
  title: string;
  bars: DailyBar[];
  /** A value as the tooltip and a screen reader say it. */
  format: (v: number) => string;
  /** A y-axis label (short). */
  tickFormat?: (v: number) => string;
  scale?: number;
}) {
  const ticks = niceTicks(Math.max(0, ...bars.map(b => b.value * scale)));
  const top = ticks[ticks.length - 1] || 1;
  const at = (units: number) => `${(units / top) * 100}%`;
  const [active, setActive] = useState<number | null>(null);
  const id = useId();
  const optionId = (i: number) => `${id}-bar-${i}`;
  const last = bars.length - 1;
  const current = active != null && active <= last ? active : null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (last < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape') { if (current != null) { e.preventDefault(); setActive(null); } return; }
    const cur = current ?? last;
    const next: Record<string, number> = {
      ArrowLeft: current == null ? last : Math.max(0, cur - 1),
      ArrowRight: current == null ? last : Math.min(last, cur + 1),
      Home: 0,
      End: last,
    };
    if (!(e.key in next)) return;
    e.preventDefault();
    setActive(next[e.key]);
    document.getElementById(optionId(next[e.key]))?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  const shown = current != null ? bars[current] : null;
  // Kept inside the chart: anchored left near the start, right near the end.
  const share = current != null && bars.length > 1 ? current / last : 0.5;
  const align = share < 0.15 ? 'left' : share > 0.85 ? 'right' : 'center';

  return (
    <section aria-label={title} className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5 space-y-3">
      <h2 className="text-body font-semibold text-ink-secondary">{title}</h2>
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
              onBlur={() => setActive(null)}
              onMouseLeave={() => setActive(null)}
              className="absolute inset-0 flex items-end gap-[2px] outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
            >
              {bars.map((b, i) => (
                <div
                  key={b.day}
                  id={optionId(i)}
                  role="option"
                  aria-selected={current === i}
                  aria-label={`${b.day}: ${format(b.value)}${b.note ? ` (${b.note})` : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => setActive(i)}
                  className="relative flex-1 h-full flex items-end cursor-default"
                >
                  <div
                    className="w-full rounded-t-[4px]"
                    style={{
                      // A tiny value keeps a visible sliver rather than vanishing.
                      height: b.value > 0 ? `${Math.max(1.5, (b.value * scale / top) * 100)}%` : '0',
                      background: ALL_EVENTS_COLOR,
                      opacity: current == null || current === i ? 1 : 0.45,
                    }}
                  />
                </div>
              ))}
            </div>
            {shown && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded-lg border border-border-soft bg-card px-2.5 py-1.5 shadow-lg text-caption"
                style={{
                  left: `${((current! + 0.5) / bars.length) * 100}%`,
                  transform: align === 'left' ? 'translateX(-10%)' : align === 'right' ? 'translateX(-90%)' : 'translateX(-50%)',
                }}
              >
                <div className="text-ink-tertiary">{shown.day}</div>
                <div className="font-mono tabular-nums text-ink">{format(shown.value)}</div>
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
