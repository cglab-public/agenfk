import { describe, it, expect } from 'vitest';
import {
  computeSizingFromItems,
  prSizePoints,
  prSizeBucket,
  SIZE_BUCKETS,
  SIZE_WEIGHTS,
} from '../sizing.js';

describe('computeSizingFromItems', () => {
  it('counts each tier and flags a story with no children as a leaf story', () => {
    // EPIC → STORY(container, has tasks/bug) ; plus a standalone leaf STORY
    const items = [
      { id: 'e', type: 'EPIC', parentId: null },
      { id: 's1', type: 'STORY', parentId: 'e' }, // container (has children)
      { id: 't1', type: 'TASK', parentId: 's1' },
      { id: 't2', type: 'TASK', parentId: 's1' },
      { id: 'b1', type: 'BUG', parentId: 's1' },
      { id: 's2', type: 'STORY', parentId: 'e' }, // LEAF story (no children)
    ];
    expect(computeSizingFromItems(items)).toEqual({
      epic: 1, story: 2, task: 2, bug: 1, leafStory: 1,
    });
  });

  it('treats a lone STORY (no subtasks) as a leaf story', () => {
    const items = [{ id: 's', type: 'STORY', parentId: null }];
    expect(computeSizingFromItems(items)).toEqual({
      epic: 0, story: 1, task: 0, bug: 0, leafStory: 1,
    });
  });

  it('a STORY with subtasks is a container, not a leaf', () => {
    const items = [
      { id: 's', type: 'STORY', parentId: null },
      { id: 't', type: 'TASK', parentId: 's' },
    ];
    const c = computeSizingFromItems(items);
    expect(c.story).toBe(1);
    expect(c.leafStory).toBe(0);
  });

  it('handles an empty set', () => {
    expect(computeSizingFromItems([])).toEqual({
      epic: 0, story: 0, task: 0, bug: 0, leafStory: 0,
    });
  });
});

describe('prSizePoints', () => {
  it('weights leaf stories ×4, tasks ×2, bugs ×1 and never sums Epic/Story containers', () => {
    expect(SIZE_WEIGHTS).toEqual({ leafStory: 4, task: 2, bug: 1 });
    // 1 leaf story + 3 tasks + 2 bugs = 4 + 6 + 2 = 12
    expect(prSizePoints({ leafStory: 1, task: 3, bug: 2 })).toBe(12);
  });

  it('defaults missing fields to zero', () => {
    expect(prSizePoints({ task: 1 })).toBe(2);
    expect(prSizePoints({})).toBe(0);
  });
});

describe('prSizeBucket', () => {
  it('maps points to XS–XL bucket thresholds', () => {
    expect(SIZE_BUCKETS).toEqual(['xs', 's', 'm', 'l', 'xl']);
    expect(prSizeBucket(0)).toBe('xs');
    expect(prSizeBucket(2)).toBe('xs');
    expect(prSizeBucket(3)).toBe('s');
    expect(prSizeBucket(6)).toBe('s');
    expect(prSizeBucket(7)).toBe('m');
    expect(prSizeBucket(14)).toBe('m');
    expect(prSizeBucket(15)).toBe('l');
    expect(prSizeBucket(30)).toBe('l');
    expect(prSizeBucket(31)).toBe('xl');
    expect(prSizeBucket(999)).toBe('xl');
  });
});
