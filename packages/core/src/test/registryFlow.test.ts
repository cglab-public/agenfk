/**
 * @file CGLAB-385 (S9-T1) — a flow's step contract travels with it to the
 * registry, and a publish that lacks one never replaces a registry flow that
 * has one (an older agenfk strips the fields it does not know).
 */
import { describe, it, expect } from 'vitest';
import { stepContractFields, wouldStripContracts } from '../registryFlow';

describe('stepContractFields', () => {
  it('carries role and checks when the step has them', () => {
    expect(stepContractFields({ role: 'coding', checks: [{ id: 'suite-green' }] })).toEqual({ role: 'coding', checks: [{ id: 'suite-green' }] });
  });
  it('adds nothing for a step without them', () => {
    expect(stepContractFields({ name: 'X' })).toEqual({});
    expect(stepContractFields({ role: null, checks: [] })).toEqual({});
  });
});

describe('wouldStripContracts', () => {
  const rich = [{ name: 'A', role: 'coding' }];
  const bare = [{ name: 'A' }];
  it('is true when the registry has a contract and the publish has none', () => {
    expect(wouldStripContracts(rich, bare)).toBe(true);
  });
  it('is false when both have one, or the registry has none, or there is no registry copy', () => {
    expect(wouldStripContracts(rich, [{ name: 'A', role: 'review' }])).toBe(false);
    expect(wouldStripContracts(bare, bare)).toBe(false);
    expect(wouldStripContracts(undefined, bare)).toBe(false);
  });
});
