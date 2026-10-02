/**
 * 281adef0 — where a flow runs the project's suite: at every card's final step
 * ('leaf', the default and today's behaviour) or once, at the top-level card
 * ('parent'). A flow-level setting, chosen per flow.
 */
import { describe, it, expect } from 'vitest';
import { verifyAtError, flowVerifyAt } from '../verifyAt';

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
