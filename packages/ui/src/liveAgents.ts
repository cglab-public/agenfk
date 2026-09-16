/**
 * Which cards have an agent working on them right now (CGLAB-170).
 *
 * Liveness is derived from the RECENCY of run events, not from
 * `AgentRun.status`, and the reason is NOT the one this comment used to give.
 * It claimed the hook never issues the closing `PATCH /agent-runs/:id` (BUG
 * df4b3343) so `status` was stuck on `'running'` forever. That was true when it
 * was written and is not true now: `bin/agenfk-run-hook.mjs` closes the run on
 * `Stop`/`SessionEnd`. Anything reasoning about a run ENDING should read
 * `status` — see liveSessions.ts, which was built on the stale premise and had
 * to be rewritten.
 *
 * Recency survives that correction because it answers a different question.
 * This is the DOT: "is an agent touching this card right now", which a status
 * field cannot say — a run is `'running'` from its first event to its last,
 * including the hours it sits waiting for a person. A stalled agent stops
 * glowing by itself; a `'running'` row would glow until it was closed.
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
    /*
     * LIVE, not merely KNOWN. `has()` is presence, and the two part company
     * exactly when it matters: an entry that aged past the TTL is still in the
     * map until the 5s sweep removes it, and one that is re-touched inside
     * that gap is never swept at all. Reading presence there said "already
     * lit" about a card that had gone dark, so no listener was told it came
     * back — the dot stayed off, and anything derived from `liveIds()` stayed
     * staler than `isLive()` until some unrelated card happened to emit.
     */
    const wasLive = this.isLive(itemId);
    this.lastSeen.set(itemId, Date.now());
    this.ensureSweeping();
    // Only when something VISIBLE changed. An agent emits events constantly,
    // and re-rendering the board on each one — when the card was already lit —
    // is the difference between an indicator and a performance problem.
    if (!wasLive) this.emit();
  }

  /**
   * When this card was last heard from, in ms, or undefined if never.
   *
   * Separate from `isLive` because they answer different questions: `isLive`
   * asks "within the 90s window", this asks "how long ago", and the stall
   * warning needs the second. It used to be handed `startedAt` instead - the
   * only time a SessionRow carried - so "quiet for N minutes" really meant
   * "started N minutes ago", and an agent emitting output continuously for 45
   * minutes was labelled quiet for 45 minutes.
   */
  lastSeenAt(itemId: string): number | undefined {
    return this.lastSeen.get(itemId);
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
