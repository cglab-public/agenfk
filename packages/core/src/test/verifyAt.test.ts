/**
 * 281adef0 — where a flow runs the project's suite: at every card's final step
 * ('leaf', the default and today's behaviour) or once, at the top-level card
 * ('parent'). A flow-level setting, chosen per flow.
 */
import { describe, it, expect } from 'vitest';
import { verifyAtError, flowVerifyAt, verifyAtScopeError, effectiveVerifyAtScope } from '../verifyAt';

describe('verifyAtError', () => {
  it('accepts leaf, parent, and absence', () => {
    expect(verifyAtError(undefined)).toBeNull();
    expect(verifyAtError('leaf')).toBeNull();
    expect(verifyAtError('parent')).toBeNull();
  });
  it('refuses anything else, naming the allowed values', () => {
    expect(verifyAtError('top')).toMatch(/'leaf' or 'parent'/);
    expect(verifyAtError(true)).toMatch(/'leaf' or 'parent'/);
  });
});

describe('flowVerifyAt', () => {
  it("is 'parent' only when the flow says so, and 'leaf' otherwise", () => {
    expect(flowVerifyAt({ verifyAt: 'parent' })).toBe('parent');
    expect(flowVerifyAt({ verifyAt: 'leaf' })).toBe('leaf');
    expect(flowVerifyAt({})).toBe('leaf');
    expect(flowVerifyAt({ verifyAt: 'nonsense' } as any)).toBe('leaf');
    expect(flowVerifyAt(null)).toBe('leaf');
  });
});

/*
 * 7ddeaf7c — how far 'parent' reaches: only a parent in the SAME tree
 * ('worktree', the default and the behaviour before the setting), or any open
 * parent in the project ('project'). The flow says it; a project may override.
 */
describe('verifyAtScopeError', () => {
  it('accepts worktree, project, and absence', () => {
    expect(verifyAtScopeError(undefined)).toBeNull();
    expect(verifyAtScopeError(null)).toBeNull();
    expect(verifyAtScopeError('worktree')).toBeNull();
    expect(verifyAtScopeError('project')).toBeNull();
  });
  it('refuses anything else, naming the allowed values', () => {
    expect(verifyAtScopeError('repo')).toMatch(/'worktree' or 'project'/);
    expect(verifyAtScopeError(1)).toMatch(/'worktree' or 'project'/);
  });
});

describe('effectiveVerifyAtScope', () => {
  it("is the flow's scope when the project sets none, and 'worktree' when neither does", () => {
    expect(effectiveVerifyAtScope({ verifyAtScope: 'project' }, {})).toBe('project');
    expect(effectiveVerifyAtScope({}, {})).toBe('worktree');
    expect(effectiveVerifyAtScope(null, null)).toBe('worktree');
    expect(effectiveVerifyAtScope({ verifyAtScope: 'nonsense' } as any, undefined)).toBe('worktree');
  });
  it("the project's own value wins over the flow's, either way", () => {
    expect(effectiveVerifyAtScope({ verifyAtScope: 'worktree' }, { verifyAtScope: 'project' })).toBe('project');
    expect(effectiveVerifyAtScope({ verifyAtScope: 'project' }, { verifyAtScope: 'worktree' })).toBe('worktree');
  });
  it("an unknown project value falls back to the flow's, not to the default", () => {
    expect(effectiveVerifyAtScope({ verifyAtScope: 'project' }, { verifyAtScope: 'bogus' } as any)).toBe('project');
  });
});
