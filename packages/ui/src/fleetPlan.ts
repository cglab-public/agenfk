/**
 * Who would actually run, if you pressed Launch (CGLAB-207).
 *
 * Choosing an epic and dispatching its children is the point of the whole
 * mechanism, and it is also where it gets paid for: a fan-out that discovers a
 * file collision AFTER spending three agents has cost real money to learn what
 * the gatekeeper already knew.
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
 * Collisions come from the claim gate and depth from the fan-out module - a
 * screen that disagreed with the server would say free where the server
 * refuses, and the reader has no way to tell which of them is lying.
 */
import { claimStateOf, type ClaimCard } from './claimState';

export type HoldReason = 'claimed-by-sibling' | 'claimed-elsewhere' | 'unreadable-claim' | 'too-deep';

export interface FleetChild {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly claims?: readonly string[];
  /** Whether it would be launched, or is held back. */
  readonly launch: boolean;
  /** Why it is held. Null when it would launch. */
  readonly hold: HoldReason | null;
  /** Sentence for the row, naming the move. Null when it would launch. */
  readonly holdText: string | null;
  /** Cards this one runs into, when that is why it is held. */
  readonly heldBy: readonly string[];
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

/** Statuses whose cards are not work to dispatch. */
const NOT_DISPATCHABLE = new Set(['DONE', 'TRASHED', 'ARCHIVED', 'IDEAS']);

export interface FleetInputs {
  readonly parentId: string;
  /** Every item in the project. Needed whole: holders can be anywhere. */
  readonly all: readonly (ClaimCard & { title: string; parentId?: string | null })[];
  /** Whether the parent may fan out at all, and why not. */
  readonly depth: { readonly allowed: boolean; readonly reason: string | null };
}

/**
 * The plan for one parent.
 *
 * Children are evaluated IN ORDER and a launched child's claims count against
 * the ones after it. Two siblings wanting the same file cannot both launch and
 * cannot both be held: one goes, one waits. Evaluating them independently
 * would return either both-launch, which is the race this prevents, or
 * both-held, which is a deadlock nobody asked for.
 */
export function planFleet({ parentId, all, depth }: FleetInputs): FleetPlan {
  const kids = all.filter(i => i.parentId === parentId && !NOT_DISPATCHABLE.has(i.status.toUpperCase()));

  if (!depth.allowed) {
    /*
     * The ceiling refuses the whole fan-out rather than each child, because
     * the reason is about the PARENT and repeating it per row would read as
     * four problems where there is one.
     */
    return {
      parentId,
      children: kids.map(k => ({
        id: k.id, title: k.title, status: k.status, claims: k.claims,
        launch: false, hold: 'too-deep' as const, holdText: null, heldBy: [],
      })),
      launchCount: 0,
      heldCount: kids.length,
      blocked: depth.reason,
    };
  }

  const children: FleetChild[] = [];
  /*
   * Everybody who holds paths and is NOT part of this fan-out.
   *
   * The siblings are excluded on purpose and it is the load-bearing detail:
   * with all of them in the list, two children wanting one file each see the
   * other as a holder and BOTH are held - a deadlock, where the whole point is
   * that one goes and one waits. A sibling only starts holding once it has
   * been cleared to launch.
   */
  const kidIds = new Set(kids.map(k => k.id));
  const outsiders = all.filter(i => !kidIds.has(i.id));
  const takenBySiblings: ClaimCard[] = [];

  for (const kid of kids) {
    const state = claimStateOf(kid.id, [kid, ...outsiders, ...takenBySiblings]);

    if (state.rejected.length) {
      children.push({
        id: kid.id, title: kid.title, status: kid.status, claims: kid.claims,
        launch: false, hold: 'unreadable-claim', heldBy: [],
        holdText: `Its claim cannot be checked and protects nothing: ${state.rejected.join(', ')}. `
          + 'A claim is a directory or an exact file.',
      });
      continue;
    }

    if (state.heldBy.length) {
      /*
       * Named differently depending on WHO holds it, because the move is
       * different: a sibling in this same fan-out will finish and release, so
       * waiting is the answer; a card outside it may sit there for days, and
       * then somebody has to go and ask.
       */
      const bySibling = state.heldBy.some(h => kids.some(k => k.id === h))
        || takenBySiblings.some(t => state.heldBy.includes(t.id));
      children.push({
        id: kid.id, title: kid.title, status: kid.status, claims: kid.claims,
        launch: false,
        hold: bySibling ? 'claimed-by-sibling' : 'claimed-elsewhere',
        heldBy: state.heldBy,
        holdText: bySibling
          ? 'Another child in this fan-out owns the same path. It waits for that one to finish.'
          : `Held by ${state.heldBy.map(id => id.slice(0, 8)).join(', ')}, outside this fan-out.`,
      });
      continue;
    }

    children.push({
      id: kid.id, title: kid.title, status: kid.status, claims: kid.claims,
      launch: true, hold: null, holdText: null, heldBy: [],
    });
    // Only a LAUNCHED child takes its paths. A held one holds nothing, and
    // counting it would cascade one collision into a stalled fan-out.
    if (kid.claims?.length) takenBySiblings.push({ id: kid.id, status: 'IN_PROGRESS', claims: kid.claims });
  }

  const launchCount = children.filter(c => c.launch).length;
  return {
    parentId,
    children,
    launchCount,
    heldCount: children.length - launchCount,
    blocked: launchCount === 0 && children.length > 0
      ? 'Nothing here can start yet - every child is waiting on a path somebody else owns.'
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

/** The button's label. Counts what will run, never what exists. */
export function launchLabel(plan: FleetPlan): string {
  if (plan.launchCount === 0) return 'Nothing to launch';
  return `Launch ${plan.launchCount}`;
}
