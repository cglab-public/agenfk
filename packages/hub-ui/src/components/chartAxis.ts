/**
 * "Nice" y-axis ticks for an integer-count chart: 0 up to a round top at or
 * above `max`, at most about five evenly spaced values. Shared by the activity
 * timeline and the PR volume chart so their axes read the same way.
 */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const target = 4;
  const raw = max / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const step = Math.max(1, (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * pow);
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(Math.round(v));
  return out;
}
