// Chart colours (CGLAB-434). Every colour is a CSS variable from
// brand/tokens.css, so each theme gets its own validated steps.
//
// The six headline event types always wear the same colour, on every chart and
// page. Any other type is coloured per selection: it takes a slot the selection
// leaves free, so no two segments in one chart share a colour. That means such
// a type can change colour between views, and can borrow a headline type's hue
// when that type is not shown. Within-chart distinctness wins over cross-view
// stability for the long tail; the legend names every colour.

/**
 * The six event types people chart most, each pinned to one series slot for
 * good. The slot order is the validated palette order (indigo, teal, fuchsia,
 * amber, sky, rose). It carries no good/bad meaning - status colours are
 * reserved for state - but pass and fail must not read as warning and error, so
 * validate.passed takes the cool sky and validate.failed the rose.
 */
const FIXED: Record<string, number> = {
  'item.closed': 1,
  'item.created': 2,
  'step.transitioned': 3,
  'pr.opened': 4,
  'validate.passed': 5,
  'validate.failed': 6,
};
export const HEADLINE_TYPES = Object.keys(FIXED);

/** Past six colours: one neutral colour, never a generated seventh hue. */
export const OTHER_COLOR = 'var(--text-tertiary)';

/** An unfiltered chart (all events as one series). */
export const ALL_EVENTS_COLOR = 'var(--accent)';

/**
 * Colour for every selected event type. Headline types always get their own
 * slot. Any other selected types take the slots the selection leaves free, in
 * name order (so the click order never matters), and only past six colours
 * does anything fall back to OTHER_COLOR. The selection is required: a caller
 * cannot ask for one type's colour without saying what it is drawn beside.
 */
export function seriesColours(selected: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const taken = new Set<number>();
  for (const t of selected) {
    const slot = FIXED[t];
    if (slot) { out[t] = `var(--series-${slot})`; taken.add(slot); }
  }
  const free = [1, 2, 3, 4, 5, 6].filter(n => !taken.has(n));
  const others = [...new Set(selected.filter(t => !FIXED[t]))].sort();
  others.forEach((t, i) => { out[t] = i < free.length ? `var(--series-${free[i]})` : OTHER_COLOR; });
  return out;
}

/** Heatmap cell fill for a 0..1 intensity; undefined leaves an empty cell unfilled. */
export function heatColor(intensity: number): string | undefined {
  if (!(intensity > 0)) return undefined;
  // 20% floor so the faintest filled cell still stands off an empty one.
  const pct = Math.min(100, 20 + 80 * intensity);
  return `color-mix(in srgb, var(--accent) ${Number(pct.toFixed(1))}%, transparent)`;
}

export const SPARK_STROKE = 'var(--accent)';
