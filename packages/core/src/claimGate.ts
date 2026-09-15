/**
 * Turning a claim into a refusal (819e7192).
 *
 * claims.ts answers whether two paths overlap, and nothing asks it. It has
 * been complete and unreachable since it was written: the gatekeeper does not
 * consult it, dispatch does not consult it, and closeCommit takes claims
 * through a parameter no caller passes. This is the layer that closes that.
 *
 * TWO FAILURES, IN OPPOSITE DIRECTIONS, AND BOTH ARE EASY HERE.
 *
 * Blocking everything is the first. Every card in the database predates this
 * field, so a gate that reads absence as conflict refuses the first edit
 * anybody makes after it ships. Absence authorizes.
 *
 * Failing open is the second, and it is the one claims.ts had four times over.
 * A claim this cannot parse is not a claim it has cleared: the card that wrote
 * `packages/**` believes it holds that subtree and holds nothing at all.
 * Reporting that as authorization tells it the opposite of the truth.
 *
 * Pure, like claims.ts, and for the same reason: the server, the CLI and the
 * MCP tool must reach the same verdict, and three copies would drift the way
 * the gatekeeper's hardcoded status names drifted before it.
 */

import { findClaimConflicts, type Claim, type ClaimConflict } from './claims';

export interface ClaimHolder {
  readonly id: string;
  /** Where the card sits in its flow. Decides whether it still holds files. */
  readonly status: string;
  readonly claims?: readonly Claim[];
}

export interface ClaimGateResult {
  readonly authorized: boolean;
  readonly conflicts: readonly ClaimConflict[];
  /** Claims that could not be checked, and therefore have NOT been cleared. */
  readonly rejected: readonly Claim[];
  /** What to tell the agent. Empty when authorized. */
  readonly message: string;
}

/**
 * Statuses where a card has stopped holding its files.
 *
 * DELIBERATELY NOT `INACTIVE_STATUSES` from gatekeeper.ts, and reusing it is
 * the obvious mistake to make here. That set answers "is this card working",
 * which includes PAUSED and BLOCKED. This one answers "are this card's files
 * finished with", and a paused card's files are the opposite of finished: they
 * are half-edited and lying in the shared tree. Handing them to another agent
 * is exactly the race this mechanism exists to prevent, and the paused agent
 * meets it on resume, which is the worst possible moment to find out.
 *
 * A terminal card is different. Its work is committed or abandoned, so holding
 * the files forever would make the first fan-out permanent. IDEAS is here
 * because an idea has never been worked and has nothing in the tree.
 */
const RELEASED_STATUSES = new Set(['DONE', 'TRASHED', 'ARCHIVED', 'IDEAS']);

/** Does this card still own the files it declared? */
export const stillHolds = (status: string): boolean =>
  !RELEASED_STATUSES.has(status.toUpperCase());

/**
 * What to say, given that the agent reads this once and acts on it.
 *
 * It names the file and the holder because "claim conflict" produces a retry,
 * and a retry produces the overwrite. It offers no retry of its own: there is
 * nothing to wait for, since the holder is not going to release mid-edit.
 */
function explain(conflicts: readonly ClaimConflict[], rejected: readonly Claim[]): string {
  const parts: string[] = [];
  if (conflicts.length) {
    const lines = conflicts.map(c => `  ${c.wanted} is inside ${c.held}, held by ${c.heldBy}`);
    parts.push(
      `This card claims ${conflicts.length === 1 ? 'a path' : 'paths'} another card already owns:\n`
      + lines.join('\n')
      + '\nSeveral agents share this worktree, so two cards editing one file is a silent '
      + 'overwrite rather than a merge conflict. Narrow this card\'s claim, or move the work '
      + 'to the card that holds it.',
    );
  }
  if (rejected.length) {
    parts.push(
      `These claims could not be checked, so they have NOT been cleared: ${rejected.join(', ')}. `
      + 'A claim is a directory or an exact file. Globs are refused rather than approximated, '
      + 'because a claim on a file named `**` protects nothing while looking like it protects '
      + 'everything.',
    );
  }
  return parts.join('\n\n');
}

/**
 * May this card edit the paths it claims?
 *
 * Returns every conflict rather than the first: a lead re-cutting a fan-out
 * needs the whole picture, and one collision at a time turns a single decision
 * into a sequence of them, each invalidating the last.
 */
export function gateOnClaims(
  asking: { readonly id: string; readonly claims?: readonly Claim[] },
  holders: readonly ClaimHolder[],
): ClaimGateResult {
  const wanted = asking.claims ?? [];
  // Absence authorizes. See the header: this is the state every card is in
  // today, and the alternative is refusing all work on the deploy that adds it.
  if (!wanted.length) {
    return { authorized: true, conflicts: [], rejected: [], message: '' };
  }

  const held = holders
    .filter(h => stillHolds(h.status))
    .map(h => ({ itemId: h.id, claims: h.claims }));

  const { conflicts, rejected } = findClaimConflicts(wanted, held, asking.id);
  const authorized = conflicts.length === 0 && rejected.length === 0;

  return {
    authorized,
    conflicts,
    rejected,
    message: authorized ? '' : explain(conflicts, rejected),
  };
}
