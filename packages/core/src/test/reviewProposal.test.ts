/**
 * The half that makes "proposes, does not create" real.
 *
 * Without it the UI has only the create path, so an agent's answer would go
 * straight onto the board and the person would review cards that already
 * exist — which is the one failure the Ask AgEnFK surface exists to prevent
 * (artifact aca414c7 §06: "an agent that silently creates eight cards on a
 * board is an agent nobody lets near a board twice").
 *
 * So this validates a tree and hands it back with its problems attached. It
 * writes nothing, and it is pure — the route is a thin wrapper, which is what
 * lets the rules be tested without a server at all.
 */
import { describe, it, expect } from 'vitest';
import { ItemType } from '../types';
import { reviewProposal, MAX_PROPOSED_ITEMS } from '../reviewProposal';

const item = (over: Partial<Record<string, unknown>> = {}) => ({
  ref: 'r1', type: ItemType.TASK, title: 'Do the thing', parentRef: null, ...over,
});

describe('a tree that is fine', () => {
  const tree = {
    objective: 'port the admin API',
    items: [
      item({ ref: 'e1', type: ItemType.EPIC, title: 'Port the admin API' }),
      item({ ref: 's1', type: ItemType.STORY, title: 'Move services private', parentRef: 'e1' }),
      item({ ref: 't1', title: 'terraform port', parentRef: 's1' }),
    ],
  };

  it('comes back with no issues', () => {
    expect(reviewProposal(tree).issues).toEqual([]);
  });

  it('comes back in the order it was given, refs intact', () => {
    // The person reviews this list item by item; reordering it silently would
    // move the rows under their cursor.
    expect(reviewProposal(tree).items.map(i => i.ref)).toEqual(['e1', 's1', 't1']);
  });

  it('reports the depth, so the caller can draw the tree', () => {
    expect(reviewProposal(tree).items.map(i => i.depth)).toEqual([0, 1, 2]);
  });
});

