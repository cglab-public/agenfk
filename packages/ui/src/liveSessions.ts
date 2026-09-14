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
 */
import type { SessionRow } from './components/SessionsRail';
import { LIVE_TTL_MS } from './liveAgents';

export interface LivenessDeps {
  /** Whether the card has produced a run event inside the live window. */
  readonly isLive: (itemId: string) => boolean;
}

/**
 * Keep a row?
 *
 * Three rules, and the third is the one that must not be folded into the
 * others.
 */
export function isWorthShowing(row: SessionRow, deps: LivenessDeps): boolean {
  /*
   * A failure stays, however old.
   *
   * The rail's own comment already argued this: "a failure that ages into idle
   * is a failure nobody sees". A failed run is precisely the row that needs a
   * person, and dropping it for being old is the opposite of what the rail
   * promises. It is listed here first so that no later rule can quietly
   * swallow it.
   */
  if (row.state === 'failed') return true;

  /*
   * A terminal this app owns stays while its process does.
   *
   * Not while it is BUSY — an agent waiting at its prompt is still your
   * session, and the row is how you get back to it.
   */
  if (row.hasTerminal) return !row.exited;

  /*
   * A run recorded by the hook stays while it is live, OR while it is too
   * young to have said anything yet.
   *
   * There is no trustworthy end marker to use instead: the hook never issues
   * the closing PATCH (BUG df4b3343), so `status` reads `running` forever and
   * would keep every run this machine has ever started.
   *
   * The second half is not belt-and-braces — without it this drops a run that
   * has only just begun. Liveness here is the recency of `run:event`, and a
   * run that started a second ago has not emitted one, so filtering on
   * liveness alone means starting work from a card shows you an empty rail
   * until the agent's first tool call. Caught by two existing tests that do
   * exactly that.
   *
   * The same window the dot uses, deliberately: a run older than it with
   * nothing to show has aged out by the rail's own definition, and inventing a
   * second threshold would let the two disagree.
   */
  if (deps.isLive(row.itemId)) return true;
  const age = Date.now() - new Date(row.startedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < LIVE_TTL_MS;
}

/** The rows still worth a line, in the order they were given. */
export function liveSessions(rows: readonly SessionRow[], deps: LivenessDeps): SessionRow[] {
  return rows.filter(row => isWorthShowing(row, deps));
}
