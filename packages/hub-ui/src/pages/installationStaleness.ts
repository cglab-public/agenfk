// An installation that has sent nothing for two weeks is probably dead: its
// machine was wiped, or the person left. Both the overview's count and the
// Installations table's chip use this one threshold.
export const SILENT_DAYS = 14;

const DAY = 86_400_000;

/** Whole days since `lastSeen` once that reaches SILENT_DAYS; otherwise null. */
export function silentDays(lastSeen: string | null | undefined, now: number = Date.now()): number | null {
  if (!lastSeen) return null;
  const t = Date.parse(lastSeen);
  if (Number.isNaN(t)) return null;
  const days = Math.floor((now - t) / DAY);
  return days >= SILENT_DAYS ? days : null;
}
