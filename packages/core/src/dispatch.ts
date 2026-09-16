/**
 * One attempt to run one card on one agent (CGLAB-206).
 *
 * THE SCOPE IS DELIBERATELY SMALL, and choosing it was most of the work. The
 * obvious design is a parallel Run/Task/Dispatch model beside the existing one
 * - and it would be a second source of truth about what work exists, free to
 * drift from the cards. A CARD ALREADY IS A TASK: it has a state, a hierarchy,
 * claims and a failure count. A RUN is a fan-out of one parent, which the fleet
 * sheet already computes. What genuinely does not exist is the DISPATCH: the
 * attempt itself, which is the thing that can be in flight, come back, fail, or
 * go quiet.
 *
 * So this is the attempt, and nothing else.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is decompose. Nothing here turns an
 * objective into tasks; a person or an agent does that, and the sheet dispatches
 * what already exists. Automatic decomposition is its own problem and pretending
 * otherwise would put a guess at the root of every fan-out.
 *
 * A GATE NEEDS SOMEBODY ON THE OTHER SIDE. `resolveGate` refuses a resolution
 * that names the dispatcher as the resolver - a coordinator asking itself for
 * permission is not a checkpoint, it is a formality with a checkpoint's name,
 * and the shape is easy to ship without noticing.
 */

/**
 * Where an attempt is.
 *
 * `unverifiable` is here for the same reason it is in the session model: loss
 * of contact is not evidence of exit, and an attempt we cannot see is not one
 * that finished.
 */
export type DispatchState =
  | 'queued'        // decided on, not yet started
  | 'running'       // an agent has it
  | 'blocked'       // waiting on a person, and it says so
  | 'unverifiable'  // we cannot see it, and will not guess
  | 'done'
  | 'failed';

