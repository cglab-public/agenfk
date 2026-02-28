import { ItemType } from './types.js';

/**
 * Convert a title string into a URL/branch-safe slug.
 */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 50)
    .replace(/-$/, '');
}

/**
 * Build a branch name from an item type and title.
 * BUG → fix/<slug>, others → feature/<slug>
 */
export function buildBranchName(type: ItemType, title: string): string {
  const prefix = type === ItemType.BUG ? 'fix' : 'feature';
  return `${prefix}/${slugifyTitle(title)}`;
}
