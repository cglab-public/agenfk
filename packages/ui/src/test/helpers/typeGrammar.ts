/**
 * Which item types an element is painted as, read off the grammar's own fills.
 *
 * The site tests use this instead of the old repo-wide source scan in
 * ItemTypeSquare.test.tsx: a site is right when what it RENDERS for a type
 * carries that type's fill and no other type's.
 */
import { ITEM_TYPE_VISUAL } from '../../components/ItemTypeSquare';
import { ItemType } from '../../types';

export function paintedTypes(el: Element): ItemType[] {
  const nodes = [el, ...Array.from(el.querySelectorAll('*'))];
  return (Object.keys(ITEM_TYPE_VISUAL) as ItemType[])
    .filter(t => nodes.some(n => n.classList.contains(ITEM_TYPE_VISUAL[t].fill)));
}
