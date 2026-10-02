/**
 * @file 26c059f6 — claims are gone from core.
 *
 * The gatekeeper refused an edit while another card in the same tree claimed
 * the path (CLAIM CONFLICT), and core exported the claim gate the server and
 * the hook built on. Both are gone: the gatekeeper decides on the card and the
 * step alone, and a claim stored on an old card is ignored.
 */
import { describe, it, expect } from 'vitest';
import * as core from '../index';
import { decideGatekeeperAuthorization, commitOnLeaveNote, type GatekeeperItem, type GatekeeperFlow } from '../gatekeeper';

const card = (id: string, status: string, extra: Record<string, unknown> = {}): GatekeeperItem =>
  ({ id, status, type: 'TASK', title: `t-${id}`, ...extra }) as GatekeeperItem;

const tddFlow: GatekeeperFlow = {
  steps: [
    { name: 'TODO', order: 0, isAnchor: true },
    { name: 'DISCOVERY', order: 1 },
    { name: 'CREATE_UNIT_TESTS', order: 2 },
    { name: 'IN_PROGRESS', order: 3 },
    { name: 'REVIEW', order: 4 },
    { name: 'DONE', order: 5, isAnchor: true },
  ],
};

describe('the gatekeeper and old claims', () => {
  it('authorizes an edit although another card in the same tree claims the path', () => {
    const d = decideGatekeeperAuthorization([
      card('mine', 'IN_PROGRESS', { claims: ['a.ts'] }),
      card('theirs', 'REVIEW', { claims: ['a.ts'] }),
    ], tddFlow, { itemId: 'mine' });
    expect(d.authorized, d.message).toBe(true);
    expect(d.message).not.toContain('CLAIM CONFLICT');
  });

  it('does not promise that a step commits only "claimed" files', () => {
    expect(commitOnLeaveNote('PLAN', 'auto')).not.toMatch(/claim/i);
    expect(commitOnLeaveNote('PLAN', 'required')).not.toMatch(/claim/i);
  });
});

describe('core', () => {
  it('no longer exports the claim gate', () => {
    for (const name of ['gateOnClaims', 'foreignClaimsFor', 'claimTreeOf', 'sameClaimTree', 'strayStaged', 'claimlessNeighbours', 'stillHolds', 'claimsCollide', 'findClaimConflicts', 'isWellFormedClaim']) {
      expect((core as Record<string, unknown>)[name], name).toBeUndefined();
    }
  });
});
