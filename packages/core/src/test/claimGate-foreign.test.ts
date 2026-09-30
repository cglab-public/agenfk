/**
 * @file 5b48b96b review — whose claims make a path "another card's" for this card's checks.
 *
 * Only a card that is working beside this one: not the card itself, not one of
 * its ancestors (a parent claiming its children's directory would make every
 * child's own tests foreign, and a child cannot claim them back - claims are
 * exclusive), not a card that has not started (a claim on a TODO card costs
 * nothing, and must not excuse anything), not a finished one, and only in this tree.
 */
import { describe, it, expect } from 'vitest';
import { foreignClaimsFor } from '../claimGate';

const h = (id: string, status: string, claims: string[], tree: string | null = '/repo', started = true) => ({ id, status, claims, tree, started });

describe('foreignClaimsFor', () => {
  const opts = { itemTree: '/repo', ancestorIds: new Set(['P']) };

  it('keeps a working sibling\'s claims', () => {
    expect(foreignClaimsFor({ id: 'A' }, [h('B', 'IN_PROGRESS', ['b.js'])], opts)).toEqual(['b.js']);
  });

  it('drops the card\'s own, its ancestors\', a not-started card\'s and a finished card\'s claims', () => {
    const holders = [h('A', 'IN_PROGRESS', ['a.js']), h('P', 'IN_PROGRESS', ['test/']), h('T', 'TODO', ['t.js'], '/repo', false), h('D', 'DONE', ['d.js'])];
    expect(foreignClaimsFor({ id: 'A' }, holders, opts)).toEqual([]);
  });

  it('drops a card working in another tree', () => {
    expect(foreignClaimsFor({ id: 'A' }, [h('B', 'IN_PROGRESS', ['b.js'], '/other')], opts)).toEqual([]);
  });

  // Re-review: TODO -> BLOCKED needs no verify, so a status says nothing about whether a card ever worked.
  it('drops a card that never left a step through verify, whatever its status (BLOCKED, PAUSED straight from TODO)', () => {
    expect(foreignClaimsFor({ id: 'A' }, [h('X', 'BLOCKED', ['x.js'], '/repo', false), h('Y', 'PAUSED', ['y.js'], '/repo', false)], opts)).toEqual([]);
  });

  it('keeps a paused card\'s claims: its files are half-edited in the tree', () => {
    expect(foreignClaimsFor({ id: 'A' }, [h('B', 'PAUSED', ['b.js'])], opts)).toEqual(['b.js']);
  });
});
