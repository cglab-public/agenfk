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
import { Zap, Bookmark, Check, Circle, HelpCircle, type LucideIcon } from 'lucide-react';
import { clsx } from 'clsx';
import { ItemType } from '../types';

export interface ItemTypeVisual {
  /** The filled background. Tailwind's palette, not a brand token: there is no violet in `packages/brand/tokens.css`, and inventing one for four squares is a bigger change than this card is. */
  readonly fill: string;
  /** Drawn white on the fill. A COMPONENT, not an element, so the glyph can be sized with the square it sits in. */
  readonly Glyph: LucideIcon;
  readonly stroke: number;
}

export const ITEM_TYPE_VISUAL: Record<ItemType, ItemTypeVisual> = {
  [ItemType.EPIC]: { fill: 'bg-violet-600', Glyph: Zap, stroke: 3 },
  [ItemType.STORY]: { fill: 'bg-emerald-600', Glyph: Bookmark, stroke: 3 },
  [ItemType.TASK]: { fill: 'bg-blue-600', Glyph: Check, stroke: 3.5 },
  [ItemType.BUG]: { fill: 'bg-rose-600', Glyph: Circle, stroke: 4 },
};

/**
 * What an unrecognised type looks like, rather than what it used to do.
 *
 * Four call sites cast a plain string off the wire to `ItemType` — the import
 * modals map a tracker's own issue-type names — so the compiler's guarantee is
 * gone exactly where the data is least trusted. `ITEM_TYPE_VISUAL[x].fill` on a
 * miss read `undefined.fill` and took the screen with it. Grey with a question
 * mark says "type unknown", which is both true and survivable.
 */
const UNKNOWN_TYPE_VISUAL: ItemTypeVisual = { fill: 'bg-slate-400', Glyph: HelpCircle, stroke: 3 };

/** Named sizes, because a `className` override cannot win against the stylesheet — see `ItemTypeBadge`. */
export const ITEM_TYPE_SIZES = {
  sm: { box: 'h-3 w-3', glyph: 7, text: 'text-[9px]', pad: 'px-1.5 py-0.5' },
  md: { box: 'h-4 w-4', glyph: 9, text: 'text-xs', pad: 'px-2 py-1' },
} as const;

export type ItemTypeSize = keyof typeof ITEM_TYPE_SIZES;

/**
 * The four types in the order they are offered, for every picker that offers
 * them. Both import modals had grown their own copy of this list — one of them
 * derived from the private palette that has just been retired.
 */
export const ITEM_TYPES = [ItemType.EPIC, ItemType.STORY, ItemType.TASK, ItemType.BUG] as const;

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
  /**
   * No `className` here either.
   *
   * It was accepted and used by nobody, and what it accepted was `h-*`/`w-*` —
   * the exact fight `size` exists to end, two lines under the comment
   * explaining why `ItemTypeBadge` may not have this seam.
   */
  readonly size?: ItemTypeSize;
}

export function ItemTypeSquare({ type, testId, size = 'md' }: ItemTypeSquareProps) {
  const visual = ITEM_TYPE_VISUAL[type] ?? UNKNOWN_TYPE_VISUAL;
  const { box, glyph } = ITEM_TYPE_SIZES[size];
  return (
    <span
      data-testid={testId}
      // A second rendering of a value the control beside it already announces.
      // Reading it out twice is noise, not redundancy.
      aria-hidden="true"
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-[3px] text-white',
        box,
        visual.fill,
      )}
    >
      <visual.Glyph size={glyph} strokeWidth={visual.stroke} />
    </span>
  );
}

export interface ItemTypeBadgeProps {
  readonly type: ItemType;
  /**
   * `sm` on dense lists (board cards, tables), `md` where the badge is the
   * heading of a screen.
   *
   * A NAMED size, and no `className`, because the first version had neither:
   * it hardcoded `text-[10px]` and let callers pass `text-xs` / `text-[9px]`
   * through a `className`. `clsx` concatenates and Tailwind resolves by the
   * order in the GENERATED stylesheet, where `.text-[10px]` lands last — so
   * both overrides were silently dead, one badge shrank and the other grew,
   * and both call sites read as though they had worked. `AgenfkFlag.tsx`
   * already records this trap in this repo. Removing the seam is cheaper than
   * arbitrating it.
   */
  readonly size?: ItemTypeSize;
}

/**
 * The square and the word, for every place a card's SETTLED type is displayed.
 *
 * It exists because three mappings were on screen at once. The board painted
 * STORY with `story-blue` and TASK with `brand` (teal); the Subitems table used
 * `blue-50` for STORY and `emerald-50` for TASK; the create form's new square
 * used the tracker grammar — story green, task blue. So the one screen that
 * TEACHES the colour→type mapping taught the reverse of the screen the card
 * lands on: choose STORY, see green, press Create, and the card arrives blue
 * sitting among green TASKs.
 *
 * The create form's half is the correct one — it is the grammar that was asked
 * for by name, and the one every tracker outside this app already uses — so the
 * fix is to propagate it rather than invert it, leaving exactly one place where
 * a type's colour is decided.
 *
 * The colour lives in the square and the word stays in ordinary ink. That is
 * what RETIRES the old per-type text/border tints rather than replacing them
 * with four new ones, and it keeps the type readable when the colour is not.
 */
export function ItemTypeBadge({ type, size = 'sm' }: ItemTypeBadgeProps) {
  const { text, pad } = ITEM_TYPE_SIZES[size];
  return (
    <span
      data-testid="item-type-badge"
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md border border-border-soft',
        'font-bold uppercase tracking-wider text-ink-secondary',
        text,
        pad,
      )}
    >
      <ItemTypeSquare type={type} size={size} />
      {type}
    </span>
  );
}
