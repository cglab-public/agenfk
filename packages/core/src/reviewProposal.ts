/**
 * Read a proposed decomposition, say what is wrong with it, write nothing.
 *
 * This is the half that makes "proposes, does not create" real. Without it the
 * only path from an agent's answer to the board is `create`, so the cards
 * would exist before the person reviewed them — and a screen that reviews
 * things which already exist is a confirmation dialog, not a gate (artifact
 * aca414c7 §06).
 *
 * It is pure, and it lives in core rather than in the route, so the rules can
 * be tested without a server and reused by the CLI later. NOTHING HERE TOUCHES
 * STORAGE. That is the property the whole feature rests on; a future edit that
 * needs a repository handle in this file is a sign the design moved.
 *
 * The input is data from a language model. It will be wrong in ways a
 * hand-written payload never is — refs that point nowhere, a type that sounds
 * right, two items pointing at each other — so every walk here is written to
 * survive garbage rather than to assume shape.
 */
import { ItemType } from './types';
import type { ProposedItem, ProposedTree } from './decompositionContract';

/**
 * A person reviews this list one row at a time. Past a hundred rows they are
 * not reviewing, they are scrolling, and the approval gate stops meaning
 * anything — which matters more than any parser limit.
 */
export const MAX_PROPOSED_ITEMS = 100;

export interface ProposalIssue {
  /** Index into the items array, or undefined for a problem with the tree itself. */
  index?: number;
  ref?: string;
  message: string;
}

export interface ReviewedItem extends ProposedItem {
  /** How deep this sits, so the caller can indent the tree it draws. */
  depth: number;
}

export interface ReviewedProposal {
  objective: string;
  items: ReviewedItem[];
  issues: ProposalIssue[];
}

const TYPES = new Set<string>(Object.values(ItemType));

/**
 * The value of a field that is SUPPOSED to be a string.
 *
 * `(x ?? '').trim()` guards null and undefined and nothing else, so `ref: 1` —
 * one of the commonest things a model emits when told "a short id you invent"
 * — threw TypeError out of the route as a 500 with a stack trace. The whole
 * feature's failure mode was "the person gets a 500 instead of a proposal".
 * Returns null when the value is present but not a string, so the caller can
 * name WHICH field had the wrong type instead of guessing.
 */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value.trim() : null;
}

/**
 * Which parent each type may have. Absent from this map means "any parent".
 *
 * A MAP, not an object literal: `ALLOWED_PARENT['constructor']` on a literal
 * returns a function, and `.has` on it threw a 500 out of the route. `type` is
 * attacker-adjacent by construction — it is whatever a model wrote.
 *
 * ONLY THE EPIC RULES ARE HERE, and that is a correction. The first version
 * also refused TASK-under-TASK, BUG-under-TASK and STORY-under-STORY — a
 * hierarchy that exists NOWHERE else in AgEnFK: the real write path,
 * `validateParentAssignment`, checks that the parent exists, is in the same
 * project, and makes no cycle, and no type rule at all. A proposal screen that
 * refuses a subtask tree the board would accept thirty seconds later is
 * inventing product rules. What stays is rule 1, which IS doctrine: an EPIC is
 * a container, never worked directly and never owned by the work inside it.
 */
const ALLOWED_PARENT = new Map<string, ReadonlySet<string | null>>([
  [ItemType.EPIC, new Set([null])],
  [ItemType.STORY, new Set([null, ItemType.EPIC])],
]);

