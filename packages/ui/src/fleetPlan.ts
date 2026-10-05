/**
 * Who would actually run, if you pressed Launch (CGLAB-207).
 *
 * Choosing an epic and dispatching its children is where a fan-out gets paid
 * for: a child that cannot start, found AFTER spending three agents, has cost
 * real money to learn what was already known.
 *
 * THE BUTTON COUNTS WHAT WILL RUN, not how many children exist. "Launch 3",
 * never "Launch 4" with one silently held. That is the easiest thing to get
 * wrong here and the most damaging, because a count is the one part of this
 * screen a person trusts without checking.
 *
 * NOTHING IS AUTOMATIC. This computes and returns; the person launches. Same
 * principle the rest of this design keeps: work out the right move, show it,
 * and wait.
 *
 * It is a SECOND READING of decisions made elsewhere, never a second opinion.
 * Depth comes from the fan-out module and failures from the circuit breaker -
 * a screen that disagreed with the server would say free where the server
 * refuses, and the reader has no way to tell which of them is lying.
 */
export type HoldReason = 'too-deep' | 'circuit-broken' | 'already-running';

/** A card as the plan reads it. */
export interface FleetCard {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly parentId?: string | null;
}

export interface FleetChild {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  /** Whether it would be launched, or is held back. */
  readonly launch: boolean;
  /** Why it is held. Null when it would launch. */
  readonly hold: HoldReason | null;
  /** Sentence for the row, naming the move. Null when it would launch. */
  readonly holdText: string | null;
}

export interface FleetPlan {
  readonly parentId: string;
  readonly children: readonly FleetChild[];
  /** How many would actually start. This is the number on the button. */
  readonly launchCount: number;
  /** How many are held back, for the summary line. */
  readonly heldCount: number;
  /**
   * A reason the WHOLE fan-out cannot happen, independent of any child.
   * Null when at least one child could start.
   */
  readonly blocked: string | null;
}

/**
 * Statuses whose cards are not work to dispatch, whatever flow is in play.
 *
 * A NAME LIST CANNOT SEE A CUSTOM FLOW. An item's status IS its flow step's
 * name, and `agenfk flow create` produces an exit step called whatever the
 * author typed - so a finished child on such a flow is not in this set, and the
 * sheet counted it as launchable: "Launch 4" over a card that is already done.
 * That is the same name-keying the sibling gate had, in the one number the
 * sheet promises never to be generous about. `terminalStatuses` supplies the
 * names this cannot know.
 */
const NOT_DISPATCHABLE = new Set(['DONE', 'TRASHED', 'ARCHIVED', 'IDEAS']);

export interface FleetInputs {
  readonly parentId: string;
  /**
   * Consecutive failures per card (CGLAB-202), when known.
   *
   * Asked BEFORE spending. A card that has failed three times in a row is
   * refused here rather than after it costs a fourth agent, which is the whole
   * point of having the count at all.
   */
  readonly failures?: ReadonlyMap<string, number>;
  /**
   * Cards that already have a terminal open.
   *
   * THE COUNT HAS TO KNOW. The sheet's one promise is that the button counts
   * what will run, and the dispatcher applied a second predicate this plan knew
   * nothing about: a child with an open session was silently turned into
   * "switch to that tab" and no agent started for it. So "Launch 3" counted a
   * card it was never going to launch - the promise broken by a rule living in
   * the wrong place.
   *
   * Held rather than filtered out, so the sheet SAYS why. A child that
   * disappears from the list is a count somebody has to reconcile by hand.
   */
  readonly running?: ReadonlySet<string>;
  /**
   * The project flow's OWN exit step name(s), when known.
   *
   * The literal list above cannot see a custom flow; this is where its terminal
   * step arrives. Absent when the flow was not read, which keeps the behaviour
   * exactly what it was rather than guessing.
   */
  readonly terminalStatuses?: ReadonlySet<string>;
  /** Every item in the project; the parent's children are picked from it. */
  readonly all: readonly FleetCard[];
  /** Whether the parent may fan out at all, and why not. */
  readonly depth: { readonly allowed: boolean; readonly reason: string | null };
}

