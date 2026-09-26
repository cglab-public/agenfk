/**
 * Which files a card owns, and whether two cards want the same ones (819e7192).
 *
 * With several agents in one worktree, git stops helping. Two of them editing
 * one file is a RACE, not a merge conflict: nobody is told and the loser's edit
 * is simply gone. Separate worktrees would have made it a conflict a person has
 * to resolve; one shared tree makes it silent. A claim is the only thing left
 * standing between two agents and the same file.
 *
 * FAILING OPEN IS THE ONE OUTCOME THIS MUST NOT HAVE, and the first version had
 * it four times over - each found by review, each a pair that obviously
 * overlaps and was reported clear. They are listed on the fixes below rather
 * than summarised here, because the specific shape is the part worth
 * remembering.
 *
 * CLAIMS ARE NOT GLOBS, and that is the load-bearing decision. The obvious
 * design is `packages/ui/**` and a matcher, but the question here is not "does
 * this path match this pattern" - it is "can these two patterns ever match the
 * same path", which is different and much harder. A claim that cannot be
 * checked precisely is worse than no claim: it reports safety it has not
 * established. So the input is constrained to two shapes where overlap is
 * exact - a directory, or an exact file - and anything else is REPORTED as
 * rejected rather than quietly skipped.
 *
 * Pure on purpose. No storage, no routes, no clock: every layer above this is
 * wrong if this is wrong, and this way it can be argued with in isolation.
 */

/** A claim: `packages/ui` owns a subtree, `packages/ui/src/App.tsx` one file. */
export type Claim = string;

export interface ClaimConflict {
  /** The claim being asked for. */
  readonly wanted: Claim;
  /** The claim already held that it runs into. */
  readonly held: Claim;
  /** Which card holds it, so a refusal can name somebody. */
  readonly heldBy: string;
}

export interface ClaimCheck {
  readonly conflicts: ClaimConflict[];
  /**
   * Input this could not check, and therefore has NOT cleared.
   *
   * The first version skipped malformed claims and returned only conflicts, so
   * a caller could not tell "checked, clear" from "could not check, dropped" -
   * and a glob asking for everything came back as no conflict. Separating them
   * is what stops an unanswerable question being read as a safe answer.
   */
  readonly rejected: Claim[];
}

/**
 * Reject what cannot be reasoned about.
 *
 * Refusing is the whole point: a wildcard accepted here would be compared as a
 * literal, and a claim on a file named `**` protects nothing while looking like
 * it protects everything.
 */
export function isWellFormedClaim(claim: unknown): claim is Claim {
  if (typeof claim !== 'string') return false;
  const trimmed = claim.trim();
  if (!trimmed || trimmed !== claim) return false;
  // Repository-relative, always. An absolute path claims something outside the
  // tree every other card is sharing.
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[A-Za-z]:/.test(trimmed)) return false;
  /*
   * Split on BOTH separators. The first version split on '/' alone, so
   * `..\\..\\secrets` and `\\etc\\passwd` sailed past a docblock promising that
   * `..` escapes the repository. Defence in depth today; a hole the moment a
   * claim becomes a commit pathspec, which is the plan.
   */
  if (trimmed.split(/[/\\]/).some(seg => seg === '..' || seg === '.')) return false;
  // Glob syntax, refused rather than approximated. See the header.
  if (/[*?[\]{}]/.test(trimmed)) return false;
  return true;
}

/**
 * One spelling per path, so two habits cannot hide an overlap.
 *
 * Three fixes live here, and each was a pair that collided in reality and not
 * in this module:
 *
 *  - BACKSLASHES became slashes. `packages\ui` against
 *    `packages\ui\src\App.tsx` - the same convention, obviously overlapping -
 *    reported clear, because containment hardcoded a forward slash.
 *  - REPEATED separators collapse. `src//a.ts` against `src/a.ts` is one file
 *    written two ways, and it is reached by accident rather than malice: any
 *    `dir + '/' + name` where `dir` already ends in a separator produces it.
 *  - TRAILING separators are trimmed by a LOOP. It was
 *    `claim.replace(/\/+$/, '')` - the same quadratic pattern removed from
 *    utils.ts one commit later, reintroduced here by the same hand. Measured at
 *    3,424 ms for 100,000 separators, and reachable through the validated path
 *    because empty segments are neither `..` nor `.`.
 */
function normalise(claim: Claim): string {
  const unified = claim.replace(/\\/g, '/');
  // Split-and-filter rather than a regular expression: this is the operation
  // whose regex spelling was quadratic, and a split cannot acquire that again.
  const segments = unified.split('/').filter(Boolean);
  return segments.join('/');
}

/**
 * Does one claim cover the other, in either direction?
 *
 * Containment is decided at a SEGMENT BOUNDARY, not by string prefix, and not
 * by whether somebody remembered a trailing slash.
 *
 * The trailing slash was the first design and it was wrong in the dangerous
 * direction: requiring `packages/ui/` to mean the directory left `packages/ui`
 * - which is what people write - matching nothing at all, so a claim made in
 * good faith protected no files and reported clear.
 *
 * The boundary is also what keeps `packages/ui` away from
 * `packages/ui-legacy/App.tsx`, and `src/App.tsx` from `src/App.tsx.map`: a
 * plain `startsWith` sees a prefix in both and they are unrelated.
 */
export function claimsCollide(a: Claim, b: Claim): boolean {
  const x = normalise(a);
  const y = normalise(b);
  if (x === y) return true;
  const contains = (outer: string, inner: string): boolean =>
    outer !== '' && inner.startsWith(outer + '/');
  return contains(x, y) || contains(y, x);
}

/**
 * What a card cannot have, and what could not be checked at all.
 *
 * Returns EVERY conflict rather than the first. A lead planning a fan-out needs
 * the whole picture to re-cut the split; handing back one collision at a time
 * turns one decision into a sequence of them, each invalidating the last.
 */
export function findClaimConflicts(
  wanted: readonly Claim[],
  held: ReadonlyArray<{ readonly itemId?: string; readonly claims?: readonly Claim[] }>,
  /** The card asking. Its own held claims are not conflicts with itself. */
  askingItemId?: string,
): ClaimCheck {
  const conflicts: ClaimConflict[] = [];
  const rejected: Claim[] = [];

  for (const want of wanted) {
    if (!isWellFormedClaim(want)) { rejected.push(want); continue; }
    for (const holder of held) {
      /*
       * Only skip a holder that is genuinely THIS card. The first version
       * compared ids directly, so with no asking id every holder whose id was
       * missing matched `undefined === undefined` and had its claims silently
       * dropped.
       */
      if (askingItemId !== undefined && holder.itemId === askingItemId) continue;
      // A holder with no claims array is half-formed input, not a crash. This
      // module is asked questions about exactly that.
      for (const heldClaim of holder.claims ?? []) {
        if (!isWellFormedClaim(heldClaim)) {
          if (!rejected.includes(heldClaim)) rejected.push(heldClaim);
          continue;
        }
        if (claimsCollide(want, heldClaim)) {
          conflicts.push({ wanted: want, held: heldClaim, heldBy: holder.itemId ?? '(unnamed)' });
        }
      }
    }
  }
  return { conflicts, rejected };
}
