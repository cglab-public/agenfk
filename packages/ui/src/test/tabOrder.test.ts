import { describe, it, expect } from 'vitest';
import { moveInOrder } from '../tabOrder';

const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const ids = (l: readonly { id: string }[]) => l.map(x => x.id);

describe('reordering open tabs', () => {
  it('moves a tab BEFORE the one it was dropped on', () => {
    expect(ids(moveInOrder(list, 'c', 'a', 'before'))).toEqual(['c', 'a', 'b']);
  });

  it('moves a tab AFTER the one it was dropped on', () => {
    expect(ids(moveInOrder(list, 'a', 'c', 'after'))).toEqual(['b', 'c', 'a']);
  });

  it('moves BACKWARDS as well as forwards', () => {
    // Removing an earlier element shifts every later index; reading the target
    // from the original array is the off-by-one this pins.
    expect(ids(moveInOrder(list, 'c', 'b', 'before'))).toEqual(['a', 'c', 'b']);
    expect(ids(moveInOrder(list, 'b', 'a', 'after'))).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op when dropped on itself', () => {
    expect(moveInOrder(list, 'b', 'b', 'before')).toBe(list);
  });

  it('is a no-op for an unknown id on either side', () => {
    expect(moveInOrder(list, 'zz', 'a', 'before')).toBe(list);
    expect(moveInOrder(list, 'a', 'zz', 'before')).toBe(list);
  });
});