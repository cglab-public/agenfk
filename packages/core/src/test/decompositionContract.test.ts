/**
 * Two texts, and the distance between them is the point.
 *
 * GUIDANCE is what `analyze_request` has always returned and what the shipped
 * standard flow (SKILL.md step 2) calls before going on to CREATE the items.
 * CONTRACT is for the Ask AgEnFK surface, where a person reviews a proposal
 * and nothing is written until they accept it. The first version of this work
 * replaced guidance WITH the contract, which handed the standard flow a "do
 * not create any item" instruction in the middle of a flow whose next step is
 * to create. These tests pin the two apart.
 */
import { describe, it, expect } from 'vitest';
import { ItemType } from '../types';
import {
  CONTRACT_VERSION, DECOMPOSITION_RULES, PROPOSAL_TYPES,
  decompositionContract, decompositionRules,
} from '../decompositionContract';

describe('guidance — the behaviour that must not change', () => {
  // Agents on users' machines are mid-flow when they call this. The header is
  // the part a human recognises in a terminal; the rules are the contract they
  // have been following.
  it('still opens with the line both surfaces printed', () => {
    expect(decompositionRules('add SSO')).toMatch(/^Complexity analysis for: "add SSO"/);
  });

  it('still carries four numbered rules, in order', () => {
    const lines = decompositionRules('x').split('\n');
    for (let i = 0; i < DECOMPOSITION_RULES.length; i++) {
      expect(lines).toContain(`${i + 1}. ${DECOMPOSITION_RULES[i]}`);
    }
  });

  // The whole reason guidance survived as its own function: it must NOT tell a
  // flow whose next step is `agenfk create` to create nothing.
  it('does not tell the caller to create nothing', () => {
    expect(decompositionRules('x')).not.toMatch(/not creat/i);
  });
});

describe('the proposal contract', () => {
  /*
   * A WIRE FORMAT, pinned. This text is read by another program's model and
   * answered against; a reordered section or a dropped line is a compatibility
   * break, and every other assertion here would stay green through one. The
   * snapshot is the only control that fails when the shape moves.
   */
  it('renders exactly this', () => {
    expect(decompositionContract('port the admin API')).toMatchInlineSnapshot(`
      "Decomposition requested for: "port the admin API"

      RULES:
      1. Minimum Decomposition: An EPIC must be decomposed into child STORIES before any of them starts — an EPIC is never worked directly. A STORY is decomposed into TASKs only when it is large (multiple deliverables, several packages, or more than one focused implementation pass) — the agent's judgement.
      2. If the objective is a single unit of work, propose ONE item — a TASK, or a BUG if it is a defect — with parentRef null. Do not invent an EPIC to look thorough.
      3. Every EPIC you propose must have at least one child STORY in the same answer, and every STORY that is large must have its TASKs. An EPIC alone is not a decomposition.
      4. Propose only. Nothing here is created: the person reviews this item by item, keeps, edits or drops each one, and only then are the accepted items created — in TODO, none of them started.

      ANSWER WITH THIS SHAPE — one JSON object, no prose before or after it, and no code fence:
      {
        "contractVersion": 1,
        "objective": "<the objective you were given>",
        "items": [
          { "ref": "e1", "type": "EPIC",  "title": "...", "description": "...", "parentRef": null },
          { "ref": "s1", "type": "STORY", "title": "...", "description": "...", "parentRef": "e1" },
          { "ref": "t1", "type": "TASK",  "title": "...", "description": "...", "parentRef": "s1" }
        ]
      }

      FIELDS:
      - ref: a short id you invent, unique within this answer.
      - type: one of EPIC, STORY, TASK, BUG.
      - title: what has to be true when the item is done.
      - description: optional; the reasoning, the constraint, the thing that will be forgotten.
      - parentRef: the ref of this item's parent, as a JSON string, or the JSON literal null for a root item. Not the text "null".

      PROPOSING IS NOT CREATING. Do not create, update or start any item from this answer."
    `);
  });

  it('does not carry the two rules that presuppose existing items', () => {
    const text = decompositionContract('x');
    // "Create ALL sub-items in TODO" and "before moving any item to
    // IN_PROGRESS" both assume the items exist. Next to "do not create any
    // item" they make one message say create and do not create.
    expect(text).not.toContain(DECOMPOSITION_RULES[2]);
    expect(text).not.toContain(DECOMPOSITION_RULES[3]);
    // Granularity is the one rule that survives intact.
    expect(text).toContain(DECOMPOSITION_RULES[0]);
  });

  it('closes the three holes an agent would otherwise fill by guessing', () => {
    const text = decompositionContract('x');
    // A single unit of work: otherwise agents invent an EPIC to look thorough.
    expect(text).toMatch(/single unit of work/i);
    // An EPIC alone satisfies any shape check and violates rule 1.
    expect(text).toMatch(/EPIC[^.]*at least one child STORY/i);
    // Models answer "a single JSON object and nothing else" with a ```json
    // fence roughly half the time.
    expect(text).toMatch(/no code fence/i);
  });

  it('says which null it means, because agents emit the string', () => {
    expect(decompositionContract('x')).toMatch(/JSON literal null[\s\S]*Not the text "null"/);
  });

  it('shows a tree, not one item', () => {
    // The parent/child link is the whole reason the answer is a tree; a
    // one-element example never demonstrates it.
    const shape = decompositionContract('x');
    expect(shape).toContain('"parentRef": null');
    expect(shape).toContain('"parentRef": "e1"');
    expect(shape).toContain('"parentRef": "s1"');
  });

  it('carries a version a future parser can branch on', () => {
    expect(decompositionContract('x')).toContain(`"contractVersion": ${CONTRACT_VERSION}`);
  });

  it('survives an objective containing quotes', () => {
    // The property is not "the raw substring appears" — it is that the
    // objective round-trips, which is what the escaping buys.
    const objective = 'rename the "admin" API';
    const line = decompositionContract(objective).split('\n')[0];
    expect(JSON.parse(line.slice(line.indexOf('"')))).toBe(objective);
  });
});

describe('both texts', () => {
  it.each([
    ['guidance', decompositionRules],
    ['contract', decompositionContract],
  ])('%s refuses a blank objective', (_name, render) => {
    // An agent handed an empty text invents the objective, and the person
    // never said it.
    expect(() => render('   ')).toThrow(/objective/i);
  });
});

describe('the type list', () => {
  // The defect this file exists to remove, one scope down: a hand-written
  // ['EPIC','STORY','TASK','BUG'] beside an enum that already says it. Add a
  // fifth member to ItemType and a retyped list keeps offering four.
  it('is the enum, not a copy of it', () => {
    expect([...PROPOSAL_TYPES]).toEqual(Object.values(ItemType));
  });

  it('is offered to the agent in full', () => {
    const text = decompositionContract('x');
    for (const t of PROPOSAL_TYPES) expect(text).toContain(t);
  });
});
