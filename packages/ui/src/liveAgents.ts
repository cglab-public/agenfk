/**
 * Which cards have an agent working on them right now (CGLAB-170).
 *
 * Liveness is derived from the RECENCY of run events, not from
 * `AgentRun.status`. The status field looks like the obvious source and is the
 * wrong one: BUG df4b3343 records that the hook never issues the closing
 * `PATCH /agent-runs/:id`, so `status` stays `'running'` and `endedAt` stays
 * null forever. Reading it would light every card that ever had a run,
 * permanently — trading one uninformative indicator for another.
 *
 * Recency is also the truer statement. "An agent touched this a moment ago" is
 * what a person actually wants to know, and a stalled agent stops glowing by
 * itself, which no status field would do.
 *
 * The hard part is going DARK. That happens with no event arriving, so it needs
 * a clock — and one clock for the whole board, not one per card. A busy board
 * with a timer each would wake the renderer hundreds of times independently.
 */

/** How long after its last event a card still counts as worked-on. */
export const LIVE_TTL_MS = 90_000;

/** How often the single shared clock checks for expiries. */
const SWEEP_MS = 5_000;

type Listener = () => void;

export class LiveAgents {
  private readonly lastSeen = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private sweep: ReturnType<typeof setInterval> | null = null;

  /** Record that an agent event arrived for this card. */
  touch(itemId: string): void {
    const wasLive = this.lastSeen.has(itemId);
    this.lastSeen.set(itemId, Date.now());
    this.ensureSweeping();
    // Only when something VISIBLE changed. An agent emits events constantly,
    // and re-rendering the board on each one — when the card was already lit —
    // is the difference between an indicator and a performance problem.
    if (!wasLive) this.emit();
  }

  isLive(itemId: string): boolean {
    const at = this.lastSeen.get(itemId);
    return at !== undefined && Date.now() - at < LIVE_TTL_MS;
  }

  liveIds(): string[] {
    return [...this.lastSeen.keys()].filter(id => this.isLive(id));
  }

  size(): number {
    return this.lastSeen.size;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    this.stopSweeping();
    this.lastSeen.clear();
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private ensureSweeping(): void {
    if (this.sweep) return;
    this.sweep = setInterval(() => this.expire(), SWEEP_MS);
  }

  private stopSweeping(): void {
    if (!this.sweep) return;
    clearInterval(this.sweep);
    this.sweep = null;
  }

  private expire(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, at] of [...this.lastSeen]) {
      if (now - at < LIVE_TTL_MS) continue;
      // Deleted, not just marked stale: the map would otherwise grow for the
      // life of the session, one entry per card ever worked.
      this.lastSeen.delete(id);
      changed = true;
    }
    // An idle board must not keep waking up.
    if (this.lastSeen.size === 0) this.stopSweeping();
    if (changed) this.emit();
  }
}
