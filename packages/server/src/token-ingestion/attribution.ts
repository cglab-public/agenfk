import type { AgEnFKItem } from '@agenfk/core';

interface MinimalFlow {
  steps: Array<{ name: string; isAnchor?: boolean }>;
}

const INACTIVE_STATUSES = new Set(['BLOCKED', 'PAUSED', 'TRASHED', 'ARCHIVED', 'IDEAS']);

function activeStatusSet(flow: MinimalFlow | null): (status: string) => boolean {
  const anchors = new Set(
    flow ? flow.steps.filter((s) => s.isAnchor).map((s) => s.name.toUpperCase()) : ['TODO', 'DONE'],
  );
  return (status: string) => {
    const u = status.toUpperCase();
    return !anchors.has(u) && !INACTIVE_STATUSES.has(u);
  };
}

/**
 * Given the items in a project and a timestamp T, return the id of the item
 * whose most-recent transition INTO an active step occurred at or before T,
 * provided the item has not transitioned OUT of the active step before T.
 *
 * "Active" = not an anchor (TODO/DONE) and not in the inactive set
 * (BLOCKED/PAUSED/TRASHED/ARCHIVED/IDEAS).
 *
 * Returns null when no item was active at T.
 */
export function findActiveItemAt(
  items: AgEnFKItem[],
  flow: MinimalFlow | null,
  ts: string,
): string | null {
  const isActive = activeStatusSet(flow);
  const tMs = new Date(ts).getTime();

  let bestId: string | null = null;
  let bestActivationMs = -Infinity;

  for (const item of items) {
    const history = (item.history ?? [])
      .map((h) => ({ to: String(h.toStatus), tMs: new Date(h.timestamp as any).getTime() }))
      .filter((h) => h.tMs <= tMs)
      .sort((a, b) => a.tMs - b.tMs);

    if (history.length === 0) continue;

    // Walk forward; track the latest activation point that is still in effect at T.
    let activeSince = -Infinity;
    for (const h of history) {
      if (isActive(h.to)) {
        // Only update activation point if we weren't already in an active step,
        // so the "activation" reflects entry into the active region (handles re-entry).
        if (activeSince === -Infinity || !isActive(h.to)) {
          activeSince = h.tMs;
        } else {
          activeSince = h.tMs;
        }
      } else {
        activeSince = -Infinity;
      }
    }

    if (activeSince === -Infinity) continue;
    if (activeSince > bestActivationMs) {
      bestActivationMs = activeSince;
      bestId = item.id;
    }
  }

  return bestId;
}
