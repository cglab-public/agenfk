/**
 * Which sessions the rail should still be showing (CGLAB-194).
 *
 * The rail listed everything it had ever heard of: terminals whose process had
 * exited, and AgentRuns recorded by the hook during previous launches — the
 * rows that showed up as a bare `323cd4ad`, because a run with no card title
 * falls back to the first eight characters of its item id.
 *
 * The rail's own docblock says it shows the agents you have running. A list of
 * things that finished hours ago is not that, and it buries the two or three
 * rows that are actually yours.
 *
 * THE DISTINCTION IS ALIVE VERSUS DEAD, NOT IDLE VERSUS RUNNING, and getting
 * that backwards would be worse than the original problem: a terminal sitting
 * open at a prompt is still a session — the tab exists and clicking the row
 * takes you to it. Hiding those would remove the way to reach the terminals you
 * have open, which is most of what this rail is for.
 *
 * ---
 *
 * REWRITTEN after an independent review, which found the first version resting
 * on a premise that had expired. It asserted that the hook never issues the
 * closing `PATCH /agent-runs/:id` (BUG df4b3343), so `status` reads `running`
 * forever and could not be used. `bin/agenfk-run-hook.mjs` closes the run on
 * `Stop`/`SessionEnd`, and that fix was already an ancestor of the commit
 * repeating the claim. So a real end marker existed and this file ignored it,
 * filtering instead on the recency of run events plus a short birth window.
 *
 * That was not merely redundant, it was wrong in the direction that hurts:
 * `run:event` is emitted for SEVEN tool names only (see claude-events.ts), so a
 * four-minute `npm test` emits nothing at all for four minutes — and the row
 * vanished mid-work and reappeared afterwards.
 */
import type { SessionRow } from './components/SessionsRail';

export interface LivenessDeps {
  /** Whether the card has produced a run event inside the live window. */
  readonly isLive: (itemId: string) => boolean;
  /**
   * When THIS run of the app began, as epoch ms.
   *
   * The only thing that separates a run still working in silence from one
   * orphaned by a previous launch, since both read `running` forever.
   */
  readonly appStartedAt: number;
}

/**
 * Keep a row?
 *
 * Ordered, and the order carries meaning: each rule is a stronger statement
 * than the ones below it.
 */
export function isWorthShowing(row: SessionRow, deps: LivenessDeps): boolean {
  /*
   * A failure stays, however old.
   *
   * The rail's own comment already argued this: "a failure that ages into idle
   * is a failure nobody sees". A failed run is precisely the row that needs a
   * person, and dropping it for being old is the opposite of what the rail
   * promises. It is listed here first so that no later rule can quietly
   * swallow it — including the end marker below, since a failure arrives WITH
   * its end marker.
   */
  if (row.state === 'failed') return true;

  /*
   * A terminal this app owns stays while its process does.
   *
   * Not while it is BUSY — an agent waiting at its prompt is still your
   * session, and the row is how you get back to it. And not according to
   * `runStatus`: that is the hook's record of a conversation, while this is a
   * shell the user has open on screen. A closed record must not close a tab.
   */
  if (row.hasTerminal) return !row.exited;

  /*
   * From here down the row is a run recorded by the hook, with no terminal
   * here. It ends when the hook says it ended.
   *
   * Checked before liveness on purpose: a run can be closed while its last
   * event is still inside the live window, and "the session finished" is a
   * stronger statement than "it was noisy recently". Absent is not ended —
   * older records carry no status and fall through.
   */
  if (row.runStatus !== undefined && row.runStatus !== 'running') return false;

  /* Still open, and something is happening on that card right now. */
  if (deps.isLive(row.itemId)) return true;

  /*
   * Still open, silent, and started by THIS run of the app: keep it.
   *
   * Launch time rather than an age window, because the two failures are not
   * symmetric. Silence proves nothing — the seven recorded tools mean a long
   * build, a reading pass, or a wait on the user all look identical to a run
   * that died with the app. Any age threshold therefore has to choose between
   * hiding live work and keeping orphans, and it gets the choice wrong in both
   * directions at once: 90s is far too short for `npm test`, and far too long
   * to be a meaningful test of whether a run survived a crash.
   *
   * Launch time answers the actual question. A run this session started is
   * ours and stays until the hook closes it, however quiet it goes. A run that
   * predates the launch and has said nothing since is the `323cd4ad` case —
   * the app was killed before the hook could close it, so `status` says
   * `running` and always will.
   *
   * Residual, and accepted: an agent that survived an app restart (tmux) and
   * then goes quiet for the whole of the next launch is dropped. It comes back
   * the moment it emits anything, and the hook still closes it correctly.
   *
   * The comparison is deliberately one-sided. A timestamp in the FUTURE is the
   * youngest row there is, so it must be kept; an earlier version demanded a
   * non-negative age and dropped exactly that row. An unreadable timestamp is
   * not young and is not kept — NaN fails this comparison, which is the answer
   * we want rather than an accident we tolerate.
   */
  return new Date(row.startedAt).getTime() >= deps.appStartedAt;
}

/** The rows still worth a line, in the order they were given. */
export function liveSessions(rows: readonly SessionRow[], deps: LivenessDeps): SessionRow[] {
  return rows.filter(row => isWorthShowing(row, deps));
}