describe('what it refuses', () => {
  it('an objective that is blank', () => {
    const { issues } = reviewProposal({ objective: '  ', items: [item()] });
    expect(issues.map(i => i.message).join()).toMatch(/objective/i);
  });

  it('an empty proposal', () => {
    // "Nothing to do" is an answer the agent should have written as one item,
    // not as an empty tree the screen would render as a blank approval gate.
    expect(reviewProposal({ objective: 'x', items: [] }).issues).toHaveLength(1);
  });

  it('a duplicate ref, pinned to the SECOND one', () => {
    const { issues } = reviewProposal({ objective: 'x', items: [item({ ref: 'a' }), item({ ref: 'a' })] });
    expect(issues).toHaveLength(1);
    expect(issues[0].index).toBe(1);
  });

  it('a type that is not one of ours', () => {
    const { issues } = reviewProposal({ objective: 'x', items: [item({ type: 'SPIKE' })] });
    expect(issues[0].message).toMatch(/SPIKE/);
  });

  it('a title that is blank', () => {
    const { issues } = reviewProposal({ objective: 'x', items: [item({ title: '   ' })] });
    expect(issues[0].message).toMatch(/title/i);
  });

  it('a parentRef naming an item that is not in the answer', () => {
    // The commonest failure of a generated tree: a parent the model meant to
    // include and did not.
    const { issues } = reviewProposal({ objective: 'x', items: [item({ parentRef: 'ghost' })] });
    expect(issues[0].message).toMatch(/ghost/);
  });

  it('the string "null" instead of the literal, by name', () => {
    // The contract warns about exactly this, which means it happens. Saying
    // "no item named null" would send the reader hunting for one.
    const { issues } = reviewProposal({ objective: 'x', items: [item({ parentRef: 'null' })] });
    expect(issues[0].message).toMatch(/text "null"/);
  });

  it('an item that is its own parent', () => {
    const { issues } = reviewProposal({ objective: 'x', items: [item({ ref: 'a', parentRef: 'a' })] });
    expect(issues[0].message).toMatch(/own parent/i);
  });

  it('a cycle, without hanging on it', () => {
    // Two items pointing at each other have no root, so a naive depth walk
    // recurses forever. The proposal is data from a model: it will be wrong.
    const { issues } = reviewProposal({
      objective: 'x',
      items: [item({ ref: 'a', parentRef: 'b' }), item({ ref: 'b', parentRef: 'a' })],
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map(i => i.message).join()).toMatch(/cycle/i);
  });

  it('an EPIC with no child STORY, because rule 1 forbids working it directly', () => {
    const { issues } = reviewProposal({
      objective: 'x',
      items: [item({ ref: 'e1', type: ItemType.EPIC })],
    });
    expect(issues[0].message).toMatch(/child STORY/i);
  });

  it('an EPIC parented by anything', () => {
    const { issues } = reviewProposal({
      objective: 'x',
      items: [item({ ref: 's1', type: ItemType.STORY }), item({ ref: 'e1', type: ItemType.EPIC, parentRef: 's1' })],
    });
    // /EPIC/ alone was satisfied by the "no child STORY" issue this fixture
    // also produces, so the parenting rule could be deleted entirely and the
    // test would stay green.
    expect(issues.map(i => i.message).join()).toMatch(/cannot sit under/);
  });

  it('a STORY parented by anything but an EPIC', () => {
    const { issues } = reviewProposal({
      objective: 'x',
      items: [item({ ref: 't1' }), item({ ref: 's1', type: ItemType.STORY, parentRef: 't1' })],
    });
    expect(issues.map(i => i.message).join()).toMatch(/cannot sit under/);
  });

  it('more items than a person will review', () => {
    const many = Array.from({ length: MAX_PROPOSED_ITEMS + 1 }, (_, i) => item({ ref: `r${i}` }));
    const { issues } = reviewProposal({ objective: 'x', items: many });
    expect(issues.map(i => i.message).join()).toMatch(new RegExp(String(MAX_PROPOSED_ITEMS)));
  });

  it('collects EVERY problem, not just the first', () => {
    // A screen showing one error at a time turns a bad tree into a queue of
    // round trips with the agent.
    const { issues } = reviewProposal({
      objective: 'x',
      items: [item({ ref: '', title: '' }), item({ ref: 'b', type: 'NOPE' })],
    });
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('what it does NOT do', () => {
  it('leaves the input untouched', () => {
    // It is validation, not normalisation-in-place: the caller still holds the
    // agent's literal answer and may want to show it.
    const tree = { objective: 'x', items: [item({ title: '  padded  ' })] };
    const before = JSON.stringify(tree);
    reviewProposal(tree);
    expect(JSON.stringify(tree)).toBe(before);
  });

  it('assigns no ids, because nothing was created', () => {
    const { items } = reviewProposal({ objective: 'x', items: [item()] });
    expect(items[0]).not.toHaveProperty('id');
  });
});

// ── What a model actually sends ────────────────────────────────────────────
// These are not hypotheticals: each one came back from review as a 500 with a
// stack trace, which means the person asking for a decomposition got an error
// page instead of a proposal.
describe('fields that are not the type they are supposed to be', () => {
  it.each([
    ['ref', { ref: 1 }],
    ['title', { title: 5 }],
    ['description', { description: { a: 1 } }],
  ])('reports %s instead of throwing', (field, over) => {
    const { issues } = reviewProposal({ objective: 'x', items: [item(over)] });
    expect(issues.some(i => i.message.toLowerCase().includes(field))).toBe(true);
  });

  it('reports a non-string objective instead of throwing', () => {
    expect(() => reviewProposal({ objective: 7 as any, items: [item()] })).not.toThrow();
    expect(reviewProposal({ objective: 7 as any, items: [item()] }).issues[0].message).toMatch(/objective/i);
  });

  // `ALLOWED_PARENT` was an object literal, so `type: "constructor"` resolved
  // to Object.prototype.constructor and `.has` on it threw.
  it.each(['__proto__', 'constructor', 'toString'])('survives %s as a type', (type) => {
    const run = () => reviewProposal({
      objective: 'x',
      items: [item({ ref: 'a' }), item({ ref: 'b', type, parentRef: 'a' })],
    });
    expect(run).not.toThrow();
    expect(run().issues.some(i => i.message.includes(type))).toBe(true);
  });
});

describe('the cap stops the work, not just the answer', () => {
  it('returns no items at all past the cap', () => {
    // The depth walk is O(n²): 20k items froze the process for 8.9s. An issue
    // that annotates a walk already performed is not a cap.
    const many = Array.from({ length: MAX_PROPOSED_ITEMS + 1 }, (_, i) =>
      item({ ref: `r${i}`, parentRef: i === 0 ? null : `r${i - 1}` }));
    const reviewed = reviewProposal({ objective: 'x', items: many });
    expect(reviewed.items).toEqual([]);
    expect(reviewed.issues).toHaveLength(1);
  });

  it('accepts exactly the cap', () => {
    const exact = Array.from({ length: MAX_PROPOSED_ITEMS }, (_, i) => item({ ref: `r${i}` }));
    expect(reviewProposal({ objective: 'x', items: exact }).items).toHaveLength(MAX_PROPOSED_ITEMS);
  });
});

describe('only reviewed fields leave the gate', () => {
  it('drops everything it did not check', () => {
    // What comes out of here is what the approval screen POSTs to /items, and
    // that route ACCEPTS `status`: a model could put "status":"REVIEW" on a row
    // that renders as an ordinary title, and the person would approve a card
    // that skipped the working steps.
    const { items } = reviewProposal({
      objective: 'x',
      items: [item({ id: 'REAL-ID', status: 'DONE', evil: { a: 1 } })],
    });
    expect(Object.keys(items[0]).sort()).toEqual(['depth', 'description', 'parentRef', 'ref', 'title', 'type']);
  });
});

describe('a stray space is not a defect', () => {
  it('matches a padded parentRef to its parent', () => {
    // `ref` was trimmed into the index and `parentRef` looked up raw, so one
    // space produced TWO false issues — "names no item" and an EPIC accused of
    // having no child STORY.
    const { issues } = reviewProposal({
      objective: 'x',
      items: [
        item({ ref: 'e1', type: ItemType.EPIC, title: 'E' }),
        item({ ref: 's1', type: ItemType.STORY, title: 'S', parentRef: ' e1 ' }),
      ],
    });
    expect(issues).toEqual([]);
  });
});

describe('a cycle and the things hanging off it are different facts', () => {
  it('tells a descendant it has no root, not that it is a cycle', () => {
    const { issues } = reviewProposal({
      objective: 'x',
      items: [
        item({ ref: 'a', parentRef: 'b' }),
        item({ ref: 'b', parentRef: 'a' }),
        item({ ref: 'c', parentRef: 'a' }),
      ],
    });
    const forC = issues.find(i => i.ref === 'c');
    expect(forC?.message).toMatch(/runs into a cycle/);
    expect(forC?.message).not.toMatch(/part of a parent cycle/);
  });
});
