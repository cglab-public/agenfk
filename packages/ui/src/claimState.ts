/**
 * What a card's claims look like from the sidebar (CGLAB-190).
 *
 * The claims mechanism is invisible in the product. A card owns files, another
 * card is refused because of it, and nothing on screen says so - which is the
 * same failure the feature itself had for a week: complete, reachable, and
 * unobservable. The artifact that specifies this interface puts the word
 * `held` on a sidebar card and says why: *"the fourth card in the sidebar says
 * held - lead claims the same file"*.
 *
 * TWO STATES, and they are not the same fact:
 *
 *   owning - this card holds paths. Useful because it is otherwise unknowable
 *            which of thirty cards is the reason yours was refused.
 *   held   - this card's own claims collide with somebody else's, so it cannot
 *            be authorized to work. The route refuses a colliding declaration,
 *            so reaching this takes a card rolled BACK from a terminal step
 *            after another card took the paths it had released. That is a real
 *            deadlock, predicted by review, and today it presents as a
 *            gatekeeper refusal with no visible cause.
 *
 * Pure, and it asks `gateOnClaims` rather than reimplementing it. A second
 * opinion about overlap is worse than none: the sidebar would say `held` where
 * the server says authorized, or the reverse, and the reader has no way to know
 * which of them is lying.
 */
/*
 * THE OVERLAP CHECK IS DUPLICATED HERE, deliberately, and the story is worth
 * the paragraph because two attempts to share it both failed.
 *
 * `@agenfk/core` compiles to CommonJS. A named import fails the BUILD
 * ("gateOnClaims is not exported" - rollup cannot trace a name through
 * `export *` of a CJS module) while vitest, which aliases the package to
 * SOURCE, stays green. A namespace import made the build pass and shipped a
 * bundle that threw `ReferenceError: exports is not defined` on load: a black
 * window, with every test and the build itself reporting success.
 *
 * So the browser cannot have core until core emits ESM. The copy is the same
 * decision `bin/agenfk-gatekeeper.mjs` already made for the same reason, and
 * it carries the same obligation: a copy that DRIFTS is worse than either
 * sharing or not, so a test pins this against the real `claimsCollide` - and
 * that test CAN import core, because it runs where core resolves to source.
 */
const RELEASED = new Set(['DONE', 'TRASHED', 'ARCHIVED', 'IDEAS']);

