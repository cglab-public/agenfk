// Item-type colours on the board (CGLAB-434): each type wears its own theme
// token (brand/tokens.css --type-*), the same hues the hub uses, and always
// next to its EPIC/STORY/TASK/BUG label.
import { ItemType } from './types';

const TYPE: Record<string, string> = {
  [ItemType.EPIC]: 'text-type-epic border-type-epic/40 bg-type-epic/10',
  [ItemType.STORY]: 'text-type-story border-type-story/40 bg-type-story/10',
  [ItemType.TASK]: 'text-type-task border-type-task/40 bg-type-task/10',
  [ItemType.BUG]: 'text-type-bug border-type-bug/40 bg-type-bug/10',
};

/** Chip classes (text, border, tint) for an item type; neutral for anything else. */
export const itemTypeClass = (type: string): string => TYPE[type] ?? 'text-ink-secondary border-border-soft bg-canvas';

const DOT: Record<string, string> = {
  [ItemType.EPIC]: 'bg-type-epic',
  [ItemType.STORY]: 'bg-type-story',
  [ItemType.TASK]: 'bg-type-task',
  [ItemType.BUG]: 'bg-type-bug',
};

/** A solid dot in the item type's colour. */
export const itemTypeDot = (type: string): string => DOT[type] ?? 'bg-ink-tertiary';
