/**
 * What comes out of a terminal is not JSON.
 *
 * It is JSON with the agent's own sentences around it, ANSI colour through it,
 * and a shell prompt after it. Asking the person to find the object by eye is
 * the manual step this whole screen exists to remove.
 */
import { describe, it, expect } from 'vitest';
import { extractProposal, stripAnsi } from '../agentAnswer';

const ESC = '\x1b';
const proposal = { objective: 'x', items: [{ ref: 'a', type: 'TASK', title: 't', parentRef: null }] };

describe('extractProposal', () => {
  it('finds the object among the agent’s prose', () => {
    const out = `Sure — three deliverables.\n${JSON.stringify(proposal)}\nAnything else?`;
    expect(extractProposal(out)).toEqual(proposal);
  });

  it('sees through ANSI colour and a prompt', () => {
    const out = `${ESC}[32m done${ESC}[0m\n${JSON.stringify(proposal)}\n${ESC}[1;34m~/repo${ESC}[0m $ `;
    expect(extractProposal(out)).toEqual(proposal);
  });

  it('takes the LAST proposal, because agents sketch before they answer', () => {
    const sketch = { objective: 'x', items: [] };
    expect(extractProposal(`${JSON.stringify(sketch)}\nactually:\n${JSON.stringify(proposal)}`))
      .toEqual(proposal);
  });

  it('survives a brace inside a title', () => {
    // Titles are written by people about code. A regex for `{...}` ends the
    // object at the first `}` in the prose.
    const tricky = { objective: 'x', items: [{ ref: 'a', type: 'TASK', title: 'fix the } in the parser', parentRef: null }] };
    expect(extractProposal(`noise ${JSON.stringify(tricky)} noise`)).toEqual(tricky);
  });

  it('ignores JSON that is not a proposal', () => {
    // Agents print settings, diffs and tool results. Feeding any of those to
    // the review route would draw a tree out of something that is not one.
    expect(extractProposal('{"ok":true}')).toBeNull();
    expect(extractProposal('[1,2,3]')).toBeNull();
  });

  it('answers null while the agent is still thinking', () => {
    expect(extractProposal('Working on it…')).toBeNull();
    expect(extractProposal('')).toBeNull();
  });

  it('is not fooled by an unbalanced brace', () => {
    expect(extractProposal('{ "objective": "x", "items": [')).toBeNull();
  });
});

describe('stripAnsi', () => {
  it('removes colour, cursor moves and OSC titles', () => {
    expect(stripAnsi(`${ESC}[0m${ESC}[2J${ESC}]0;title\x07hello`)).toBe('hello');
  });
});
