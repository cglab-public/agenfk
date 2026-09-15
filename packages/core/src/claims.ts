/**
 * Which files a card owns, and whether two cards want the same ones (819e7192).
 *
 * With several agents in one worktree, git stops helping. Two of them editing
 * one file is a RACE, not a merge conflict: nobody is told and the loser's edit
 * is simply gone. Separate worktrees would have made it a conflict a person has
 * to resolve; one shared tree makes it silent. A claim is the only thing left
 * standing between two agents and the same file.
 *
 * CLAIMS ARE NOT GLOBS, and that is the load-bearing decision here.
 *
 * The obvious design is `packages/ui/**` and a glob matcher. But the question
 * this module has to answer is not "does this path match this pattern" - it is
 * "can these two patterns ever match the same path", and that is a different
 * and much harder question. `packages/**\/test/*` against `packages/ui/**` has
 * no cheap answer, and minimatch does not offer one because it was never the
 * problem it solves.
 *
 * A claim that cannot be checked precisely is worse than no claim: it reports
 * safety it has not established. So the input is constrained to two shapes
 * where overlap is exact - a DIRECTORY PREFIX, or an EXACT FILE - and anything
 * else is refused at the door rather than approximated.
 *
 * Pure on purpose. No storage, no routes, no clock: every layer above this is
 * wrong if this is wrong, and this way it can be argued with in isolation.
 */

/** A claim: `packages/ui/` owns a subtree, `packages/ui/src/App.tsx` one file. */
export type Claim = string;

export interface ClaimConflict {
  /** The claim being asked for. */
  readonly wanted: Claim;
  /** The claim already held that it runs into. */
  readonly held: Claim;
  /** Which card holds it, so a refusal can name somebody. */
  readonly heldBy: string;
}

/**
 * Reject what cannot be reasoned about.
 *
 * Refusing is the whole point: a wildcard accepted here would be silently
 * treated as a literal, and a claim on a file named `**` protects nothing while
 * looking like it protects everything.
 */
export function isWellFormedClaim(claim: unknown): claim is Claim {
  if (typeof claim !== 'string') return false;
  const trimmed = claim.trim();
  if (!trimmed || trimmed !== claim) return false;
  // Repository-relative, always. An absolute path claims something outside the
  // tree every other card is sharing.
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) return false;
  // `..` escapes the repository, and a claim is also a commit path list.
  if (trimmed.split('/').some(seg => seg === '..' || seg === '.')) return false;
  // Glob syntax, refused rather than approximated. See the header.
  if (/[*?[\]{}]/.test(trimmed)) return false;
  return true;
}

/** Trailing slashes dropped: `packages/ui/` and `packages/ui` are one claim. */
function normalise(claim: Claim): string {
  return claim.replace(/\/+$/, '');
}

/**
 * Does one claim cover the other, in either direction?
 *
 * Containment is decided at a SEGMENT BOUNDARY, not by string prefix, and not
 * by whether somebody remembered a trailing slash.
 *
 * The trailing slash was the first design and it was wrong in the dangerous
 * direction. Requiring `packages/ui/` to mean the directory left
 * `packages/ui` - which is what people write - matching nothing at all, so a
 * claim made in good faith protected no files and reported clear. Failing OPEN
 * is the one outcome this module must not have, because what it costs is an
 * edit somebody loses in silence.
 *
 * The boundary is also what keeps `packages/ui` away from
 * `packages/ui-legacy/App.tsx`: a plain `startsWith` sees a prefix there, and
 * they are unrelated trees that happen to share the start of a name. Same trap
 * for `src/App.tsx` against `src/App.tsx.map`.
 */
export function claimsCollide(a: Claim, b: Claim): boolean {
  const x = normalise(a);
  const y = normalise(b);
  if (x === y) return true;
  const contains = (outer: string, inner: string): boolean =>
    inner.startsWith(outer + '/');
  return contains(x, y) || contains(y, x);
}

/**
 * What a card cannot have, because somebody else is already holding it.
 *
 * Returns EVERY conflict rather than the first. A lead planning a fan-out needs
 * the whole picture to re-cut the split; handing back one collision at a time
 * turns one decision into a sequence of them.
 */
export function findClaimConflicts(
  wanted: readonly Claim[],
  held: ReadonlyArray<{ readonly itemId: string; readonly claims: readonly Claim[] }>,
  /** The card asking. Its own held claims are not conflicts with itself. */
  askingItemId?: string,
): ClaimConflict[] {
  const conflicts: ClaimConflict[] = [];
  for (const want of wanted) {
    if (!isWellFormedClaim(want)) continue;
    for (const holder of held) {
      if (holder.itemId === askingItemId) continue;
      for (const heldClaim of holder.claims) {
        if (!isWellFormedClaim(heldClaim)) continue;
        if (claimsCollide(want, heldClaim)) {
          conflicts.push({ wanted: want, held: heldClaim, heldBy: holder.itemId });
        }
      }
    }
  }
  return conflicts;
}