/** The plan for one parent, its children in order. */
export function planFleet({ parentId, all, depth, failures, running, terminalStatuses }: FleetInputs): FleetPlan {
  const kids = all.filter(i => i.parentId === parentId
    && !NOT_DISPATCHABLE.has(i.status.toUpperCase())
    // The flow's own exit step, matched as written: a status IS the step name.
    && !terminalStatuses?.has(i.status));

  if (!depth.allowed) {
    /*
     * The ceiling refuses the whole fan-out rather than each child, because
     * the reason is about the PARENT and repeating it per row would read as
     * four problems where there is one.
     */
    return {
      parentId,
      children: kids.map(k => ({
        id: k.id, title: k.title, status: k.status,
        launch: false, hold: 'too-deep' as const, holdText: null,
      })),
      launchCount: 0,
      heldCount: kids.length,
      blocked: depth.reason,
    };
  }

  const children: FleetChild[] = [];
  for (const kid of kids) {
    /*
     * Already has a terminal: the dispatcher will take you to that tab rather
     * than start a second agent in the same worktree, which is the right
     * behaviour and the wrong thing to count.
     */
    if (running?.has(kid.id)) {
      children.push({
        id: kid.id, title: kid.title, status: kid.status,
        launch: false, hold: 'already-running',
        holdText: 'It already has a terminal open. Launching would not start a second agent, '
          + 'it would take you to the one that is running.',
      });
      continue;
    }

    // A card stopped after three failures is waiting on a person.
    const breaker = dispatchAllowed(failures?.get(kid.id) ?? 0);
    if (!breaker.allowed) {
      children.push({
        id: kid.id, title: kid.title, status: kid.status,
        launch: false, hold: 'circuit-broken',
        holdText: breaker.reason,
      });
      continue;
    }

    children.push({
      id: kid.id, title: kid.title, status: kid.status,
      launch: true, hold: null, holdText: null,
    });
  }

  const launchCount = children.filter(c => c.launch).length;
  return {
    parentId,
    children,
    launchCount,
    heldCount: children.length - launchCount,
    blocked: launchCount === 0 && children.length > 0
      ? 'Nothing here can start - every child is already running or stopped after repeated failures.'
      : null,
  };
}

/**
 * How deep a card sits, and whether it may fan out (CGLAB-199).
 *
 * DUPLICATED from packages/core/src/fanOut.ts, and for the reason this file
 * already carries once: core compiles to CommonJS, and importing it into the
 * browser bundle shipped a black window with every test and the build green.
 * A parity test pins the two together - it can import core, because it runs
 * where core resolves to source, which is what the bundle cannot do.
 */
export function fanOutDepthLocal(
  itemId: string,
  items: readonly { id: string; parentId?: string | null }[],
): number {
  const byId = new Map(items.map(i => [i.id, i]));
  const seen = new Set<string>([itemId]);
  let depth = 0;
  let current = byId.get(itemId)?.parentId ?? null;
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    depth += 1;
    current = byId.get(current)?.parentId ?? null;
  }
  return depth;
}

/** Mirrors `mayFanOut`. Asks about the CHILDREN, not the card. */
export function mayFanOutLocal(
  itemId: string,
  items: readonly { id: string; parentId?: string | null }[],
  maxDepth = 1,
): { allowed: boolean; reason: string | null } {
  const depth = fanOutDepthLocal(itemId, items);
  if (depth + 1 > maxDepth) {
    return {
      allowed: false,
      reason: `This card is ${depth} level${depth === 1 ? '' : 's'} deep and the fan-out ceiling is ${maxDepth}. `
        + 'Work its children yourself, or raise the ceiling deliberately. '
        + 'Starting a fresh dispatch does not reset this: depth is where a card sits, not how it was reached.',
    };
  }
  return { allowed: true, reason: null };
}

/**
 * Mirrors `mayDispatch` in packages/core/src/circuitBreaker.ts (CGLAB-202).
 *
 * Duplicated for the reason this file already carries twice: core compiles to
 * CommonJS and importing it into the browser bundle shipped a black window.
 * A parity test holds the copy against the original.
 */
export const CIRCUIT_BREAK_AFTER_LOCAL = 3;

export function dispatchAllowed(failureCount: number): { allowed: boolean; reason: string | null } {
  if (failureCount >= CIRCUIT_BREAK_AFTER_LOCAL) {
    return {
      allowed: false,
      reason: `Stopped after ${failureCount} consecutive failures. `
        + 'Somebody has to look at this one before it runs again.',
    };
  }
  return { allowed: true, reason: null };
}

/** The button's label. Counts what will run, never what exists. */
export function launchLabel(plan: FleetPlan): string {
  if (plan.launchCount === 0) return 'Nothing to launch';
  return `Launch ${plan.launchCount}`;
}
