/**
 * Deciding whether an agent going quiet is worth interrupting somebody for.
 *
 * Two decisions, kept apart because they fail differently.
 *
 * **Is this new?** The signal is a STATE, not an event. A card sits in
 * `blocked` for as long as nobody answers it, and `failed` never ages out at
 * all — so a rule written on the state rather than on the transition into it is
 * an alarm that repeats until the user turns the feature off. Worse at startup:
 * every run that failed last week is in the list, and alerting on what is
 * merely PRESENT would greet the user with a burst of banners about work they
 * finished days ago. Hence priming: the first observation records, it does not
 * announce.
 *
 * **Is the user asking to be told?** Four settings, composing in a way that is
 * easy to get subtly wrong — the master gates both channels, the timing applies
 * to the sound and not to the banner, and 'unfocused' is about where the user is
 * LOOKING rather than about what the agent is doing.
 *
 * What counts as "needs you" is NOT decided here. It is `NEEDS_A_PERSON` in
 * cardState.ts — blocked, failed, unverifiable. A fourth list would be a fourth
 * spelling of one rule, and the card dot and the sidebar count already
 * disagreed once by having two.
 */
/*
 * `SoundTimingDto` from the api module, not `SoundTiming` from core.
 *
 * Even as a type-only import, reaching for `@agenfk/core` from a file in the
 * browser bundle is the road claimState.ts documents: core is CommonJS, and the
 * two ways to import it from here either fail the build or ship a black window.
 * The api module holds the mirror, and a test pins it against core.
 */
import type { SoundTimingDto } from './api';
import { NEEDS_A_PERSON } from './cardState';
import type { SessionState } from './sessionRow';

/** The slice of AppSettings this reads. Structural, so a caller may pass more. */
export interface AttentionSettings {
  readonly attentionAlerts: boolean;
  readonly attentionSound: boolean;
  readonly soundTiming: SoundTimingDto;
  readonly osNotifications: boolean;
}

/** One agent that has stopped and wants a person. */
export interface AttentionSubject {
  readonly key: string;
  readonly agentLabel: string;
  readonly cardTitle: string;
}

/**
 * Did this row just start needing a person?
 *
 * `previous === undefined` means the row was not there a moment ago, which for
 * a session opened after the app started IS news. The priming pass below is
 * what stops that reading from firing for everything already on screen at
 * launch.
 */
export function becameBlocked(
  previous: SessionState | undefined,
  next: SessionState,
): boolean {
  if (previous === next) return false;
  return NEEDS_A_PERSON.has(next);
}

/**
 * Which rows are new arrivals at a needs-a-person state, given what was last
 * seen — and the memory to carry into the next call.
 *
 * Pure, and returning the next memory rather than mutating one, so the rule is
 * testable without a component and without a clock. `primed` false means this
 * is the first look: record everything, announce nothing.
 */
/**
 * How many vanished rows to keep a memory of. See `newlyBlocked`.
 *
 * Generous enough that a real session never falls out of it, small enough that
 * an app left open for a week cannot grow the map without bound. Eviction is
 * oldest-first, which for this map means least-recently-observed.
 */
const REMEMBERED_ABSENT = 500;

export function newlyBlocked<T extends { key: string; state: SessionState }>(
  rows: readonly T[],
  seen: ReadonlyMap<string, SessionState>,
  primed: boolean,
): { alerts: T[]; seen: Map<string, SessionState> } {
  const next = new Map<string, SessionState>();
  const alerts: T[] = [];
  for (const row of rows) {
    next.set(row.key, row.state);
    if (!primed) continue;
    if (becameBlocked(seen.get(row.key), row.state)) alerts.push(row);
  }

  /*
   * ROWS THAT VANISHED KEEP THEIR LAST STATE. This used to drop them, and an
   * adversarial review found what that cost.
   *
   * `api.listRuns` swallows its errors and answers `[]`, which react-query
   * records as a SUCCESS. So one flaky request empties the run half of the
   * list, dropping every remembered state with it - and the next refetch, which
   * the `run:updated` socket event triggers routinely, brings the same blocked
   * and failed rows back as `previous === undefined` and announces all of them
   * again. Mid-session, on a machine that did nothing wrong.
   *
   * The old reasoning was that a card coming back "has genuinely changed since
   * we last knew anything about it". That is true when the session really
   * ended and false when the list merely blinked, and from here the two are
   * indistinguishable - so the safe reading is the one that does not shout.
   *
   * The cost is a row that disappears while blocked and comes back still
   * blocked, which produces no second alert. In practice a reopened terminal is
   * observed as running or idle first (a fresh session has no activity yet, so
   * its state falls through to output recency), which re-arms it - and a missed
   * repeat is a far cheaper mistake than a burst of repeats nobody asked for.
   */
  for (const [key, state] of seen) {
    if (next.has(key)) continue;
    if (next.size >= REMEMBERED_ABSENT) break;
    next.set(key, state);
  }
  return { alerts, seen: next };
}

export interface AlertPlan {
  readonly sound: boolean;
  readonly banner: boolean;
}

/**
 * What to do about it, given the settings and where the user is looking.
 *
 * `windowFocused` gates the SOUND only. The banner's own "only when the app is
 * unfocused" rule is decided in the desktop's main process, which is the only
 * side that can see whether the window is in front — a window behind another
 * application can still contain a document reporting focus. Two answers to one
 * question is how a banner ends up suppressed by whichever side was wrong.
 */
export function planAttentionAlert(
  settings: AttentionSettings,
  windowFocused: boolean,
): AlertPlan {
  if (!settings.attentionAlerts) return { sound: false, banner: false };
  return {
    sound: settings.attentionSound && (settings.soundTiming === 'always' || !windowFocused),
    banner: settings.osNotifications,
  };
}
