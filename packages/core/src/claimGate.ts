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

import { findClaimConflicts, claimsCollide, type Claim, type ClaimConflict } from './claims';

export interface ClaimHolder {
  readonly id: string;
  /** Where the card sits in its flow. Decides whether it still holds files. */
  readonly status: string;
  readonly claims?: readonly Claim[];
  /**
   * The worktree the card works in (see `claimTreeOf`). Null or absent when
   * nobody can say, and an unknown tree collides with every tree.
   */
  readonly tree?: string | null;
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
 * Do two cards share a working tree, as far as claims are concerned? (aaa01834)
 *
 * Claims exist because two cards editing one file IN ONE TREE is a silent
 * overwrite. Cards in different worktrees cannot race - they meet, at worst,
 * as an ordinary merge conflict - so locking across trees only refuses work.
 *
 * An UNKNOWN tree answers yes. "Nobody can say where this card works" is not
 * evidence that it works elsewhere, and treating it that way would fail open
 * on exactly the cards this mechanism was written for.
 */
export function sameClaimTree(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (t: string | null | undefined): string => (typeof t === 'string' ? t.trim().replace(/[\\/]+$/, '') : '');
  const x = norm(a), y = norm(b);
  if (!x || !y) return true;
  return x === y;
}

/**
 * The tree a card works in: its own worktree, else its nearest ancestor's,
 * else the project root. Null when none of those is known.
 *
 * Mirrors `effectiveWorktreePath` in the server, which resolves the same
 * question for the close commit; this one takes a lookup rather than storage
 * so the gatekeeper, the CLI and the claims route can share it. Bounded and
 * cycle-safe for the same reason: a hand-edited parent loop must not hang.
 */
export function claimTreeOf<T extends { id?: string; parentId?: string | null; worktreePath?: string | null }>(
  item: T,
  lookup: (id: string) => T | undefined,
  projectRoot?: string | null,
): string | null {
  const seen = new Set<string>();
  let cur: T | undefined = item;
  for (let depth = 0; cur && depth < 32; depth++) {
    const wt = typeof cur.worktreePath === 'string' ? cur.worktreePath.trim() : '';
    if (wt) return wt;
    const parentId = cur.parentId;
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    cur = lookup(parentId);
  }
  const root = typeof projectRoot === 'string' ? projectRoot.trim() : '';
  return root || null;
}

/**
 * Staged files that belong to nobody (aaa01834).
 *
 * The close commit takes only a card's claimed files, so a file the card
 * changed and forgot to claim stays staged after the card is DONE - and the
 * next agent in the tree inherits it with no owner. Returns the staged paths
 * that fall outside the card's claims AND outside every claim still held by
 * another card in the same tree (those are that card's work, not a stray).
 *
 * A card that claims nothing has no strays: its commit takes the whole index,
 * which is the behaviour every card had before claims existed.
 */
export function strayStaged(
  staged: readonly string[],
  card: { readonly id: string; readonly claims?: readonly Claim[]; readonly tree?: string | null },
  holders: readonly ClaimHolder[],
): string[] {
  const mine = card.claims ?? [];
  if (!mine.length) return [];
  const theirs = holders
    .filter(h => h.id !== card.id && stillHolds(h.status) && sameClaimTree(card.tree, h.tree))
    .flatMap(h => h.claims ?? []);
  return staged.filter(f => !mine.some(c => claimsCollide(f, c)) && !theirs.some(c => claimsCollide(f, c)));
}

/**
 * Cards sharing this card's tree that are working and claim NOTHING (aaa01834
 * review). A claimless card is authorized everywhere, so a staged file outside
 * every claim may well be its work: ownership there is unknown, not absent.
 * The close must not be refused over it - both ways out it would offer (claim
 * the file, or unstage it) take that card's work away from it.
 *
 * `isWorking` is the caller's: whether a status counts as being worked is the
 * flow's question (an unstarted TODO card has nothing staged), and this module
 * has no flow.
 */
export function claimlessNeighbours(
  card: { readonly id: string; readonly tree?: string | null },
  holders: readonly ClaimHolder[],
  isWorking: (status: string) => boolean,
): string[] {
  return holders
    .filter(h => h.id !== card.id && !(h.claims ?? []).length && stillHolds(h.status) && isWorking(h.status) && sameClaimTree(card.tree, h.tree))
    .map(h => h.id);
}

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
    const lines = conflicts.map(c =>
      // "X is inside X" is what an exact collision used to read as, which is
      // nonsense at the moment somebody most needs the sentence to be clear.
      c.wanted === c.held
        ? `  ${c.wanted} is already held by ${c.heldBy}`
        : `  ${c.wanted} is inside ${c.held}, held by ${c.heldBy}`);
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
  asking: { readonly id: string; readonly claims?: readonly Claim[]; readonly tree?: string | null },
  holders: readonly ClaimHolder[],
): ClaimGateResult {
  const wanted = asking.claims ?? [];
  // Absence authorizes. See the header: this is the state every card is in
  // today, and the alternative is refusing all work on the deploy that adds it.
  if (!wanted.length) {
    return { authorized: true, conflicts: [], rejected: [], message: '' };
  }

  // Only holders in the asking card's tree (aaa01834): see sameClaimTree.
  const held = holders
    .filter(h => stillHolds(h.status) && sameClaimTree(asking.tree, h.tree))
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
