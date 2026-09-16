/**
 * An agent that has gone quiet for a long time, said and never acted on
 * (CGLAB-201).
 *
 * WARN ONLY. NEVER KILL, NEVER FAIL, NEVER RETRY. The reason belongs in the
 * code rather than in a card, because the next person to read this will be
 * tempted by exactly the thing it forbids: a false positive - a slow but
 * correct agent - costs more than a false negative, because killing good work
 * is irreversible while an occupied slot is visible and reversible. If this
 * module ever grows a path that ends, abandons or relaunches anything, it has
 * become a different feature.
 *
 * THERE IS NO TASK TIMEOUT, and that absence is deliberate. An agent forty
 * minutes into a hard problem is working, not stuck, and nothing on this
 * machine can tell those apart. A readiness budget at launch is a different
 * thing and a reasonable one; a budget on the WORK is a guess dressed as a
 * policy.
 */
import type { SessionState } from './sessionRow';

/**
 * How long silence has to last before it is worth mentioning.
 *
 * Derived, not chosen: the documented heartbeat cadence of five minutes
 * doubled, so one missed heartbeat is the earliest a run can honestly look
 * stalled. A number picked by taste does not survive its first argument.
 */
export const STALL_WARN_AFTER_MS = 10 * 60 * 1000;

export interface StallWarning {
  /** True when this is worth saying out loud. */
  readonly warn: boolean;
  /** Minutes of silence, rounded down. Zero when not warning. */
  readonly quietMinutes: number;
  /** The sentence, or null. Says what is observed, never what to do about it. */
  readonly text: string | null;
}

const QUIET: StallWarning = { warn: false, quietMinutes: 0, text: null };

export interface StallInput {
  readonly state: SessionState;
  /** When it last did something we could see. */
  readonly lastSeenAt?: string;
}

/**
 * Should anybody be told this one has gone quiet?
 *
 * Only a RUNNING agent can stall. A failed one has already said what happened,
 * a blocked one is waiting on a person by definition, and an unreachable one
 * has its own state and its own sentence - warning about it here would be the
 * same fact twice, in two voices, which is how a reader learns to trust
 * neither.
 */
export function stallWarning({ state, lastSeenAt }: StallInput, now: number = Date.now()): StallWarning {
  if (state !== 'running') return QUIET;
  const seen = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  // No timestamp is not evidence of silence. Warning here would fire on every
  // agent whose bookkeeping is merely incomplete.
  if (!Number.isFinite(seen)) return QUIET;

  const quiet = now - seen;
  if (quiet <= STALL_WARN_AFTER_MS) return QUIET;

  const quietMinutes = Math.floor(quiet / 60_000);
  return {
    warn: true,
    quietMinutes,
    /*
     * Observation, not instruction. "Kill it" or "retry" would be this module
     * deciding, and it does not decide - it is the one place in the product
     * that exists purely to say what it sees.
     */
    text: `Quiet for ${quietMinutes} min. It may be working on something long.`,
  };
}
