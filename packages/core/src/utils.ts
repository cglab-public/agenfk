import { ItemType, AgenFKItem, Flow, FlowStep } from './types.js';

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

// ── Card Migration Engine ─────────────────────────────────────────────────────

export interface MigrationResult {
  itemId: string;
  oldStatus: string;
  newStatus: string;
  reason: 'exact-match' | 'positional' | 'fallback';
}

/**
 * Map a single card's current status to a step in the new flow.
 *
 * Strategy (in priority order):
 * 1. Exact name match — find a step in newFlow whose `name` matches oldStatus (case-insensitive)
 * 2. Positional match — use the same index in newFlow as the card's step in oldFlow
 * 3. Fallback — first non-special step in newFlow, or IDEAS if all are special
 *
 * Special steps (isSpecial: true) in oldFlow are first tried with exact name match in newFlow.
 * If no match is found they fall back to IDEAS.
 */
export function migrateCardsToFlow(
  items: AgenFKItem[],
  oldFlow: Flow,
  newFlow: Flow,
): MigrationResult[] {
  const results: MigrationResult[] = [];

  // Pre-sort newFlow steps by order so positional lookup is deterministic
  const newStepsSorted = [...newFlow.steps].sort((a, b) => a.order - b.order);
  const oldStepsSorted = [...oldFlow.steps].sort((a, b) => a.order - b.order);

  // Find the fallback step: first non-special in new flow, or IDEAS
  const fallbackStep =
    newStepsSorted.find((s) => !s.isSpecial) ??
    newStepsSorted.find((s) => s.name.toUpperCase() === 'IDEAS') ??
    newStepsSorted[0];

  for (const item of items) {
    const oldStatus = item.status as string;

    // Find this card's step in the old flow (case-insensitive name match)
    const oldStep = oldStepsSorted.find(
      (s) => s.name.toLowerCase() === oldStatus.toLowerCase(),
    );

    // 1. Exact name match in new flow
    const exactMatch = newStepsSorted.find(
      (s) => s.name.toLowerCase() === oldStatus.toLowerCase(),
    );
    if (exactMatch) {
      results.push({
        itemId: item.id,
        oldStatus,
        newStatus: exactMatch.name,
        reason: 'exact-match',
      });
      continue;
    }

    // Special steps that don't exact-match → fall back to IDEAS
    if (oldStep?.isSpecial) {
      const ideasStep =
        newStepsSorted.find((s) => s.name.toUpperCase() === 'IDEAS') ??
        fallbackStep;
      results.push({
        itemId: item.id,
        oldStatus,
        newStatus: ideasStep?.name ?? 'IDEAS',
        reason: 'fallback',
      });
      continue;
    }

    // 2. Positional match
    if (oldStep) {
      const oldIndex = oldStepsSorted.indexOf(oldStep);
      const positionalStep = newStepsSorted[oldIndex];
      if (positionalStep) {
        results.push({
          itemId: item.id,
          oldStatus,
          newStatus: positionalStep.name,
          reason: 'positional',
        });
        continue;
      }
    }

    // 3. Fallback
    results.push({
      itemId: item.id,
      oldStatus,
      newStatus: fallbackStep?.name ?? 'IDEAS',
      reason: 'fallback',
    });
  }

  return results;
}
