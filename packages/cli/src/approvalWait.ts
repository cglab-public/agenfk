/**
 * c857900e — a verify that waits only for a person's approval.
 *
 * When human-approval is the ONLY check holding a card, the CLI opens the
 * board on it and waits for the go-ahead, then verifies again by itself: the
 * person approves, and the agent carries on with no message in its chat.
 * Anything else blocking too means waiting could never let the card go, so the
 * refusal is returned at once, as it always was.
 *
 * The wait is bounded because an agent's tool call is killed after minutes;
 * past the deadline the CLI says to run the same verify again, which waits
 * again. It is not gated on a TTY: an agent's shell never has one.
 */

export interface BlockingCheck { id: string; blocking?: boolean }

/** Is a person's approval the only thing blocking the card? */
export function onlyApprovalBlocks(checks: readonly BlockingCheck[] | undefined): boolean {
  const blocking = (checks ?? []).filter(c => c.blocking);
  return blocking.length > 0 && blocking.every(c => c.id === 'human-approval');
}

/** May this run open a browser and wait? Not with --no-wait, in CI, or with AGENFK_NO_BROWSER=1. */
export function waitAllowed(env: Record<string, string | undefined>, opts: { wait?: boolean }): boolean {
  if (opts.wait === false) return false;
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return false;
  if (env.AGENFK_NO_BROWSER === '1') return false;
  return true;
}

export interface GatesSnapshot { step: string; approvals: readonly unknown[] }

export interface WaitOptions {
  /** The step the card was refused on. */
  step: string;
  /** Approvals already counted when it was refused: only a newer one is news. */
  approvalsBefore: number;
  poll: () => Promise<GatesSnapshot>;
  intervalMs: number;
  deadlineMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait until an approval newer than the refusal lands, or the card has left
 * the step some other way - 'approved' - or the deadline passes - 'timeout'.
 * A failed poll is a blip, not an answer: it keeps waiting.
 */
export async function waitForApproval(o: WaitOptions): Promise<'approved' | 'timeout'> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const until = now() + o.deadlineMs;
  for (;;) {
    try {
      const g = await o.poll();
      if (g.step !== o.step || g.approvals.length > o.approvalsBefore) return 'approved';
    } catch { /* a blip: poll again */ }
    if (now() >= until) return 'timeout';
    await sleep(o.intervalMs);
  }
}