function normalise(claim: string): string {
  return claim.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

/**
 * Mirrors `isWellFormedClaim` in packages/core/src/claims.ts.
 *
 * Without it this file FAILED OPEN, in the file whose own header says a copy
 * that drifts is worse than not sharing. A card claiming `packages/**` was
 * shown a neutral grey "owns 1 path" while the gatekeeper refused it outright:
 * core puts a malformed claim in `rejected` and turns `authorized` false, and
 * the copy had no notion of rejected at all. Found by adversarial review,
 * minutes after the copy was written to fix a different defect.
 */
export function wellFormed(claim: unknown): claim is string {
  if (typeof claim !== 'string') return false;
  const t = claim.trim();
  if (!t || t !== claim) return false;
  if (t.startsWith('/') || t.startsWith('\\') || /^[A-Za-z]:/.test(t)) return false;
  if (t.split(/[/\\]/).some(seg => seg === '..' || seg === '.')) return false;
  if (/[*?[\]{}]/.test(t)) return false;
  return true;
}

/** Mirrors `claimsCollide` in packages/core/src/claims.ts. */
export function collide(a: string, b: string): boolean {
  const x = normalise(a), y = normalise(b);
  if (x === y) return true;
  const contains = (outer: string, inner: string): boolean =>
    outer !== '' && inner.startsWith(outer + '/');
  return contains(x, y) || contains(y, x);
}

export interface ClaimCard {
  readonly id: string;
  readonly status: string;
  readonly claims?: readonly string[];
  /** Tree resolution (aaa01834): own worktree, else an ancestor's, else the project root. */
  readonly parentId?: string | null;
  readonly worktreePath?: string | null;
  readonly projectId?: string;
}

/**
 * Mirrors `claimTreeOf` and `sameClaimTree` in packages/core/src/claimGate.ts
 * (aaa01834): claims are per worktree, and an unknown tree collides with every
 * tree. Pinned against core by the drift test, like `collide`.
 */
export function treeOf(card: ClaimCard, byId: ReadonlyMap<string, ClaimCard>, rootOf?: (projectId?: string) => string | null | undefined): string | null {
  const seen = new Set<string>();
  let cur: ClaimCard | undefined = card;
  for (let depth = 0; cur && depth < 32; depth++) {
    const wt = typeof cur.worktreePath === 'string' ? cur.worktreePath.trim() : '';
    if (wt) return wt;
    const parentId = cur.parentId;
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    cur = byId.get(parentId);
  }
  const root = rootOf?.(card.projectId);
  return typeof root === 'string' && root.trim() ? root.trim() : null;
}

export function sameTree(a: string | null, b: string | null): boolean {
  const norm = (t: string | null) => (t ?? '').trim().replace(/[\\/]+$/, '');
  const x = norm(a), y = norm(b);
  return !x || !y || x === y;
}

export interface CardClaimState {
  /** Paths this card owns. Empty when it has declared none. */
  readonly owns: readonly string[];
  /** Cards whose claims this one runs into. Empty when it is free to work. */
  readonly heldBy: readonly string[];
  /**
   * Claims that cannot be checked, and are therefore NOT cleared.
   *
   * Separate from a conflict because they are a different fact: the card wrote
   * something this cannot reason about, holds nothing, and the gatekeeper will
   * refuse it. Reporting that as a clean `owns` is the failure this whole
   * mechanism exists to avoid, one layer up.
   */
  readonly rejected: readonly string[];
}

const EMPTY: CardClaimState = { owns: [], heldBy: [], rejected: [] };

/**
 * The claim state of one card, given every card in the project.
 *
 * `all` rather than "the active ones": a PAUSED card still holds its files, and
 * filtering by activity here would quietly drop the holders that matter most.
 * claimGate decides release by terminal status, and this defers to it.
 */
export function claimStateOf(
  cardId: string,
  all: readonly ClaimCard[],
  /** The project's root, for cards with no worktree. Unknown stays strict. */
  rootOf?: (projectId?: string) => string | null | undefined,
): CardClaimState {
  const card = all.find(c => c.id === cardId);
  const owns = card?.claims ?? [];
  if (!owns.length || !card) return EMPTY;

  // Only cards in this card's tree can hold its files (aaa01834).
  const byId = new Map(all.map(c => [c.id, c]));
  const mine = treeOf(card, byId, rootOf);
  const here = all.filter(c => c.id === cardId || sameTree(mine, treeOf(c, byId, rootOf)));

  /*
   * De-duplicated: one card holding a directory produces a conflict per file
   * beneath it, and a row reading "held by a, a, a" is noise where "held by a"
   * is the fact.
   */
  /*
   * Anything unreadable - this card's or a holder's - and the answer is not
   * "clear". A malformed claim held by SOMEBODY ELSE is the worse half: it
   * protects nothing, the card that wrote it is never told, and treating it as
   * absent authorizes an overwrite.
   */
  const rejected = [...new Set([
    ...owns.filter(c => !wellFormed(c)),
    ...here.filter(c => !RELEASED.has(c.status.toUpperCase()))
         .flatMap(c => (c.claims ?? []).filter(x => !wellFormed(x))),
  ])];

  const heldBy = [...new Set(
    here
      .filter(c => c.id !== cardId && !RELEASED.has(c.status.toUpperCase()))
      .filter(c => (c.claims ?? []).some(theirs => owns.some(mine => collide(mine, theirs))))
      .map(c => c.id),
  )];
  return { owns: [...owns], heldBy, rejected };
}

/**
 * The short label for the sidebar row, or null when there is nothing to say.
 *
 * Null rather than an empty string, so a caller cannot render a blank chip:
 * every card in the database declares nothing, and a chip on all of them would
 * be thirty rows of noise announcing an absence.
 */
export function claimChipLabel(state: CardClaimState): string | null {
  // Unreadable outranks a conflict: a card told it "owns" paths it does not
  // hold will go looking for the bug in the wrong place when it is refused.
  if (state.rejected.length) return 'unreadable';
  if (state.heldBy.length) return 'held';
  if (!state.owns.length) return null;
  return state.owns.length === 1 ? 'owns 1 path' : `owns ${state.owns.length} paths`;
}

/**
 * The full sentence, for the row's title attribute.
 *
 * `held` alone tells somebody they are stuck without telling them by whom, and
 * the whole value of naming the holder is that it turns a stall into one
 * conversation instead of two transcripts.
 */
export function claimChipTitle(state: CardClaimState): string | null {
  if (state.rejected.length) {
    return `These claims cannot be checked and protect nothing: ${state.rejected.join(', ')}. `
      + 'A claim is a directory or an exact file. The gatekeeper refuses this card.';
  }
  if (state.heldBy.length) {
    return `Held: ${state.owns.join(', ')} — also claimed by ${state.heldBy.map(id => id.slice(0, 8)).join(', ')}`;
  }
  if (!state.owns.length) return null;
  return `Owns ${state.owns.join(', ')}`;
}
