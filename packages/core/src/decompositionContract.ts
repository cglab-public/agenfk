/**
 * The two things `analyze_request` can hand an agent.
 *
 * GUIDANCE is what it has always returned: the request echoed back and the
 * four decomposition rules. An agent in the middle of the standard flow calls
 * it and then goes on to CREATE the items — `SKILL.md` step 2 sends it there,
 * and `/agenfk-plan` step 3 is the create. That behaviour is unchanged and
 * must stay unchanged; it is the shipped workflow on users' machines.
 *
 * A CONTRACT is the new thing, and it is for one caller: the Ask AgEnFK
 * surface, where a person describes an objective and reviews a proposal before
 * anything is written. It is NOT the default, because the two are opposites —
 * telling the standard flow "do not create any item" would break the flow that
 * works today, or teach agents to ignore the one line the text exists for.
 *
 * NO MODEL IS CALLED HERE. AgEnFK is harness-agnostic and the server holds no
 * provider key; the thing that decomposes is the agent already in the
 * conversation. These are the words it answers against.
 *
 * ON "one copy": the two RUNTIME copies are gone — the MCP tool and the CLI
 * both render this. The rules also exist, hand-written, in SKILL.md,
 * AFK_ARCHITECTURE.md and four files under commands/, and markdown cannot
 * import from here. Those have ALREADY drifted from each other (SKILL.md says
 * an EPIC "is created with its child STORIES", this file says it must be
 * decomposed "before any of them starts"). Treat that as open, not closed.
 */
import { ItemType } from './types';

/**
 * The doctrine, as a list rather than a paragraph, so neither surface owns the
 * formatting: the CLI indents and wraps, the MCP tool sends one block.
 *
 * Wording note, because a merge happened here and somebody will want to know
 * which side won: the MCP copy said "When decomposing, create ALL sub-items"
 * and "approval of a decomposition"; the CLI copy said "Create ALL sub-items"
 * and "approval of the plan". The CLI wording is kept, both times.
 */
export const DECOMPOSITION_RULES: readonly string[] = [
  'Minimum Decomposition: An EPIC must be decomposed into child STORIES before any of them starts — an EPIC is never worked directly. A STORY is decomposed into TASKs only when it is large (multiple deliverables, several packages, or more than one focused implementation pass) — the agent\'s judgement.',
  'Backlog Inspection: Only items in TODO status should be inspected when starting new work; IDEAs (drafts) must be ignored.',
  'Create ALL sub-items (Stories/Tasks) in TODO status.',
  'PAUSE and ask the user for approval of the plan before moving any item to IN_PROGRESS.',
];

/**
 * The types a proposal may use — derived, never retyped. A hand-written
 * ['EPIC','STORY','TASK','BUG'] beside an enum that already says exactly that
 * is the defect this file was written to remove, reintroduced one scope down.
 */
export const PROPOSAL_TYPES: readonly ItemType[] = Object.values(ItemType);

/**
 * The shape of a proposal.
 *
 * `ref` rather than `id`: nothing exists yet, and an invented id would read as
 * a card that had been created. `parentRef` points at another item's `ref` in
 * the same answer — that is what makes the reply a tree rather than a list.
 */
export interface ProposedItem {
  ref: string;
  type: ItemType;
  title: string;
  description?: string;
  parentRef?: string | null;
}

export interface ProposedTree {
  objective: string;
  items: ProposedItem[];
}

/**
 * Bumped when the rendered contract changes in a way a parser would notice.
 * An agent-facing format with no version leaves a future consumer unable to
 * tell which contract produced a given answer.
 */
export const CONTRACT_VERSION = 1;

/** The guidance text, unchanged in meaning from what both surfaces printed. */
export function decompositionRules(request: string): string {
  const objective = requireObjective(request);
  return [
    `Complexity analysis for: ${JSON.stringify(objective)}`,
    '',
    'REMINDER: All work MUST follow these decomposition and inspection rules:',
    ...DECOMPOSITION_RULES.map((rule, i) => `${i + 1}. ${rule}`),
  ].join('\n');
}

/*
 * The rules a PROPOSAL answers to, which are not the four above.
 *
 * Rule 3 ("create ALL sub-items in TODO") and rule 4 ("pause before moving any
 * item to IN_PROGRESS") both presuppose items that exist. Carried verbatim
 * into a contract that ends "do not create any item", they make one message
 * say create and do not create — a coin flip, not a contract. Rule 2
 * (inspect the backlog) is inert here: nothing is in the backlog yet. Only
 * rule 1, granularity, survives intact.
 */
const PROPOSAL_RULES: readonly string[] = [
  DECOMPOSITION_RULES[0],
  'If the objective is a single unit of work, propose ONE item — a TASK, or a BUG if it is a defect — with parentRef null. Do not invent an EPIC to look thorough.',
  'Every EPIC you propose must have at least one child STORY in the same answer, and every STORY that is large must have its TASKs. An EPIC alone is not a decomposition.',
  'Propose only. Nothing here is created: the person reviews this item by item, keeps, edits or drops each one, and only then are the accepted items created — in TODO, none of them started.',
];

const SHAPE = `{
  "contractVersion": ${CONTRACT_VERSION},
  "objective": "<the objective you were given>",
  "items": [
    { "ref": "e1", "type": "EPIC",  "title": "...", "description": "...", "parentRef": null },
    { "ref": "s1", "type": "STORY", "title": "...", "description": "...", "parentRef": "e1" },
    { "ref": "t1", "type": "TASK",  "title": "...", "description": "...", "parentRef": "s1" }
  ]
}`;

function requireObjective(request: string): string {
  const objective = (request ?? '').trim();
  if (!objective) {
    throw new Error('An objective is required: analyze was called with an empty request.');
  }
  return objective;
}

/**
 * The contract for one objective: what to answer, and in what shape.
 *
 * @throws if the objective is blank — an agent handed an empty contract
 * invents the objective, and the person never said it.
 */
export function decompositionContract(request: string): string {
  const objective = requireObjective(request);
  return [
    `Decomposition requested for: ${JSON.stringify(objective)}`,
    '',
    'RULES:',
    ...PROPOSAL_RULES.map((rule, i) => `${i + 1}. ${rule}`),
    '',
    `ANSWER WITH THIS SHAPE — one JSON object, no prose before or after it, and no code fence:`,
    SHAPE,
    '',
    'FIELDS:',
    `- ref: a short id you invent, unique within this answer.`,
    `- type: one of ${PROPOSAL_TYPES.join(', ')}.`,
    '- title: what has to be true when the item is done.',
    '- description: optional; the reasoning, the constraint, the thing that will be forgotten.',
    '- parentRef: the ref of this item\'s parent, as a JSON string, or the JSON literal null for a root item. Not the text "null".',
    '',
    // Said last because it is the line that gets skipped, and said once rather
    // than "twice" — the rules above no longer contradict it.
    'PROPOSING IS NOT CREATING. Do not create, update or start any item from this answer.',
  ].join('\n');
}
