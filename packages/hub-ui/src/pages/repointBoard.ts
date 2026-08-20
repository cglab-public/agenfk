// Pure helpers for the repoint campaign drain board (CGLAB-66).
//
// The board answers one question: is it safe to drop the old DNS name yet? It
// is safe only when every installation has confirmed the move ON the new name,
// which is why the hub refuses to mark a target succeeded on any weaker
// evidence. Everything here is about making the remaining work — and the
// specific rows blocking it — legible.

export type TargetState = 'pending' | 'succeeded' | 'blocked_by_env' | 'failed' | 'cancelled';

export interface RepointTargetLike {
  installationId: string;
  state: TargetState | string;
  lastSeen: string | null;
  gitEmail: string | null;
  gitName: string | null;
  osUser: string | null;
  errorMessage: string | null;
  reportedUrl: string | null;
}

/** done = confirmed. waiting = will move on its own. The rest need a human. */
export type TargetClass = 'done' | 'stale' | 'blocked' | 'failed' | 'waiting';

/**
 * Has this installation gone quiet since the campaign opened? If so it cannot
 * have seen the directive and will never move on its own — a wiped laptop or a
 * departed dev's machine. Retiring it (CGLAB-64) is how a campaign that would
 * otherwise hang forever gets to finish.
 *
 * A succeeded target is never stale: its confirmation IS contact, whatever the
 * last-seen timestamp happens to say.
 */
export function isStale(target: RepointTargetLike, campaignOpenedAt: string): boolean {
  if (target.state === 'succeeded') return false;
  if (!target.lastSeen) return true;
  const seen = Date.parse(target.lastSeen);
  const opened = Date.parse(campaignOpenedAt);
  // An unreadable timestamp is treated as stale: the safe direction is to make
  // the admin look at the row rather than quietly counting it as healthy.
  if (Number.isNaN(seen) || Number.isNaN(opened)) return true;
  return seen < opened;
}

export function classifyTarget(target: RepointTargetLike, campaignOpenedAt: string): TargetClass {
  if (target.state === 'succeeded') return 'done';
  if (target.state === 'blocked_by_env') return 'blocked';
  if (target.state === 'failed') return 'failed';
  return isStale(target, campaignOpenedAt) ? 'stale' : 'waiting';
}

/** Most-actionable first: the rows an admin must personally deal with. */
const CLASS_ORDER: Record<TargetClass, number> = {
  stale: 0,   // needs retiring
  failed: 1,  // needs diagnosing
  blocked: 2, // needs an env var changed
  waiting: 3, // needs nothing but time
  done: 4,
};

export function sortTargets<T extends RepointTargetLike>(targets: T[], campaignOpenedAt: string): T[] {
  return [...targets].sort(
    (a, b) => CLASS_ORDER[classifyTarget(a, campaignOpenedAt)] - CLASS_ORDER[classifyTarget(b, campaignOpenedAt)],
  );
}

export interface DrainSummary {
  total: number;
  done: number;
  waiting: number;
  stale: number;
  blocked: number;
  failed: number;
}

export function drainSummary(targets: RepointTargetLike[], campaignOpenedAt: string): DrainSummary {
  const out: DrainSummary = { total: targets.length, done: 0, waiting: 0, stale: 0, blocked: 0, failed: 0 };
  for (const t of targets) out[classifyTarget(t, campaignOpenedAt)]++;
  return out;
}

/**
 * Whether the old DNS record can be retired. Deliberately false for an empty
 * fleet: no installations is an absence of evidence, not proof that nothing is
 * still resolving the old name.
 */
export function canDropOldName(targets: RepointTargetLike[], campaignOpenedAt: string): boolean {
  if (targets.length === 0) return false;
  return targets.every(t => classifyTarget(t, campaignOpenedAt) === 'done');
}