export function reviewProposal(tree: ProposedTree): ReviewedProposal {
  const issues: ProposalIssue[] = [];
  const items = Array.isArray(tree?.items) ? tree.items : [];

  const objectiveText = asText((tree as any)?.objective);
  if (objectiveText === null || !objectiveText) {
    issues.push({ message: 'The objective is missing. A proposal with no objective cannot be reviewed against anything.' });
  }
  if (items.length === 0) {
    issues.push({ message: 'The proposal contains no items. "Nothing to do" is an item, not an empty answer.' });
  }
  if (items.length > MAX_PROPOSED_ITEMS) {
    /*
     * RETURN, do not merely complain. Pass 3 walks every item's ancestor
     * chain, so a long chain is O(n²) on the single process that also serves
     * REST, Socket.io and — in the desktop — the UI bundle. Measured on one
     * chain: 20k items froze it for 8.9s, 50k for 71s, and the body limit is
     * 50MB. Nobody has to attack this; one agent retry loop reaches it.
     */
    return {
      objective: objectiveText ?? '',
      items: [],
      issues: [...issues, { message: `The proposal contains ${items.length} items; ${MAX_PROPOSED_ITEMS} is the most a person will review item by item.` }],
    };
  }

  // Pass 1: the fields, and the ref index every later check needs.
  const byRef = new Map<string, number>();
  items.forEach((item, index) => {
    const refText = asText((item as any)?.ref);
    if (refText === null) issues.push({ index, message: 'ref must be a string.' });
    const ref = refText ?? '';
    if (!ref) {
      issues.push({ index, message: 'This item has no ref, so nothing can point at it as a parent.' });
    } else if (byRef.has(ref)) {
      // Pinned to the SECOND: the first is where the ref was established.
      issues.push({ index, ref, message: `The ref "${ref}" repeats item ${(byRef.get(ref) as number) + 1}. Refs must be unique within one answer.` });
    } else {
      byRef.set(ref, index);
    }
    if (!TYPES.has(item?.type as string)) {
      issues.push({ index, ref, message: `"${item?.type}" is not an AgEnFK type. Use one of ${Object.values(ItemType).join(', ')}.` });
    }
    const title = asText((item as any)?.title);
    if (title === null) {
      issues.push({ index, ref, message: 'title must be a string.' });
    } else if (!title) {
      issues.push({ index, ref, message: 'This item has no title.' });
    }
    const description = (item as any)?.description;
    if (description !== undefined && description !== null && typeof description !== 'string') {
      // Caught here or it reaches the sqlite bind on create — which is the
      // failure this gate exists to move upstream.
      issues.push({ index, ref, message: 'description must be a string when present.' });
    }
  });

  // Pass 2: the links. Only now, because a parentRef can only be judged
  // against the full set of refs.
  items.forEach((item, index) => {
    const ref = asText((item as any)?.ref) ?? '';
    // Trimmed on BOTH sides. `ref` was trimmed when it went into the index and
    // `parentRef` was looked up raw, so `parentRef: " e1 "` produced two false
    // issues at once: "names no item" and then an EPIC accused of having no
    // child STORY.
    const raw = (item as any)?.parentRef;
    const parentRef = typeof raw === 'string' ? raw.trim() : raw;
    if (parentRef === null || parentRef === undefined || parentRef === '') return;
    if (typeof parentRef !== 'string') {
      issues.push({ index, ref, message: 'parentRef must be a ref string or null.' });
      return;
    }
    if (parentRef === 'null') {
      // The contract warns about this one by name, which is how we know it
      // happens. "No item named null" would send the reader hunting.
      issues.push({ index, ref, message: 'parentRef is the text "null". For a root item use the JSON literal null, without quotes.' });
      return;
    }
    if (parentRef === ref) {
      issues.push({ index, ref, message: 'This item is its own parent.' });
      return;
    }
    const parentIndex = byRef.get(parentRef);
    if (parentIndex === undefined) {
      issues.push({ index, ref, message: `parentRef "${parentRef}" names no item in this answer.` });
      return;
    }
    const parentType = items[parentIndex]?.type as string;
    const allowed = TYPES.has(item?.type as string) ? ALLOWED_PARENT.get(item?.type as string) : undefined;
    if (allowed && !allowed.has(parentType)) {
      const article = /^[AEIOU]/.test(String(item.type)) ? 'An' : 'A';
      issues.push({ index, ref, message: `${article} ${item.type} cannot sit under a ${parentType}.` });
    }
  });

  // Pass 3: depth, and the cycles a depth walk would otherwise hang on. The
  // step limit is the guard: a chain longer than the list has to be a loop.
  const depths = items.map((item, index) => {
    let depth = 0;
    let cursor: number | undefined = index;
    const seen = new Set<number>();
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        // Membership, not proximity: an item that merely HANGS OFF a cycle has
        // no root either, but telling it "you are part of a cycle" sends the
        // reader to the wrong row.
        const inCycle = cursor === index;
        issues.push({
          index,
          ref: asText((item as any)?.ref) ?? '',
          message: inCycle
            ? 'This item is part of a parent cycle, so it has no root.'
            : 'This item has no root: its chain of parents runs into a cycle.',
        });
        return 0;
      }
      seen.add(cursor);
      // Annotated. Without it TypeScript infers `parentRef` from an expression
      // that feeds `cursor`, which feeds `parentRef` — TS7022, and the whole
      // core package stopped compiling while every test stayed green, because
      // vitest transpiles without type checking.
      const parentRef: unknown = items[cursor]?.parentRef;
      const parentKey = typeof parentRef === 'string' ? parentRef.trim() : undefined;
      cursor = parentKey && parentKey !== 'null' ? byRef.get(parentKey) : undefined;
      if (cursor !== undefined) depth++;
    }
    return depth;
  });

  // Pass 4: rule 1, which is about the SHAPE of the tree rather than any one
  // item — an EPIC is never worked directly, so an EPIC alone is not a
  // decomposition, it is a card nobody may touch.
  items.forEach((item, index) => {
    if (item?.type !== ItemType.EPIC) return;
    const ref = asText((item as any)?.ref) ?? '';
    const hasStory = ref !== '' && items.some(child => {
      const raw = (child as any)?.parentRef;
      return (typeof raw === 'string' ? raw.trim() : raw) === ref && child?.type === ItemType.STORY;
    });
    if (!hasStory) {
      issues.push({ index, ref, message: 'This EPIC has no child STORY. An EPIC is never worked directly, so an EPIC alone is not a decomposition.' });
    }
  });

  return {
    objective: objectiveText ?? '',
    // Copies, in the order given: the caller still holds the agent's literal
    // answer, and the rows must not move under the person reviewing them.
    /*
     * A WHITELIST, not a spread. What this route blesses is what the approval
     * screen POSTs to /items, and `{...item}` carried every unreviewed key
     * through — including `status`, which POST /items accepts: a model could
     * put "status":"REVIEW" on a row that renders as an ordinary title and the
     * person would approve a card that skipped the working steps.
     */
    items: items.map((item, index) => ({
      ref: asText((item as any)?.ref) ?? '',
      type: (item as any)?.type,
      title: asText((item as any)?.title) ?? '',
      description: typeof (item as any)?.description === 'string' ? (item as any).description : undefined,
      parentRef: typeof (item as any)?.parentRef === 'string' ? (item as any).parentRef.trim() : null,
      depth: depths[index],
    })),
    issues,
  };
}
