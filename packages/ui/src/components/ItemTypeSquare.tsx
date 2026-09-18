/**
 * The type grammar people already read (CGLAB-164).
 *
 * The create form's type control was a <select> showing four words, and four
 * words are four words: nothing tells EPIC from TASK until both have been read.
 * Every tracker this team already lives in says "issue type" the same way — a
 * small FILLED square, one colour per type, a white glyph inside it — and that
 * pairing is recognised before the word beside it is.
 *
 * So this is a grammar, not a control. The <select> stays exactly where it was
 * and keeps doing the choosing; this renders beside it and says which type you
 * are on.
 *
 * Two deliberate choices:
 *
 * - SOLID, not tinted. The modal already has `bg-brand/10` chips with coloured
 *   text, and they read as status. A 100%-filled square with a white mark is
 *   the thing being borrowed, and softening it loses exactly the recognition it
 *   was borrowed for.
 *
 * - A different GLYPH per type, not only a different colour. Violet and blue
 *   are one deuteranopia away from the same square.
 */
import React from 'react';
import { Zap, Bookmark, Check, Circle } from 'lucide-react';
import { clsx } from 'clsx';
import { ItemType } from '../types';

export interface ItemTypeVisual {
  /** The filled background. Tailwind's palette, not a brand token: there is no violet in `packages/brand/tokens.css`, and inventing one for four squares is a bigger change than this card is. */
  readonly fill: string;
  /** Drawn white on the fill. */
  readonly glyph: React.ReactNode;
}

export const ITEM_TYPE_VISUAL: Record<ItemType, ItemTypeVisual> = {
  [ItemType.EPIC]: { fill: 'bg-violet-600', glyph: <Zap size={9} strokeWidth={3} /> },
  [ItemType.STORY]: { fill: 'bg-emerald-600', glyph: <Bookmark size={9} strokeWidth={3} /> },
  [ItemType.TASK]: { fill: 'bg-blue-600', glyph: <Check size={9} strokeWidth={3.5} /> },
  [ItemType.BUG]: { fill: 'bg-rose-600', glyph: <Circle size={9} strokeWidth={4} /> },
};

/**
 * What choosing this type means, in one line.
 *
 * Every sentence here is checkable against the rules the server itself states
 * in `analyze_request` (packages/server/src/index.ts): an EPIC is never worked
 * directly and must be decomposed into stories; a STORY is broken into tasks
 * only when it is large.
 *
 * NOT said, though the design asked for it: "a task gets a worktree and a
 * branch, an epic does not". `packages/server/src/worktrees.ts` does not look
 * at item type anywhere, so putting that on screen would be the UI promising a
 * rule the server does not keep — the precise defect this whole redesign is
 * about, reintroduced as a helpful hint.
 */
export function itemTypeHint(type: ItemType): string {
  switch (type) {
    case ItemType.EPIC:
      return 'A container — never worked directly. Decompose it into stories first.';
    case ItemType.STORY:
      return 'One deliverable. Split it into tasks only when it is large.';
    case ItemType.TASK:
      return 'One focused pass of work.';
    case ItemType.BUG:
      return 'Something that is broken. Same lifecycle as a task.';
  }
}

export interface ItemTypeSquareProps {
  readonly type: ItemType;
  /** For the tests, and for anything that needs to point at the square. */
  readonly testId?: string;
  readonly className?: string;
}

export function ItemTypeSquare({ type, testId, className }: ItemTypeSquareProps) {
  const visual = ITEM_TYPE_VISUAL[type];
  return (
    <span
      data-testid={testId}
      // A second rendering of a value the control beside it already announces.
      // Reading it out twice is noise, not redundancy.
      aria-hidden="true"
      className={clsx(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] text-white',
        visual.fill,
        className,
      )}
    >
      {visual.glyph}
    </span>
  );
}
