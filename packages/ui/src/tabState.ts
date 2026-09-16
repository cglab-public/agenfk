/**
 * What a terminal tab says about the pane you are NOT looking at (CGLAB-191).
 *
 * The interface this implements is explicit about why: *"the tab strip does the
 * work a rail of thumbnails would have done badly: a state dot, the vendor
 * mark, and a short name — the failed and blocked tabs coloured so they read
 * before you look for them"*, and *"the tab for the pane you are not looking at
 * still tells you it is alive"*.
 *
 * Today a tab carries a label and nothing else, so a session that failed behind
 * another tab is invisible until you click it. With five sessions and one
 * visible, that is four agents you have no information about.
 *
 * IT DOES NOT COMPUTE THE STATE. `SessionRow.state` already holds it and the
 * rail already renders from it. A second opinion about whether an agent is well
 * is how the rail and the terminal came to disagree earlier in this epic, and
 * the disagreement is worse than either answer alone because nothing on screen
 * says which one to believe.
 */
import type { SessionState } from './sessionRow';

export interface TabIndicator {
  /** The state to paint, or null when there is nothing worth saying. */
  readonly state: SessionState | null;
  /** The accessible name suffix, e.g. "failed". Null when state is null. */
  readonly label: string | null;
  /** True when this tab should read before the eye goes looking for it. */
  readonly urgent: boolean;
}

const QUIET: TabIndicator = { state: null, label: null, urgent: false };

/**
 * Human words, not enum names.
 *
 * `idle` is the one deliberately missing: a quiet agent is the normal case and
 * a dot on every tab announcing normality is the same noise as a chip on every
 * card announcing an absence. The tab is quiet when the agent is.
 */
const WORDS: Partial<Record<SessionState, string>> = {
  running: 'running',
  blocked: 'blocked',
  failed: 'failed',
  // Not "maybe running" and not "lost": we cannot reach it, and saying either
  // of the others would assert something we do not know.
  unverifiable: 'unverifiable',
};

/** States that must be legible at a glance rather than found by looking. */
const URGENT: ReadonlySet<SessionState> = new Set<SessionState>(['failed', 'blocked', 'unverifiable']);

/**
 * The indicator for one tab.
 *
 * `undefined` for a session with no row is NOT an error: a tab exists from the
 * moment it is opened, and the row appears when the agent first produces
 * something. Treating the gap as a fault would paint a red dot on every tab for
 * its first second.
 */
export function tabIndicator(state: SessionState | undefined): TabIndicator {
  if (!state) return QUIET;
  const label = WORDS[state];
  if (!label) return QUIET;
  return { state, label, urgent: URGENT.has(state) };
}

/**
 * The colour class for the dot.
 *
 * Failure and blocking are the two that must read first, so they get the only
 * saturated colours in the strip. Running is deliberately quieter than both: it
 * is the good case, and making it compete would bury the two that need a
 * person.
 */
export function tabDotClass(state: SessionState): string {
  switch (state) {
    case 'failed':  return 'bg-red-500';
    case 'blocked': return 'bg-amber-500';
    // Hollow rather than filled: the dot says "we cannot see in", and a solid
    // colour would claim knowledge the state exists to deny.
    case 'unverifiable': return 'border border-amber-500 bg-transparent';
    case 'running': return 'bg-emerald-500';
    default:        return 'bg-ink-tertiary';
  }
}

/**
 * How many tabs in this strip want a person, for the strip's own summary.
 *
 * Counted over SESSIONS rather than cards: two agents can share a card, and one
 * failing says nothing about the other.
 */
export function tabsNeedingAPerson(states: readonly (SessionState | undefined)[]): number {
  return states.filter(s => s !== undefined && URGENT.has(s)).length;
}
