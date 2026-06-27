// Pure helpers for the PR Overview page — kept out of the component so they can
// be unit-tested without a DOM.

/** Ordinal PR-size ramp (XS→XL): a single indigo hue climbing in weight, so a
 *  bigger PR reads as a denser colour. Separate from status colours on purpose. */
export const SIZE_META = [
  { key: 'xs', label: 'XS', color: '#c7d2fe' },
  { key: 's', label: 'S', color: '#818cf8' },
  { key: 'm', label: 'M', color: '#6366f1' },
  { key: 'l', label: 'L', color: '#4f46e5' },
  { key: 'xl', label: 'XL', color: '#3730a3' },
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
