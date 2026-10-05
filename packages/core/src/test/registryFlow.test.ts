/**
 * @file CGLAB-385 (S9-T1) — a flow's step contract travels with it to the
 * registry, and a publish that lacks one never replaces a registry flow that
 * has one (an older agenfk strips the fields it does not know).
 */
import { describe, it, expect } from 'vitest';
import { stepContractFields, wouldStripContracts, registryInstallSteps } from '../registryFlow';

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

describe('wouldStripContracts, step by step (S9 review)', () => {
  it('is true when one same-named step lost its checks while another kept its role', () => {
    const reg = [{ name: 'A', role: 'coding' }, { name: 'B', role: 'review', checks: [{ id: 'independent-review' }] }];
    const inc = [{ name: 'A', role: 'coding' }, { name: 'B', role: 'review' }];
    expect(wouldStripContracts(reg, inc)).toBe(true);
  });
  it('is true when one step lost its role', () => {
    expect(wouldStripContracts([{ name: 'A', role: 'coding' }, { name: 'B' }], [{ name: 'A' }, { name: 'B' }])).toBe(true);
  });
  it('is false for a step the publish removed or renamed while it still carries a contract elsewhere', () => {
    expect(wouldStripContracts([{ name: 'A', role: 'coding' }], [{ name: 'Z', role: 'coding' }])).toBe(false);
  });
  it('is true when the only contract step was renamed and the publish carries no contract at all (an old client strips every step)', () => {
    expect(wouldStripContracts([{ name: 'REVIEW', role: 'review' }], [{ name: 'CODE_REVIEW' }])).toBe(true);
  });
  it('counts the commit flags as contract', () => {
    expect(wouldStripContracts([{ name: 'A', role: 'coding' }, { name: 'B', autoCommit: true }], [{ name: 'A', role: 'coding' }, { name: 'B' }])).toBe(true);
    expect(wouldStripContracts([{ name: 'B', requireCommit: true, autoCommit: true }], [{ name: 'B', autoCommit: true }])).toBe(true);
  });
  it('judges the incoming steps as they would be written: a non-string role is no role', () => {
    expect(wouldStripContracts([{ name: 'A', role: 'coding' }], [{ name: 'A', role: 1 }])).toBe(true);
  });
  it('matches step names exactly, as the check engine does', () => {
    expect(wouldStripContracts([{ name: 'B', checks: [{ id: 'x' }] }], [{ name: 'B', checks: [{ id: 'x' }] }, { name: 'b' }])).toBe(false);
  });
});

describe('registryInstallSteps', () => {
  let n = 0;
  const id = () => `id-${++n}`;
  const raw = [
    { name: 'TODO', isAnchor: true, role: 'planning' },
    { name: 'BUILD', label: 'Build', exitCriteria: 'x', role: 'coding', checks: [{ id: 'suite-green' }], color: '#123456', icon: 'code', autoCommit: true },
    { name: 'DONE', isAnchor: true, role: 'closing', checks: [{ id: 'tree-clean' }] },
  ];
  it('keeps each middle step\'s contract, color and icon', () => {
    const s = registryInstallSteps(raw, id);
    expect(s[1]).toMatchObject({ name: 'BUILD', label: 'Build', order: 1, exitCriteria: 'x', role: 'coding', checks: [{ id: 'suite-green' }], color: '#123456', icon: 'code', autoCommit: true });
  });
  it('keeps the anchors\' contracts on the fresh TODO/DONE anchors', () => {
    const s = registryInstallSteps(raw, id);
    expect(s[0]).toMatchObject({ name: 'TODO', isAnchor: true, order: 0, role: 'planning' });
    expect(s[2]).toMatchObject({ name: 'DONE', isAnchor: true, order: 2, role: 'closing', checks: [{ id: 'tree-clean' }] });
  });
  it('passes an invalid role through, so the caller\'s validation refuses it rather than dropping it', () => {
    expect(registryInstallSteps([{ name: 'A', role: 42 }], id)[1].role).toBe(42);
  });
  it('fills an empty name and label, and gives every step a fresh id', () => {
    const s = registryInstallSteps([{ name: '', label: '', id: 'dup' }, { name: 'B', id: 'dup' }], id);
    expect(s[1].name).toBe('step-0');
    expect(s[1].label).toBe('Step 1');
    expect(new Set(s.map((x: any) => x.id)).size).toBe(s.length);
    expect(s.some((x: any) => x.id === 'dup')).toBe(false);
  });
  it('builds plain anchors for a registry flow that has none', () => {
    const s = registryInstallSteps([{ name: 'A' }], id);
    expect(s[0]).toEqual({ id: expect.any(String), name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true });
    expect(s[2]).toEqual({ id: expect.any(String), name: 'DONE', label: 'Done', order: 2, exitCriteria: '', isAnchor: true });
  });
});
