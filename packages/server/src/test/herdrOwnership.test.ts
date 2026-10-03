/**
 * Who a herdr pane belongs to (96953f6a / CGLAB-266).
 *
 * Two populations share one list and they must not be confused:
 *
 *   • sessions AgEnFK itself started, whose cwd sits inside a worktree a card
 *     owns — those get the card's name, its step, its branch;
 *   • everything else the developer is running, which works in its own cwd,
 *     needs no worktree, and must NOT be given a card it does not have.
 *
 * WHAT DECIDES IS PATH CONTAINMENT, never a title. Measured on the machine this
 * was written on, a pane's title read "Implementar fault tolerance no LiteLLM",
 * which looks exactly like a card and is another agent typing. Matching on that
 * would invent an association.
 */
import { describe, it, expect } from 'vitest';
import { ownerOfPane, type OwnerInputs } from '../herdrOwnership';

const CARDS = [
  { id: 'c-1', title: 'Adapter herdr', status: 'IN_PROGRESS', branchName: 'feat/x',
    worktreePath: '/wt/agenfk/feat-x', projectId: 'p-1' },
  { id: 'c-2', title: 'Outra coisa', status: 'REVIEW', worktreePath: '/wt/agenfk/feat-y', projectId: 'p-1' },
];
const PROJECTS = [{ id: 'p-1', name: 'agenfk', projectRoot: '/repos/agenfk' }];

const inputs = (over: Partial<OwnerInputs> = {}): OwnerInputs =>
  ({ cards: CARDS, projects: PROJECTS, ...over });

describe('a pane inside a card\'s worktree', () => {
  it('belongs to that card', () => {
    const o = ownerOfPane('/wt/agenfk/feat-x', inputs());
    expect(o.kind).toBe('card');
    expect(o.kind === 'card' && o.card.id).toBe('c-1');
  });

  it('belongs to it from a subdirectory too', () => {
    const o = ownerOfPane('/wt/agenfk/feat-x/packages/server', inputs());
    expect(o.kind === 'card' && o.card.id).toBe('c-1');
  });

  it('carries what the row needs to read as that card', () => {
    const o = ownerOfPane('/wt/agenfk/feat-x', inputs());
    expect(o.kind === 'card' && o.card).toMatchObject({
      id: 'c-1', title: 'Adapter herdr', status: 'IN_PROGRESS', branchName: 'feat/x',
    });
  });

  it('does NOT match a sibling whose path merely shares a prefix', () => {
    /*
     * `/wt/agenfk/feat-x-old` starts with `/wt/agenfk/feat-x`. Containment is
     * about path SEGMENTS, and this repository has already shipped one guard
     * that got it wrong — `createWorktree`'s, which refused 0 of 40 hostile
     * pairs.
     */
    const o = ownerOfPane('/wt/agenfk/feat-x-old', inputs());
    expect(o.kind).not.toBe('card');
  });

  it('prefers the DEEPEST worktree when one nests inside another', () => {
    // A card cut from another card's tree is legal. The inner one is the answer.
    const nested = [...CARDS, { id: 'c-3', title: 'Filho', status: 'TODO',
      worktreePath: '/wt/agenfk/feat-x/inner', projectId: 'p-1' }];
    const o = ownerOfPane('/wt/agenfk/feat-x/inner/src', inputs({ cards: nested }));
    expect(o.kind === 'card' && o.card.id).toBe('c-3');
  });
});

describe('a pane in a project but not in any worktree', () => {
  it('belongs to the project, not to a card', () => {
    /*
     * This is the common case today: work happens in the repository's own
     * checkout. Naming the project is true and useful; naming a card would be
     * a guess.
     */
    const o = ownerOfPane('/repos/agenfk/packages/ui', inputs());
    expect(o.kind).toBe('project');
    expect(o.kind === 'project' && o.project.name).toBe('agenfk');
  });
});

describe('a pane that is nobody\'s', () => {
  it('is external, and that is a first-class answer', () => {
    /*
     * A developer's own agents, in their own directories. They need no
     * worktree — they already have a place — and no card. Adopting them where
     * they are is the whole design decision behind this module.
     */
    const o = ownerOfPane('/Users/x/GitHub/some-other-repo', inputs());
    expect(o.kind).toBe('external');
  });

  it('is external with no cwd at all, rather than throwing', () => {
    expect(ownerOfPane('', inputs()).kind).toBe('external');
    expect(ownerOfPane(undefined, inputs()).kind).toBe('external');
  });

  it('is external when there are no cards and no projects', () => {
    expect(ownerOfPane('/anywhere', { cards: [], projects: [] }).kind).toBe('external');
  });
});

describe('what it refuses to do', () => {
  it('never matches on a TITLE, however much it looks like a card', () => {
    /*
     * MEASURED: a live pane's title was "Implementar fault tolerance no
     * LiteLLM" — indistinguishable from a card, and it was another agent
     * typing. The only input here is a path.
     */
    const o = ownerOfPane('/Users/x/elsewhere', inputs({
      cards: [{ id: 'c-9', title: 'Implementar fault tolerance no LiteLLM', status: 'TODO', projectId: 'p-1' }],
    }));
    expect(o.kind).toBe('external');
  });

  it('never matches on a branch name', () => {
    const o = ownerOfPane('/Users/x/elsewhere', inputs({
      cards: [{ id: 'c-9', title: 'x', status: 'TODO', branchName: 'feat/x', projectId: 'p-1' }],
    }));
    expect(o.kind).toBe('external');
  });

  it('ignores a card whose worktree field is empty, instead of matching everything', () => {
    // `''` contained in every path is the classic form of this bug.
    const o = ownerOfPane('/anywhere/at/all', inputs({
      cards: [{ id: 'c-9', title: 'x', status: 'TODO', worktreePath: '', projectId: 'p-1' }],
    }));
    expect(o.kind).toBe('external');
  });

  it('ignores a project whose root is empty for the same reason', () => {
    const o = ownerOfPane('/anywhere/at/all', inputs({
      cards: [], projects: [{ id: 'p-9', name: 'x', projectRoot: '' }],
    }));
    expect(o.kind).toBe('external');
  });
});
