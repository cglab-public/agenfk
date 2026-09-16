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
 * Namespace import, and it is not a style choice. `@agenfk/core` compiles to
 * CommonJS and re-exports through `export *`, which rollup cannot trace to a
 * named binding - `"gateOnClaims" is not exported` at build time while vitest,
 * which aliases the package to SOURCE, stays green. Tests passing and the
 * bundle failing is the exact divergence worth naming here.
 */
import * as core from '@agenfk/core';
import type { ClaimHolder } from '@agenfk/core';

const { gateOnClaims } = core;

export interface ClaimCard {
  readonly id: string;
  readonly status: string;
  readonly claims?: readonly string[];
}

export interface CardClaimState {
  /** Paths this card owns. Empty when it has declared none. */
  readonly owns: readonly string[];
  /** Cards whose claims this one runs into. Empty when it is free to work. */
  readonly heldBy: readonly string[];
}

const EMPTY: CardClaimState = { owns: [], heldBy: [] };

/**
 * The claim state of one card, given every card in the project.
 *
 * `all` rather than "the active ones": a PAUSED card still holds its files, and
 * filtering by activity here would quietly drop the holders that matter most.
 * claimGate decides release by terminal status, and this defers to it.
 */
export function claimStateOf(cardId: string, all: readonly ClaimCard[]): CardClaimState {
  const card = all.find(c => c.id === cardId);
  const owns = card?.claims ?? [];
  if (!owns.length) return EMPTY;

  const holders: ClaimHolder[] = all.map(c => ({ id: c.id, status: c.status, claims: c.claims }));
  const gate = gateOnClaims({ id: cardId, claims: owns }, holders);
  /*
   * De-duplicated: one card holding a directory produces a conflict per file
   * beneath it, and a row reading "held by a, a, a" is noise where "held by a"
   * is the fact.
   */
  const heldBy = [...new Set(gate.conflicts.map(c => c.heldBy))];
  return { owns: [...owns], heldBy };
}

/**
 * The short label for the sidebar row, or null when there is nothing to say.
 *
 * Null rather than an empty string, so a caller cannot render a blank chip:
 * every card in the database declares nothing, and a chip on all of them would
 * be thirty rows of noise announcing an absence.
 */
export function claimChipLabel(state: CardClaimState): string | null {
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
  if (state.heldBy.length) {
    return `Held: ${state.owns.join(', ')} — also claimed by ${state.heldBy.map(id => id.slice(0, 8)).join(', ')}`;
  }
  if (!state.owns.length) return null;
  return `Owns ${state.owns.join(', ')}`;
}
