/**
 * What a running agent looks like, as data.
 *
 * These types and the producible-states set were declared inside SessionsRail,
 * the flat list that used to sit at the bottom of the sidebar. That component
 * is gone - processes are drawn under the card they belong to (1a1b8df6) - but
 * its vocabulary is not: it is what the projects tree, the card state rule and
 * the process row all speak.
 *
 * Kept in a module of its own rather than folded into sessionPresentation,
 * which is about how a state is DRAWN. This is about what a state IS, and
 * sessionPresentation imports from here.
 */

/**
 * What an agent is doing, or what we can honestly say about it (CGLAB-195).
 *
 * `unverifiable` is the state that was missing, and its absence had a cost: an
 * agent we cannot REACH fell into `idle`, which is the wrong reading and the
 * one that leads somebody to relaunch work that is still running.
 *
 * The rule the three words carry, and it is not negotiable: LOSS OF CONTACT IS
 * NOT EVIDENCE OF EXIT. Report `unverifiable`, never `idle` and never `failed`.
 * Do not introduce synonyms, and never collapse `unverifiable` into either
 * neighbour - the whole value of the distinction is that it survives every
 * layer down to the screen. Absence never authorises stop, abandon, retry or
 * release; it authorises waiting, or looking.
 */
export type SessionState = 'running' | 'blocked' | 'failed' | 'unverifiable' | 'idle';

/**
 * How often a healthy run is expected to say something.
 *
 * The ONE number the silence windows below are derived from. Both used to be
 * written as a literal ten minutes with the same derivation copy-pasted into
 * each docblock, which reads as agreement but is really two independent
 * numbers that happen to match - and the next person to tune one would have no
 * way to see that the other was supposed to move with it.
 *
 * Deriving them does not merge them: they answer different questions and may
 * legitimately diverge. It just names what they have in common.
 */
export const HEARTBEAT_CADENCE_MS = 5 * 60 * 1000;

/**
 * How long silence is normal before it becomes loss of contact (CGLAB-195).
 *
 * One missed heartbeat, which is the earliest a run can honestly look
 * unreachable. Derived rather than chosen: a number picked by taste does not
 * survive its first argument.
 *
 * Without the grace at all, a run that had just started - recorded running, no
 * output yet - read as lost, which turns the state into a permanent alarm and
 * teaches people to ignore it. That is worse than not having the state.
 */
export const CONTACT_GRACE_MS = 2 * HEARTBEAT_CADENCE_MS;

/**
 * What we can honestly say about a recorded run.
 *
 * The rule, stated once and applied here: LOSS OF CONTACT IS NOT EVIDENCE OF
 * EXIT. A run the server still records as running, silent past the grace
 * window, is `unverifiable` - not `idle`, because idle asserts that it ended
 * and we have no evidence of that.
 */
export function runState(
  run: { readonly status?: string; readonly startedAt?: string },
  isLive: boolean,
  now: number = Date.now(),
): SessionState {
  // A failure stays failed however long ago it was: one that ages into idle
  // is one nobody sees.
  if (run.status === 'failed') return 'failed';
  if (isLive) return 'running';
  if (run.status !== 'running') return 'idle';
  const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
  // An unparseable or missing timestamp is not evidence either: without it we
  // cannot say the silence is long, so the generous reading is the honest one.
  if (!Number.isFinite(started)) return 'idle';
  /*
   * INSIDE the window the old answer stands. Silence that is minutes old is
   * ordinary - a run that has just started has produced nothing yet - and
   * calling it running there would assert it IS working, which is the same
   * presumption in the other direction. The new state is EARNED by the
   * silence lasting, not granted on the first quiet second.
   */
  return now - started > CONTACT_GRACE_MS ? 'unverifiable' : 'idle';
}

/**
 * The states something upstream can actually produce.
 *
 * This docblock had drifted away from the constant it describes and was sitting
 * above CONTACT_GRACE_MS, documenting a number it has nothing to do with. Left
 * there it is the exact failure it warns about: text that reads as
 * documentation while describing something else.
 *
 * A 'waiting' state used to be in the set, sorted to the top, and its docblock
 * called it load-bearing. Nothing could ever build one: the shell emitted only
 * running or idle, and the rail's own tests handed the state directly to the
 * component - so they passed while the app could not reach it.
 *
 * That day arrived and it is called 'blocked' (CGLAB-193): the app reads a
 * permission prompt off the rendered screen for the agents that draw one. It is
 * still NOT guessed from silence.
 *
 * 'unverifiable' earns its place the same way (CGLAB-195): `runState` below is
 * its producer. It was added to this set once before the producer existed, and
 * the test that guards this set is what caught it.
 */
