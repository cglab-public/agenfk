// Pure helpers for the PR Overview page — kept out of the component so they can
// be unit-tested without a DOM.

/** Ordinal PR-size ramp (XS→XL): one indigo hue climbing in weight, from the
 *  --size-N tokens so each theme gets its own validated steps (CGLAB-434).
 *  `text` is the ink for a label drawn ON the fill (the drill-down badge,
 *  CGLAB-131): --on-size-N is the readable ink for that step in each theme. */
export const SIZE_META = [
  { key: 'xs', label: 'XS', color: 'var(--size-1)', text: 'var(--on-size-1)' },
  { key: 's', label: 'S', color: 'var(--size-2)', text: 'var(--on-size-2)' },
  { key: 'm', label: 'M', color: 'var(--size-3)', text: 'var(--on-size-3)' },
  { key: 'l', label: 'L', color: 'var(--size-4)', text: 'var(--on-size-4)' },
  { key: 'xl', label: 'XL', color: 'var(--size-5)', text: 'var(--on-size-5)' },
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
