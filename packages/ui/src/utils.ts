export const stripAnsi = (str: string): string => {
  const pattern = [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))'
  ].join('|');

  return str.replace(new RegExp(pattern, 'g'), '');
};

// Shared with the hub's /usage page (GH-389).
export { getModelPrice } from '@agenfk/flow-editor';

export const formatCost = (cost: number): string => {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return '$' + cost.toFixed(4);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cost);
};

export const formatDuration = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

export const calculateCycleTimeMs = (item: any): number => {
  // If the item has no history (newly created), fallback to timestamps
  if (!item.history || item.history.length === 0) {
    if (item.status === 'TODO' || item.status === 'BLOCKED') return 0;
    return item.status === 'DONE' || item.status === 'ARCHIVED' 
      ? new Date(item.updatedAt).getTime() - new Date(item.createdAt).getTime()
      : Date.now() - new Date(item.createdAt).getTime();
  }

  let totalMs = 0;
  let currentIntervalStartMs: number | null = null;

  // States that "start" or "continue" the clock
  const ACTIVE_STATES = ['IN_PROGRESS', 'REVIEW', 'TEST'];
  // States that "stop" the clock
  const INACTIVE_STATES = ['TODO', 'BLOCKED', 'DONE', 'ARCHIVED'];

  for (const record of item.history) {
    const timestampMs = new Date(record.timestamp).getTime();
    
    if (currentIntervalStartMs === null) {
      // Clock is currently stopped. Check if we should start it.
      if (ACTIVE_STATES.includes(record.toStatus)) {
        currentIntervalStartMs = timestampMs;
      }
    } else {
      // Clock is currently running. Check if we should stop it.
      if (INACTIVE_STATES.includes(record.toStatus)) {
        totalMs += (timestampMs - currentIntervalStartMs);
        currentIntervalStartMs = null;
      }
    }
  }

  // If item is currently in an active state, add the elapsed time of the current interval
  if (currentIntervalStartMs !== null) {
    totalMs += (Date.now() - currentIntervalStartMs);
  }

  return totalMs;
};

/**
 * Short, human display name for a model id.
 *
 * The first meaningful alphabetic family token (>=3 letters, so version bits
 * like "v1" or "27b" are skipped), title-cased: "qwen3.6:27b" -> "Qwen",
 * "claude-opus-5" -> "Claude", "3.5-sonnet" -> "Sonnet". Falls back to the raw
 * id when no such token exists, so it never emits a meaningless single letter.
 *
 * Lives HERE, beside stripAnsi, rather than in either component that draws it.
 * It was private to RunsPanel and got copied into the Agents screen while that
 * screen was being built; two copies of one display rule are how "claude-code"
 * and "claude" became two vocabularies for a single agent. Exporting it from a
 * component file is not the fix either — eslint's react-refresh rule rejects
 * that, and it is right: a module that exports both a component and a helper
 * loses fast refresh.
 */
export function prettyModel(model?: string): string {
  if (!model) return '';
  const family = model.match(/[a-zA-Z]{3,}/)?.[0];
  if (!family) return model;
  return family.charAt(0).toUpperCase() + family.slice(1);
}
