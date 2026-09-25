/**
 * 1049ce52 — the `backlog` role: a card leaves the backlog only from a tree in
 * sync with its remote. User 2026-09-25: "A new 'backlog' role (and check)
 * should assert that the current worktree is in sync with its remote (if a
 * remote exists)." Found when a session built a card 25 commits behind origin.
 */
import { describe, it, expect } from 'vitest';
import { STEP_ROLES, ROLE_BUILTINS, CHECK_CATALOGUE, resolveStepChecks, flowChecksErrors } from '../flowChecks';
import { DEFAULT_FLOW } from '../defaultFlow';
import { TDD_FLOW_PRESET } from '../flowPresets';

describe('the backlog role', () => {
  it('is a role, and brings the tree-in-sync check', () => {
    expect(STEP_ROLES).toContain('backlog');
    expect(ROLE_BUILTINS.backlog.map(c => c.id)).toEqual(['tree-in-sync']);
  });

  it('tree-in-sync is a blocking git check that needs the network', () => {
    const def = (CHECK_CATALOGUE as any)['tree-in-sync'];
    expect(def).toMatchObject({ id: 'tree-in-sync', group: 'git', defaultSeverity: 'block', network: true });
  });

  it('runs when a card leaves a backlog step', () => {
    const steps = [
      { id: 'a', name: 'TODO', label: 'To Do', order: 0, isAnchor: true, role: 'backlog' },
      { id: 'b', name: 'WORK', label: 'Work', order: 1 },
      { id: 'c', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
    ] as any;
    expect(flowChecksErrors(steps)).toEqual([]);
    expect(resolveStepChecks(steps, 'TODO').some(c => c.id === 'tree-in-sync' && c.applicable && c.source === 'role')).toBe(true);
  });

  it('can be added to any step on its own', () => {
    const steps = [
      { id: 'a', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
      { id: 'b', name: 'WORK', label: 'Work', order: 1, checks: [{ id: 'tree-in-sync' }] },
      { id: 'c', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
    ] as any;
    expect(flowChecksErrors(steps)).toEqual([]);
    expect(resolveStepChecks(steps, 'WORK').some(c => c.id === 'tree-in-sync' && c.applicable)).toBe(true);
  });
});

describe('the shipped flows start with a backlog step', () => {
  it("the default flow's TODO", () => {
    expect(DEFAULT_FLOW.steps.find(s => s.name === 'TODO')?.role).toBe('backlog');
  });
  it("the TDD preset's TODO", () => {
    expect(TDD_FLOW_PRESET.steps.find((s: any) => s.name === 'TODO')?.role).toBe('backlog');
  });
});