export interface Dispatch {
  readonly id: string;
  /** The card this attempt is for. */
  readonly itemId: string;
  /** Which fan-out it belongs to, when it came from one. */
  readonly runId?: string;
  readonly agentId: string;
  readonly state: DispatchState;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

/**
 * Transitions this machine allows.
 *
 * Written as a table rather than as `if`s so the illegal moves are VISIBLE:
 * the interesting thing about a state machine is what it refuses, and a nest
 * of conditions hides exactly that. Terminal states have no successors, which
 * is what makes them terminal rather than merely late.
 */
const ALLOWED: Record<DispatchState, readonly DispatchState[]> = {
  queued: ['running', 'failed'],
  // Not straight to done: an attempt that never ran has nothing to report, and
  // allowing it would let a bookkeeping slip look like completed work.
  running: ['blocked', 'unverifiable', 'done', 'failed'],
  // `done` is here because a blocked attempt can finish anyway: the question
  // stopped mattering, or the agent answered it itself. Leaving it out strands
  // the attempt in blocked forever.
  blocked: ['running', 'failed', 'unverifiable', 'done'],
  // Contact can come back. That is the whole point of the state - it is a gap
  // in knowledge, not a fate. `blocked` is reachable because contact returning
  // and a question arriving are frequently the same event, and without it the
  // question would be dropped.
  unverifiable: ['running', 'done', 'failed', 'blocked'],
  done: [],
  failed: [],
};

export interface TransitionResult {
  readonly allowed: boolean;
  /** Why not. Null when allowed. */
  readonly reason: string | null;
}

/** May this attempt move there? */
export function canTransition(from: DispatchState, to: DispatchState): TransitionResult {
  if (from === to) {
    // Not an error and not a move. Reporting it as allowed would let a caller
    // rewrite `startedAt` on a no-op.
    return { allowed: false, reason: `Already ${from}.` };
  }
  if (ALLOWED[from].includes(to)) return { allowed: true, reason: null };
  const terminal = ALLOWED[from].length === 0;
  return {
    allowed: false,
    reason: terminal
      ? `This attempt already ${from === 'done' ? 'finished' : 'failed'}. Start a new one rather than reopening it.`
      : `An attempt cannot go from ${from} to ${to}. It may go to: ${ALLOWED[from].join(', ')}.`,
  };
}

/** States from which nothing more happens. */
export function isTerminal(state: DispatchState): boolean {
  return ALLOWED[state].length === 0;
}

/**
 * What a worker can say back.
 *
 * Typed rather than free text, because the two that need a person - a question
 * and an escalation - must be distinguishable from progress without reading
 * prose. `heartbeat` carries nothing except that contact exists, which is the
 * only thing that can lift `unverifiable`.
 */
export type DispatchMessageKind = 'progress' | 'question' | 'escalation' | 'done' | 'heartbeat';

export interface DispatchMessage {
  readonly dispatchId: string;
  readonly kind: DispatchMessageKind;
  readonly text?: string;
}

/** Kinds that mean somebody has to read this before the attempt moves. */
const NEEDS_PERSON: ReadonlySet<DispatchMessageKind> = new Set(['question', 'escalation']);

export function messageNeedsPerson(kind: DispatchMessageKind): boolean {
  return NEEDS_PERSON.has(kind);
}

/**
 * Where a message leaves the attempt, or null when it changes nothing.
 *
 * `progress` deliberately returns null: an attempt that is running stays
 * running, and a machine that transitioned on every report would spend its
 * time confirming what it already knew.
 */
export function stateAfterMessage(current: DispatchState, kind: DispatchMessageKind): DispatchState | null {
  const proposed = proposedByMessage(current, kind);
  /*
   * THE TABLE HAS THE FINAL WORD, and routing through it is the point rather
   * than a formality. Every guarantee in this module lives in `ALLOWED`, so a
   * second function deciding states on its own is a way around all of them at
   * once - and the two did disagree in six places before this existed, each
   * plausible read on its own. Where the disagreement meant the table was too
   * tight, the table was widened above; where it meant the message should be
   * ignored, this drops it.
   */
  if (proposed === null) return null;
  return canTransition(current, proposed).allowed ? proposed : null;
}

/** What the message asks for, before the table rules on it. */
function proposedByMessage(current: DispatchState, kind: DispatchMessageKind): DispatchState | null {
  if (isTerminal(current)) return null;
  switch (kind) {
    case 'question':
    case 'escalation':
      return current === 'blocked' ? null : 'blocked';
    case 'done':
      return current === 'done' ? null : 'done';
    case 'heartbeat':
      /*
       * The one thing that lifts loss of contact: hearing from it at all. It
       * does NOT unblock a blocked attempt - the question is still unanswered,
       * and a heartbeat answering a question would be the machine deciding on
       * the agent's behalf.
       */
      return current === 'unverifiable' ? 'running' : null;
    case 'progress':
      return null;
  }
}

export interface GateResolution {
  readonly gateId: string;
  /** Who resolved it. */
  readonly resolvedBy: string;
  /** The dispatcher that raised it, so self-resolution can be refused. */
  readonly raisedBy: string;
}

/**
 * Accept a decision on a gate, or refuse it.
 *
 * A COORDINATOR CANNOT RESOLVE ITS OWN GATE. That is the whole guarantee, and
 * it is easy to ship without: check only that the caller is inside the run's
 * scope and the authorised caller turns out to BE the coordinating terminal -
 * a formality wearing a checkpoint's name. A gate exists to put a second party
 * in the loop, so the second party is what is checked.
 */
export function resolveGate({ gateId, resolvedBy, raisedBy }: GateResolution): TransitionResult {
  if (!resolvedBy.trim()) {
    return { allowed: false, reason: `Gate ${gateId} needs a named resolver. An anonymous approval is not one.` };
  }
  if (resolvedBy === raisedBy) {
    return {
      allowed: false,
      reason: `Gate ${gateId} was raised by ${raisedBy}, so ${raisedBy} cannot resolve it. `
        + 'A gate exists to put somebody else in the loop; resolving your own is a formality '
        + 'with a checkpoint\'s name.',
    };
  }
  return { allowed: true, reason: null };
}
