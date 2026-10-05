/**
 * Checks passed as a whole percentage of checks run, or null when none ran.
 * Rounding may not claim "nothing failed" or "nothing passed": 999 of 1000 is
 * 99, not 100, and 1 of 301 is 1, not 0.
 */
export function checkPassRate(passes: number, fails: number): number | null {
  const checks = passes + fails;
  if (checks === 0) return null;
  const pct = Math.round((passes / checks) * 100);
  return Math.min(fails > 0 ? 99 : 100, Math.max(passes > 0 ? 1 : 0, pct));
}