export const PRODUCIBLE_STATES: ReadonlySet<SessionState> = new Set(['running', 'blocked', 'failed', 'unverifiable', 'idle']);

export interface SessionRow {
  readonly runId: string;
  readonly itemId: string;
  /**
   * The card's project.
   *
   * Carried because revealing a card on the board has to bring its project
   * along — the board can only find a card belonging to the project it is
   * showing, so without this the reveal lands on the right tab and the wrong
   * list.
   */
  readonly projectId?: string;
  readonly title: string;
  readonly agentId: string;
  readonly agentLabel: string;
  readonly state: SessionState;
  /**
   * When we last heard anything from this card, as an ISO string.
   *
   * Absent when nothing has ever been heard, which is NOT silence and must not
   * be read as it - stallWarning treats a missing timestamp as "no evidence",
   * which is the only honest answer.
   *
   * This slot used to hold `lastAction`, a string documented as rendering
   * "Bash - npx vitest run". Nothing in the app ever set it: the two places
   * that build SessionRows both omitted it, so the span was dead and its only
   * test passed the value in as a prop the real component never receives.
   */
  readonly lastSeenAt?: string;
  readonly startedAt: string;
  /**
   * Whether this app owns a PTY for it.
   *
   * False for a run recorded by the Claude Code hook: it has a transcript but
   * no terminal here, so the caller opens the read-only Runs view rather than
   * pretending to attach to a shell that does not exist.
   */
  readonly hasTerminal: boolean;
  /**
   * Whether this terminal's process has ended.
   *
   * Only meaningful with `hasTerminal`. It decides whether the row is shown at
   * all — see liveSessions — and the distinction it draws is ALIVE versus
   * DEAD, never idle versus running: a terminal sitting at a prompt is still a
   * session you can click into.
   */
  readonly exited?: boolean;
  /**
   * The hook's own verdict on the run: `running`, `done`, `failed`.
   *
   * Only for rows WITHOUT a terminal. It is the one trustworthy end marker
   * there is — the hook PATCHes it on Stop/SessionEnd — and liveSessions uses
   * it to drop a finished run instead of guessing from how long the card has
   * been quiet. Absent on older records, which is not the same as ended.
   */
  readonly runStatus?: string;
}

/**
 * When some row's state could next change on its own, or null when none can
 * (CGLAB-195).
 *
 * THE STATE WAS COMPUTED AND THE SCREEN NEVER ASKED AGAIN. `runState` reads
 * the clock, so `idle -> unverifiable` happens only if something re-renders
 * after the grace window passes - and nothing did. The live-agent sweep is the
 * app's only clock, and it stops itself the moment the last card goes dark
 * ("an idle board must not keep waking up"), which is precisely when a silent
 * run is waiting to be called unverifiable. Ten minutes later the row still
 * read `Idle`: the one answer this whole card exists to stop the app giving.
 *
 * That is the `waiting` failure one indirection further out. There, the state
 * had no producer. Here it has a producer, the producer is wired, and the
 * render never calls it a second time - which looks identical from the outside
 * and is invisible to every test, because a test that hands `unverifiable`
 * straight to a component never needs the clock to turn.
 *
 * Returns a MOMENT rather than an interval so the caller can schedule one
 * timeout instead of polling. Waking the board on a fixed tick would trade
 * this bug for the thing the sweep's shutdown was protecting.
 */
export function nextStateChangeAt(
  runs: readonly { readonly status?: string; readonly startedAt?: string; readonly itemId: string }[],
  isLive: (itemId: string) => boolean,
  now: number = Date.now(),
): number | null {
  let soonest: number | null = null;
  for (const run of runs) {
    // Only a run the server still calls `running`, that we cannot currently
    // see, can change state by the mere passage of time. A live one is already
    // `running`; a finished one is settled.
    if (run.status !== 'running' || isLive(run.itemId)) continue;
    const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
    if (!Number.isFinite(started)) continue;
    const at = started + CONTACT_GRACE_MS;
    // Already past it: the row is unverifiable now, so there is nothing left
    // to wait for on this run.
    if (at <= now) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}
