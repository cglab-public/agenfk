/**
 * How deep a fan-out may go, and why it needs a floor at all (CGLAB-199).
 *
 * An agent that can dispatch agents has no bottom. Nothing between a
 * reasonable decomposition and a tree that expands on its own, spending real
 * money, is a property of the model - it has to be a number somebody chose.
 *
 * DEPTH IS DERIVED FROM THE ITEM TREE rather than counted into a new field.
 * The hierarchy already IS the nesting: an EPIC holding a STORY holding a TASK
 * is three levels, and a card dispatched by an agent working its parent sits
 * one level below it by construction. A separate counter would be a second
 * answer to the same question, free to drift from the first - which is how the
 * rail and the terminal came to disagree about whether an agent was well.
 *
 * THE CLAUSE THAT MAKES IT A LIMIT rather than a decoration: starting again
 * does not reset the count. Depth is a property of where a card SITS, not of
 * how it was reached, so re-asking through a different route answers the same.
 * Without that, any agent walks around the limit by opening a fresh path and
 * the number stops meaning anything.
 */

/** Default ceiling. One level of fan-out, raised deliberately or not at all. */
export const DEFAULT_MAX_FAN_OUT_DEPTH = 1;

/**
 * Where the shape stops being a fan-out and starts being a queue.
 *
 * Not enforced - a chain this long is a judgement, not an error - but worth
 * saying, because the cost is invisible until it is paid: a chain turns
 * latency into a SUM while a wave turns it into a MAX, and four sequential
 * steps of eight minutes is half an hour where four parallel ones are eight.
 */
export const CHAIN_LENGTH_WORTH_QUESTIONING = 4;

export interface FanOutItem {
  readonly id: string;
  readonly parentId?: string | null;
}

export interface FanOutVerdict {
  readonly allowed: boolean;
  /** How many ancestors this card has. A top-level card is 0. */
  readonly depth: number;
  /** What to tell the agent, naming the move. Null when allowed. */
  readonly reason: string | null;
}

/**
 * Ancestors between this card and the top.
 *
 * Returns the depth reached before any cycle, rather than looping forever. A
 * cycle should be impossible - the re-parent route refuses to make an item its
 * own descendant - but this function is asked questions about data that
 * arrives from storage, and hanging is a worse answer than a wrong number.
 */
export function fanOutDepth(itemId: string, items: readonly FanOutItem[]): number {
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

/**
 * May the agent working this card dispatch its children?
 *
 * The question is asked about the CHILDREN's depth, not the card's: a card at
 * the ceiling may still be worked, it just may not fan out further. Refusing
 * the card itself would strand work that is perfectly fine to do by hand.
 */
export function mayFanOut(
  itemId: string,
  items: readonly FanOutItem[],
  maxDepth: number = DEFAULT_MAX_FAN_OUT_DEPTH,
): FanOutVerdict {
  const depth = fanOutDepth(itemId, items);
  const childDepth = depth + 1;
  if (childDepth > maxDepth) {
    return {
      allowed: false,
      depth,
      reason: `This card is ${depth} level${depth === 1 ? '' : 's'} deep and the fan-out ceiling is ${maxDepth}. `
        + 'Work its children yourself, or raise the ceiling deliberately. '
        + 'Starting a fresh dispatch does not reset this: depth is where a card sits, not how it was reached.',
    };
  }
  return { allowed: true, depth, reason: null };
}

/**
 * The longest chain of single children under this card.
 *
 * A fan-out of one, repeated, is a queue wearing a tree's clothes - and it is
 * the shape that costs the most while looking like decomposition.
 */
export function longestChain(itemId: string, items: readonly FanOutItem[]): number {
  const childrenOf = new Map<string, FanOutItem[]>();
  for (const i of items) {
    if (!i.parentId) continue;
    const list = childrenOf.get(i.parentId) ?? [];
    list.push(i);
    childrenOf.set(i.parentId, list);
  }
  const walk = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const kids = childrenOf.get(id) ?? [];
    if (!kids.length) return 0;
    return 1 + Math.max(...kids.map(k => walk(k.id, seen)));
  };
  return walk(itemId, new Set());
}
