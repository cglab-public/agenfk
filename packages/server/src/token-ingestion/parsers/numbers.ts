/** A finite number from a session log field, or the fallback when it is absent or not a number. */
export function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
