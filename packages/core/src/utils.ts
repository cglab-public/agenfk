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

/**
 * Token-Oriented Object Notation (TOON) serializer.
 * Optimized for LLM token usage and structural accuracy.
 * Handles arrays of uniform objects (tabular) and single objects (indented).
 */
export function toToon(data: any): string {
  if (data === null || data === undefined) return String(data);

  if (Array.isArray(data)) {
    if (data.length === 0) return '[]';

    // Infer headers from the first item
    const headers = Object.keys(data[0]);
    if (headers.length === 0) return `[${data.length}]`;

    let out = `{${headers.join(',')}}\n`;
    out += `items[${data.length}]\n`;

    for (const item of data) {
      const values = headers.map(h => {
        const val = item[h];
        if (val === null || val === undefined) return '';
        const str = String(val).replace(/[\n\r\t]/g, ' ');
        return str.includes(',') ? `"${str}"` : str;
      });
      out += `${values.join(',')}\n`;
    }
    return out.trim();
  }

  if (typeof data === 'object') {
    return Object.entries(data)
      .map(([k, v]) => {
        const val = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
        return `${k}: ${val}`;
      })
      .join('\n');
  }

  return String(data);
}
