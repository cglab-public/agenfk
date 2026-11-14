/**
 * One once-a-second clock for the board (9569b4d7).
 *
 * Every running verify shows its elapsed time, which has to tick. A timer per
 * card is what sharedTick.ts undid for the rail's spinners: a busy board would
 * wake the renderer once per card, every second. So the badges share this one,
 * and it runs only while something watches it.
 */
type Watcher = () => void;

const watchers = new Set<Watcher>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Call `watcher` once a second until the returned function is called. */
export function subscribeToSeconds(watcher: Watcher): () => void {
  watchers.add(watcher);
  if (!timer) timer = setInterval(() => { for (const w of [...watchers]) w(); }, 1000);
  return () => {
    watchers.delete(watcher);
    if (!watchers.size && timer) { clearInterval(timer); timer = null; }
  };
}

/** 0s, 5s, 1m 12s, 1h 2m. A clock slightly behind the server reads 0s, never negative. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
