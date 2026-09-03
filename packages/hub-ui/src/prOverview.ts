// Pure helpers for the PR Overview page — kept out of the component so they can
// be unit-tested without a DOM.

/** Ordinal PR-size ramp (XS→XL): a single teal hue climbing in weight, so a
 *  bigger PR reads as a denser colour. Separate from status colours on purpose. */
/** Size ramp: light → dark on the dark canvas. `color` is the fill; `text`
 *  is the label color when text is rendered ON the fill (the drill-down modal
 *  badge, CGLAB-131) — the ramp's light end is near-white, so one fixed
 *  `text-white` reads as a blank white box there; light steps take the dark
 *  primary ink, dark steps take white. */
export const SIZE_META = [
  { key: 'xs', label: 'XS', color: '#dbf7f0', text: '#000f3b' },
  { key: 's', label: 'S', color: '#7fe5ca', text: '#000f3b' },
  { key: 'm', label: 'M', color: '#04cc98', text: '#000f3b' },
  { key: 'l', label: 'L', color: '#056f71', text: '#ffffff' },
  { key: 'xl', label: 'XL', color: '#00332f', text: '#ffffff' },
] as const;

export type SizeKey = typeof SIZE_META[number]['key'];

/** Every calendar day in [from, to] inclusive, as YYYY-MM-DD (UTC). Capped so a
 *  pathological range can't build an unbounded array. */
export function buildDayAxis(from: string, to: string): string[] {
  const start = new Date(from.slice(0, 10) + 'T00:00:00Z');
  const end = new Date(to.slice(0, 10) + 'T00:00:00Z');
  const out: string[] = [];
  const cur = new Date(start);
  while (cur <= end && out.length < 366) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** Rounded percentage change vs a baseline. Returns null when there is no
 *  baseline to compare against (a 0→N jump isn't a meaningful percentage). */
export function pctDelta(curr: number, prev: number): number | null {
  if (!prev || prev <= 0) return null;
  return Math.round(((curr - prev) / prev) * 100);
}
