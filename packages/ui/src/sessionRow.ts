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

export type SessionState = 'running' | 'blocked' | 'failed' | 'idle';

/**
 * The states something upstream can actually produce.
 *
 * A 'waiting' state used to live here too, sorted to the top, and the docblock
 * called it load-bearing. Nothing could ever build one: the shell emitted only
 * running or idle, and the rail's own tests handed the state directly to the
 * component — so they passed while the app could not reach it. A docblock
 * describing behaviour nobody can trigger is a lie that reads like
 * documentation, so it is gone rather than pretended.
 *
 * That day arrived, and it is called 'blocked' (CGLAB-193). The app can now
 * read a permission prompt off the rendered screen for the agents that draw
 * one, so the state has a producer and is back. It is still NOT guessed from
 * silence — an agent nobody can read stays unknown upstream and lands here as
 * idle, which is the old wrong answer rather than a new one.
 */
export const PRODUCIBLE_STATES: ReadonlySet<SessionState> = new Set(['running', 'blocked', 'failed', 'idle']);

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
  /** The last run event, rendered as "Bash · npx vitest run". */
  readonly lastAction?: string;
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
