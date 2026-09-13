/**
 * What is actually moving in a project (CGLAB-172).
 *
 * The sidebar folder shows work in flight — not the backlog, not the archive.
 * "In flight" is derived from the project's own flow rather than from a list of
 * status names, because projects define their own steps: this repo's TDD flow
 * has no IN_PROGRESS at the point where work starts, and a hardcoded list would
 * quietly show the wrong thing on every custom flow.
 */
import type { AgEnFKItem, Flow } from './types';

/**
 * Statuses that exist outside the flow entirely. An item parked here is not
 * moving, whatever step it was in when it stopped. Archiving is one of these —
 * in this model it is a status transition, not a flag on the item.
 */
const NOT_MOVING = new Set(['PAUSED', 'BLOCKED', 'IDEAS', 'ARCHIVED', 'TRASHED']);

/**
 * Items sitting in a working step of `flow` — every step except the TODO and
 * DONE anchors at either end.
 *
 * Returns nothing when the flow is missing. A flow still loading would
 * otherwise flash the project's entire backlog into the folder and then
 * collapse it, which reads as a bug even though it corrects itself.
 */
export function inFlightItems(items: AgEnFKItem[], flow: Flow | undefined | null): AgEnFKItem[] {
  if (!flow?.steps?.length) return [];

  const working = new Set(
    flow.steps
      // isSpecial is the deprecated spelling of isAnchor; older flows still
      // carry it, and missing it would put the backlog in every folder.
      .filter(step => !step.isAnchor && !step.isSpecial)
      .map(step => step.name),
  );

  return items.filter(item =>
    !NOT_MOVING.has(item.status) && working.has(item.status),
  );
}
