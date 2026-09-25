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

export interface BlockingCheck {
  id: string;
  blocking?: boolean;
  detail?: string;
  params?: Record<string, unknown>;
  /** Stamped by the server when it judged the check (C3b); never parsed from `detail`. */
  meta?: { waiting?: { kind: string; hash: string; command?: string } };
}

/** The command a check is waiting on a person to approve, when it is (C3b). */
export const commandWaitedOn = (c: BlockingCheck): { hash: string; command?: string } | null =>
  c.id.startsWith('command-check:') && c.meta?.waiting?.kind === 'command-approval' && c.meta.waiting.hash
    ? { hash: c.meta.waiting.hash, command: c.meta.waiting.command } : null;

/** Does this check wait for a PERSON? The step's approval, or a command waiting for its approval (C3b). */
export function waitsForPerson(c: BlockingCheck): boolean {
  return c.id === 'human-approval' || commandWaitedOn(c) !== null;
}

/** Is a person's approval the only thing blocking the card? */
export function onlyApprovalBlocks(checks: readonly BlockingCheck[] | undefined): boolean {
  const blocking = (checks ?? []).filter(c => c.blocking);
  return blocking.length > 0 && blocking.every(waitsForPerson);
}

/**
 * May this run open a browser and wait? Not in CI: no person can approve there.
 * There is deliberately no switch to turn it off (961f301d): an agent used one
 * to skip the wait, and the person never saw the card waiting for them.
 */
export function waitAllowed(env: Record<string, string | undefined>): boolean {
  return !(env.CI && env.CI !== 'false' && env.CI !== '0');
}

export interface GatesSnapshot {
  step: string;
  approvals: readonly unknown[];
  /** The project's approved commands (C3b): an argv hash, and when it was approved. */
  commandApprovals?: ReadonlyArray<{ hash: string; at: string }>;
}

/** When `hash` was approved in this snapshot, or null. */
export const approvedAt = (g: Pick<GatesSnapshot, 'commandApprovals'> | null | undefined, hash: string): string | null =>
  g?.commandApprovals?.find(a => a.hash === hash)?.at ?? null;

export interface WaitOptions {
  /** The step the card was refused on. */
  step: string;
  /** Approvals already counted when it was refused: only a newer one is news. */
  approvalsBefore: number;
  /**
   * The commands the refusal waits on, with when each was approved at that
   * moment (null: not approved). Only a change for ONE OF THESE is news: an
   * unrelated command approved in the same project must not wake this wait.
   */
  commandsWaitedOn?: ReadonlyArray<{ hash: string; approvedAt: string | null }>;
  poll: () => Promise<GatesSnapshot>;
  intervalMs: number;
  deadlineMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait until an approval newer than the refusal lands - 'approved' - the card
 * leaves the step some other way - 'moved' - or the deadline passes - 'timeout'.
 * A failed poll is a blip, not an answer: it keeps waiting.
 */
export async function waitForApproval(o: WaitOptions): Promise<'approved' | 'moved' | 'timeout'> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const until = now() + o.deadlineMs;
  for (;;) {
    try {
      const g = await o.poll();
      // Left the step some other way (a person moved it): there is nothing left to wait FOR.
      if (g.step !== o.step) return 'moved';
      if (g.approvals.length > o.approvalsBefore) return 'approved';
      if ((o.commandsWaitedOn ?? []).some(c => approvedAt(g, c.hash) !== c.approvedAt)) return 'approved';
    } catch { /* a blip: poll again */ }
    if (now() >= until) return 'timeout';
    await sleep(o.intervalMs);
  }
}

/**
 * Did an approval land while the refused verify was still running? (C3b review)
 *
 * The gate reads the step's approvals before it runs the command checks, which
 * may take minutes; a person approving meanwhile is in the snapshot read AFTER
 * the refusal and would never look "newer" to the wait. When what the refusal
 * blocked on is already satisfied in that snapshot, verify again at once.
 */
export function alreadySatisfied(checks: readonly BlockingCheck[] | undefined, g: GatesSnapshot | null): boolean {
  if (!g) return false;
  const blocking = (checks ?? []).filter(c => c.blocking);
  if (!blocking.length) return false;
  return blocking.every(c => {
    if (c.id === 'human-approval') return g.approvals.length > 0;
    const w = commandWaitedOn(c);
    return w ? approvedAt(g, w.hash) !== null : false;
  });
}
