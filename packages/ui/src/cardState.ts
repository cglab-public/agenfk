/**
 * What a card in the projects tree is allowed to say about itself (CGLAB-164).
 *
 * The shell draws two lists that could each carry a status: the Sessions rail,
 * one row per SESSION, and the Projects tree, one row per CARD. The design
 * decision behind this module is that they must not repeat each other — the
 * tree answers "is anything happening to this work", the rail answers "which
 * agent, for how long, and the button that stops the right one".
 *
 * So there are three states and none of them is the flow step. The step stays
 * TEXT on the right of the row. Encoding it as a colour here would give the
 * user two colour vocabularies to learn for one screen, and the rail would be
 * saying the same thing a few pixels lower.
 *
 * Its own module rather than a constant in AppShell.tsx: exporting a non-
 * component from a component file trips `react-refresh/only-export-components`,
 * and this is testable on its own terms anyway.
 */
import type { SessionState } from './components/SessionsRail';

/**
 * Three, and only three.
 *
 *  - `working`      an agent is live on this card right now
 *  - `needs-person` a session on it is blocked — a permission prompt, a wedged
 *                   agent; something a human has to answer
 *  - `quiet`        nothing is running
 */
export type CardState = 'working' | 'needs-person' | 'quiet';

/**
 * Said in words, because a 7px dot is a mouse-only fact.
 *
 * Rendered into the row's text rather than hung off an `aria-label`: a `title`
 * or a label on a non-focusable span never reaches assistive tech at all, and
 * the sidebar's own coverage reads the row's `textContent` to check it.
 *
 * `quiet` has NO entry, and that is the point rather than an omission. Nothing
 * is announced for a card where nothing is happening — the absence is the
 * answer, and a sidebar that says "nothing running" on every row of a
 * thirty-card list is noise wearing an accessibility badge. Typing the record
 * to exclude it means the component cannot render a label for it by accident,
 * and there is no dead string here defended by a rule nobody enforces.
 *
 * The two strings that ARE rendered are deliberately disjoint: the sidebar's
 * own test asserts a row makes no "an agent is working" claim until one really
 * is, and a shared substring would make that pass on a blocked card.
 */
export const CARD_STATE_LABEL: Record<Exclude<CardState, 'quiet'>, string> = {
  working: 'An agent is working on this now',
  'needs-person': 'Blocked — needs you',
};

/**
 * The cards with at least one blocked session on them.
 *
 * Takes `SessionState` rather than a bare `string`, which is the fix a review
 * asked for and it is worth the coupling: the producer is the sessions rail,
 * and with a loose `string` here, renaming the `'blocked'` literal over there
 * would compile cleanly and silently make the amber state unreachable forever.
 * The import is type-only, so nothing of the component survives to runtime.
 *
 * Rows are keyed by card AND agent upstream, so one card can appear more than
 * once here — one blocked agent is enough to flag it.
 *
 * `failed` is NOT folded in. A failure is a per-session fact and the rail is
 * where it is drawn; carrying it here would put a fourth state on a three-state
 * mark and re-create exactly the duplication this design exists to remove. The
 * cost is real and was weighed: a card whose agent has just crashed draws the
 * quiet ring until someone looks at the rail.
 */
export function itemsNeedingAPerson(
  rows: ReadonlyArray<{ itemId: string; state: SessionState }>,
): ReadonlySet<string> {
  const blocked = new Set<string>();
  for (const row of rows) {
    if (row.state === 'blocked') blocked.add(row.itemId);
  }
  return blocked;
}

/**
 * Which of the three a row draws.
 *
 * The ORDER of these two tests is load-bearing. Liveness is the recency of
 * terminal output, and an agent that has just printed a permission prompt has
 * by definition just produced output — so a blocked card is almost always in
 * the live set as well. Resolve it the other way round and the amber state is
 * unreachable in practice: the one row that needs a human would be painted as
 * the one row that needs nobody.
 */
export function cardState(
  itemId: string,
  live: ReadonlySet<string>,
  needsPerson: ReadonlySet<string>,
  rows: ReadonlyArray<{ itemId: string; state: SessionState }> = [],
): CardState {
  if (needsPerson.has(itemId)) return 'needs-person';

  /*
   * The ROWS decide, and liveness is only the fallback.
   *
   * `live` is the recency of terminal OUTPUT, and that made the tree
   * contradict the rail about the same card at the same moment. The rail's
   * first rule is that a dead process is a fact — a rule added because "the
   * row stayed green for the full TTL after the session died, which is what
   * was reported". The tree had no such override, so a crashed agent read as
   * actively working for ninety seconds, and so did every finished turn,
   * because finishing produces output too.
   *
   * Deriving both from the same rows makes the two lists agree by
   * construction rather than by two sets of rules kept in step by hand.
   */
  let hasRow = false;
  for (const row of rows) {
    if (row.itemId !== itemId) continue;
    hasRow = true;
    // One working agent is enough: rows are keyed by card AND agent.
    if (row.state === 'running') return 'working';
  }
  if (hasRow) return 'quiet';

  /*
   * No session of ours for this card — a run recorded by the hook has a
   * transcript and no terminal here. There is nothing to agree with, so
   * recency is all there is.
   */
  return live.has(itemId) ? 'working' : 'quiet';
}
