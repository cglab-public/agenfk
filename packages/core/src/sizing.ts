// ── PR size model ────────────────────────────────────────────────────────────
// A PR's "size" is derived from the *leaves* of its item subtree — the lowest
// item in each branch — so the same work is never counted twice. An EPIC rolls
// up its STORYs, and a STORY rolls up its TASKs/BUGs; summing all four tiers
// would double-count. Tasks and bugs are always leaves. A STORY is a leaf only
// when it has no children (it is itself the unit of work).
//
// This module is shared by the spoke (which counts leaf stories while walking
// the item tree at PR-register time) and the hub (which turns the counts into
// weighted points and an XS–XL bucket).

export interface SizingCounts {
  epic: number;
  story: number;
  task: number;
  bug: number;
  /** STORYs with no child items — counted as atomic work, unlike container stories. */
  leafStory: number;
}

export interface SizeInput {
  leafStory?: number | null;
  task?: number | null;
  bug?: number | null;
}

/** Leaf-only weights. Epic/Story containers are intentionally absent — they are
 *  scope, not magnitude. A leaf story outweighs a task; a task outweighs a bug. */
export const SIZE_WEIGHTS = { leafStory: 4, task: 2, bug: 1 } as const;

export const SIZE_BUCKETS = ['xs', 's', 'm', 'l', 'xl'] as const;
export type SizeBucket = typeof SIZE_BUCKETS[number];

/** Inclusive upper bounds per bucket; anything above the last → 'xl'. */
export const SIZE_THRESHOLDS: ReadonlyArray<{ bucket: SizeBucket; max: number }> = [
  { bucket: 'xs', max: 2 },
  { bucket: 's', max: 6 },
  { bucket: 'm', max: 14 },
  { bucket: 'l', max: 30 },
];

interface TreeItem { id: string; type: string; parentId?: string | null }

/** Count each tier across a set of items, flagging childless STORYs as leaf
 *  stories. The items must form a closed set (a subtree): a STORY is a leaf when
 *  no item in the set names it as a parent. */
export function computeSizingFromItems(items: ReadonlyArray<TreeItem>): SizingCounts {
  const hasChild = new Set<string>();
  for (const it of items) if (it.parentId) hasChild.add(it.parentId);

  const counts: SizingCounts = { epic: 0, story: 0, task: 0, bug: 0, leafStory: 0 };
  for (const it of items) {
    switch (it.type) {
      case 'EPIC': counts.epic++; break;
      case 'STORY':
        counts.story++;
        if (!hasChild.has(it.id)) counts.leafStory++;
        break;
      case 'TASK': counts.task++; break;
      case 'BUG': counts.bug++; break;
    }
  }
  return counts;
}

/** Weighted size points: leafStory×4 + task×2 + bug×1. */
export function prSizePoints(s: SizeInput): number {
  return (s.leafStory ?? 0) * SIZE_WEIGHTS.leafStory
    + (s.task ?? 0) * SIZE_WEIGHTS.task
    + (s.bug ?? 0) * SIZE_WEIGHTS.bug;
}

/** Map weighted points to an ordinal XS–XL bucket. */
export function prSizeBucket(points: number): SizeBucket {
  for (const t of SIZE_THRESHOLDS) {
    if (points <= t.max) return t.bucket;
  }
  return 'xl';
}
